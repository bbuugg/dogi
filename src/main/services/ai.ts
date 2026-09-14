import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import {
  streamText,
  tool,
  stepCountIs,
  type LanguageModel,
  type ModelMessage,
  type ToolSet
} from 'ai'
import { createOpenAI } from '@ai-sdk/openai'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createDeepSeek } from '@ai-sdk/deepseek'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { z } from 'zod'
import type {
  AiChatMessage,
  AiConfirmRequest,
  AiModelConfig,
  AiPermissionMode,
  AiStreamEvent
} from '@shared/types'
import { sessionManager } from './sessions'
import { storage } from './storage'
import { mcpManager } from './mcp'

const DEFAULT_SYSTEM_PROMPT = [
  '你是一个专业的运维助手，运行在一个运维终端工具（OpsDesk）中。',
  '你可以操作用户的终端会话：执行命令、读取输出。',
  '执行命令前先简要说明要做什么；优先使用安全、无破坏性的命令。',
  '涉及删除文件、重启服务、修改配置等危险操作时，先简要说明影响再执行。',
  '使用 run_in_terminal 执行命令后，终端原始输出即为事实依据；失败时结合输出排查原因再尝试。',
  '注意根据会话标题判断操作系统（PowerShell 与 bash 语法不同）。',
  '部分命令会启动交互式 / 前台程序（如 htop、top、vim、nano、less、man、watch、python、node 等），它们占据终端且不返回 shell 提示符。执行这类命令后，不要继续向该会话输入新命令，应先用 send_keys 工具发送退出指令（多数程序用 "q"，卡死用 "C-c"，个别用 "exit" / "C-d"），并用 read_terminal_output 确认已回到 shell 提示符后再继续。'
].join('\n')

const TOOL_OUTPUT_LIMIT = 8000
const MAX_STEPS = 15
/** 确认模式下等待用户响应的最长时间，超时按「取消」处理 */
const CONFIRM_TIMEOUT_MS = 10 * 60 * 1000

/** 由 ipc 层注入：把确认请求广播给渲染进程 */
type ConfirmRequester = (req: AiConfirmRequest) => void

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

/** 根据配置创建对应 provider 的模型实例 */
function resolveModel(config: AiModelConfig): LanguageModel {
  switch (config.kind) {
    case 'anthropic': {
      const provider = createAnthropic({ apiKey: config.apiKey, baseURL: config.baseURL })
      return provider(config.model)
    }
    case 'deepseek': {
      const provider = createDeepSeek({ apiKey: config.apiKey, baseURL: config.baseURL })
      return provider(config.model)
    }
    case 'google': {
      const provider = createGoogleGenerativeAI({ apiKey: config.apiKey, baseURL: config.baseURL })
      return provider(config.model)
    }
    case 'openai':
    case 'openai-compatible':
    default: {
      // 默认：openai 官方走 Responses API，兼容网关走 Chat Completions
      const style =
        config.apiStyle ??
        (config.kind === 'openai-compatible' ? 'chat-completions' : 'responses')
      const provider = createOpenAI({
        apiKey: config.apiKey ?? 'EMPTY',
        baseURL: config.baseURL
      })
      return style === 'responses'
        ? provider.responses(config.model)
        : provider.chat(config.model)
    }
  }
}

/** 渲染进程的对话历史 -> 模型消息（文本保留，工具过程转为摘要行） */
function toModelMessages(history: AiChatMessage[]): ModelMessage[] {
  const messages: ModelMessage[] = []
  for (const msg of history) {
    const lines: string[] = []
    for (const part of msg.parts) {
      if (part.type === 'text' && part.text.trim()) {
        lines.push(part.text)
      } else if (part.type === 'tool-call') {
        lines.push(`[调用工具 ${part.toolName}]`)
      } else if (part.type === 'tool-result') {
        const output =
          typeof part.output === 'string'
            ? part.output.slice(0, 400)
            : JSON.stringify(part.output)?.slice(0, 400)
        lines.push(`[工具 ${part.toolName} 返回] ${output}`)
      }
    }
    const content = lines.join('\n').trim()
    if (content) messages.push({ role: msg.role, content })
  }
  return messages
}

/** 当前的命令执行权限模式：每次执行时实时读取，支持对话中途切换 */
function currentPermissionMode(): AiPermissionMode {
  return storage.getAiSettings().permissionMode === 'confirm' ? 'confirm' : 'full'
}

/**
 * 命中即视为「交互式/前台程序」的命令（不会返回 shell 提示符）。
 * 例如 htop、top、vim、less、man、watch、python、node 等：
 * 这类命令会占据终端，若把后续命令直接写进去会被程序吞掉导致异常。
 */
const INTERACTIVE_PROGRAM_RE =
  /(?:^|[\s;|&])(htop|top|btop|atop|iotop|iftop|nethogs|vim?|nvim|nano|emacs|less|more|most|man|tmux|screen|watch|tail\s+-f|python3?|ipython|node|irb|pry|byebug|bc|ftp|sftp|telnet|nc\b|mysql|psql|sqlite3|redis-cli|mongosh|mongo|lua|ghci|ranger|nnn|mc\b|lf\b|lynx|w3m|elinks|links|ncdu|glances|vifm|newsboat|mutt|alpine)\b/i

/** 粗略判断终端是否停在 shell 提示符（用于识别前台程序是否已退出） */
const SHELL_PROMPT_RE = /(PS\s+[A-Za-z]:[\\/].*>)|([$#%]\s*$)/
/** ansi 转义 + 回车清理，取最后一非空行 */
function tailCleaned(output: string): string {
  const cleaned = output.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\r/g, '')
  const lines = cleaned.split('\n').filter((l) => l.trim().length > 0)
  return lines.length ? lines[lines.length - 1].trimEnd() : ''
}
function hasShellPrompt(output: string): boolean {
  return SHELL_PROMPT_RE.test(tailCleaned(output))
}

/** 把 send_keys 的语义化按键翻译成终端控制字节 */
function translateKeys(keys: string): string {
  return keys
    .replace(/C-([a-zA-Z])/g, (_m, c: string) =>
      String.fromCharCode(c.toUpperCase().charCodeAt(0) & 0x1f)
    )
    .replace(/Escape/gi, '\x1b')
    .replace(/Enter|Return/gi, '\r')
    .replace(/\r?\n/g, '\r')
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(-max)}\n…（输出已截断）` : text
}

/** 终端操作工具：AI 通过这些工具查看与驱动真实终端 */
function buildTerminalTools(requestId: string): ToolSet {
  const listSessions = tool({
    description: '列出当前打开的所有终端会话（本地终端与 SSH）',
    inputSchema: z.object({}),
    execute: async () => {
      const sessions = sessionManager.list()
      const activeId = sessionManager.getActiveId()
      return {
        activeSessionId: activeId,
        sessions: sessions.map((s) => ({
          sessionId: s.id,
          type: s.type,
          title: s.title,
          exited: s.exited
        }))
      }
    }
  })

  const runInTerminal = tool({
    description:
      '在指定终端会话中执行命令（等同于用户在键盘输入并回车），等待片刻后返回终端最近输出。未指定会话时使用最近活跃的会话。',
    inputSchema: z.object({
      command: z.string().describe('要执行的命令，无需附加换行符'),
      sessionId: z.string().optional().describe('目标会话 ID，缺省为最近活跃会话'),
      waitMs: z.number().optional().describe('执行后等待毫秒数，默认 3000')
    }),
    execute: async ({ command, sessionId, waitMs }, { toolCallId }) => {
      const id = sessionId ?? sessionManager.getActiveId()
      if (!id) throw new Error('当前没有打开的终端会话')
      const session = sessionManager.get(id)
      if (!session) throw new Error(`会话不存在: ${id}`)

      // 确认模式：先请示用户，被拒绝则不执行
      if (currentPermissionMode() === 'confirm') {
        const approved = await aiService.requestConfirm({
          requestId,
          toolCallId,
          toolName: 'run_in_terminal',
          command,
          sessionId: id,
          sessionTitle: session.info.title
        })
        if (!approved) {
          return '用户取消了本次命令执行（命令未运行）。请询问用户接下来希望怎么做，不要擅自重试。'
        }
      }

      sessionManager.write(id, command.endsWith('\n') ? command : `${command}\r`)
      const waited = Math.min(waitMs ?? 3000, 15000)
      await new Promise((resolve) => setTimeout(resolve, waited))
      const raw = sessionManager.recentOutput(id, TOOL_OUTPUT_LIMIT) ?? ''

      // 交互式 / 前台程序（htop、vim、less、watch、python 等）不会返回 shell 提示符，
      // 若把后续命令直接写进去会被程序吞掉导致异常。主动提示 AI 先退出。
      if (INTERACTIVE_PROGRAM_RE.test(command) && !hasShellPrompt(raw)) {
        return [
          `命令「${command.trim()}」已启动一个交互式 / 前台程序（htop、top、vim、less、watch、python 等），它当前占据终端、尚未返回 shell 提示符。`,
          '请勿继续向该会话输入新命令（会被该程序吞掉，造成异常）。如需继续，请先用 send_keys 工具发送退出指令：',
          "  · 多数程序按 'q' 即可退出；",
          "  · 卡死或无法退出时发送 Ctrl-C（send_keys 传入 'C-c'）；",
          "  · 个别程序用 'exit' / 'quit' / Ctrl-D（'C-d'）。",
          "发送退出键后，可用 read_terminal_output 确认已回到 shell 提示符，再执行后续命令。",
          '',
          '（附：当前终端最近输出，供判断程序是否已退出）',
          truncate(raw, 2000)
        ].join('\n')
      }
      return raw
    }
  })

  const sendKeys = tool({
    description:
      '向终端发送按键或控制序列（不会自动回车）。主要用于退出交互式 / 前台程序：如发送 "q" 退出 htop/less/man，发送 "C-c" 发送 Ctrl-C，发送 "C-d" 发送 Ctrl-D，发送 "Escape" 退出某些程序。普通命令执行前一般不需要此工具。',
    inputSchema: z.object({
      keys: z
        .string()
        .describe(
          "要发送的按键序列。普通字符直接写，如 'q'、'exit'；控制键写法 'C-c'、'C-d'、'C-z'、'Escape'；换行 / 回车用 'Enter' 或 '\\n'。"
        ),
      sessionId: z.string().optional().describe('目标会话 ID，缺省为最近活跃会话')
    }),
    execute: async ({ keys, sessionId }) => {
      const id = sessionId ?? sessionManager.getActiveId()
      if (!id) throw new Error('当前没有打开的终端会话')
      if (!sessionManager.get(id)) throw new Error(`会话不存在: ${id}`)
      sessionManager.write(id, translateKeys(keys))
      await new Promise((resolve) => setTimeout(resolve, 300))
      return sessionManager.recentOutput(id, 2000) ?? ''
    }
  })

  const readOutput = tool({
    description: '读取指定终端会话的最近输出（不执行任何命令）',
    inputSchema: z.object({
      sessionId: z.string().optional().describe('目标会话 ID，缺省为最近活跃会话'),
      maxChars: z.number().optional().describe('最多返回字符数，默认 4000')
    }),
    execute: async ({ sessionId, maxChars }) => {
      const id = sessionId ?? sessionManager.getActiveId()
      if (!id) throw new Error('当前没有打开的终端会话')
      return sessionManager.recentOutput(id, maxChars ?? 4000) ?? ''
    }
  })

  return {
    list_terminal_sessions: listSessions,
    run_in_terminal: runInTerminal,
    read_terminal_output: readOutput,
    send_keys: sendKeys
  }
}

/**
 * AI 服务：多 provider 模型调用、MCP 工具合并、终端工具、流式事件转发
 */
interface PendingConfirm {
  requestId: string
  resolve: (approved: boolean) => void
  timer: ReturnType<typeof setTimeout>
}

class AiService extends EventEmitter {
  private abortControllers = new Map<string, AbortController>()
  private pendingConfirms = new Map<string, PendingConfirm>()
  private confirmRequester: ConfirmRequester | null = null

  /** ipc 层注入确认请求的广播函数 */
  setConfirmRequester(fn: ConfirmRequester | null): void {
    this.confirmRequester = fn
  }

  /** 等待用户确认；无 UI 接入时放行，避免流程卡死 */
  requestConfirm(req: Omit<AiConfirmRequest, 'id'>): Promise<boolean> {
    const requester = this.confirmRequester
    if (!requester) return Promise.resolve(true)
    const id = randomUUID()
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingConfirms.delete(id)
        resolve(false)
      }, CONFIRM_TIMEOUT_MS)
      this.pendingConfirms.set(id, { requestId: req.requestId, resolve, timer })
      requester({ ...req, id })
    })
  }

  /** 渲染进程回复确认结果 */
  resolveConfirm(id: string, approved: boolean): void {
    const pending = this.pendingConfirms.get(id)
    if (!pending) return
    clearTimeout(pending.timer)
    this.pendingConfirms.delete(id)
    pending.resolve(approved)
  }

  /** 结束挂起的确认（中止对话 / 超时兜底），按「取消」处理 */
  private clearPendingConfirms(requestId?: string): void {
    for (const [id, pending] of this.pendingConfirms) {
      if (requestId && pending.requestId !== requestId) continue
      clearTimeout(pending.timer)
      this.pendingConfirms.delete(id)
      pending.resolve(false)
    }
  }

  async chat(history: AiChatMessage[]): Promise<{ requestId: string }> {
    const requestId = randomUUID()
    const settings = storage.getAiSettings()
    const config = settings.activeConfigId
      ? storage.getAiConfig(settings.activeConfigId)
      : undefined

    if (!config) {
      // 延迟到 invoke 返回 requestId 之后再发事件，避免渲染端因 activeRequestId 未设置而丢弃
      setTimeout(() => {
        this.emitEvent(requestId, {
          type: 'error',
          message: '尚未配置 AI 模型，请先在设置中添加模型配置'
        })
        this.emitEvent(requestId, { type: 'finish', finishReason: 'error' })
      }, 0)
      return { requestId }
    }

    const controller = new AbortController()
    this.abortControllers.set(requestId, controller)

    const mcp = await mcpManager.buildToolset()
    const tools: ToolSet = { ...buildTerminalTools(requestId), ...mcp.tools }

    const model = resolveModel(config)
    const historyLimit = config.contextMessages ?? 20
    const modelMessages = toModelMessages(history).slice(-historyLimit)

    const mode = settings.permissionMode === 'confirm' ? 'confirm' : 'full'
    const modeHint =
      mode === 'confirm'
        ? '\n当前处于「确认模式」：执行任何终端命令都会先请求用户确认，用户可能拒绝。被拒绝时不要反复重试同一条命令，先询问用户的意见。'
        : ''

    const systemPrompt = [
      settings.systemPrompt?.trim() || DEFAULT_SYSTEM_PROMPT,
      modeHint,
      mcp.errors.length ? `\n注意，以下 MCP 服务当前不可用：\n${mcp.errors.join('\n')}` : ''
    ].join('\n')

    const result = streamText({
      model,
      system: systemPrompt,
      messages: modelMessages,
      tools,
      stopWhen: stepCountIs(MAX_STEPS),
      abortSignal: controller.signal,
      ...(config.temperature !== undefined ? { temperature: config.temperature } : {}),
      ...(config.maxTokens !== undefined ? { maxOutputTokens: config.maxTokens } : {})
    })

    void this.consumeStream(requestId, result)
    return { requestId }
  }

  private async consumeStream(
    requestId: string,
    result: Awaited<ReturnType<typeof streamText>>
  ): Promise<void> {
    try {
      for await (const part of result.fullStream) {
        const event = this.adaptPart(part)
        if (event) this.emitEvent(requestId, event)
      }
      this.emitEvent(requestId, { type: 'finish', finishReason: 'done' })
    } catch (err) {
      this.emitEvent(requestId, { type: 'error', message: describeError(err) })
      this.emitEvent(requestId, { type: 'finish', finishReason: 'error' })
    } finally {
      this.clearPendingConfirms(requestId)
      this.abortControllers.delete(requestId)
    }
  }

  /** 将 AI SDK 流事件转换为渲染进程事件（兼容字段名差异） */
  private adaptPart(part: { type: string } & Record<string, unknown>): AiStreamEvent | null {
    switch (part.type) {
      case 'text-delta':
        return { type: 'text-delta', delta: String(part.text ?? '') }
      case 'tool-call':
        return {
          type: 'tool-call',
          toolCallId: String(part.toolCallId),
          toolName: String(part.toolName),
          input: part.input ?? part.args ?? null
        }
      case 'tool-result':
        return {
          type: 'tool-result',
          toolCallId: String(part.toolCallId),
          toolName: String(part.toolName),
          output: part.output ?? part.result ?? null
        }
      case 'tool-error':
        return {
          type: 'tool-result',
          toolCallId: String(part.toolCallId),
          toolName: String(part.toolName),
          output: `工具执行失败: ${describeError(part.error)}`,
          isError: true
        }
      case 'error':
        return { type: 'error', message: describeError(part.error) }
      case 'abort':
        return { type: 'finish', finishReason: 'aborted' }
      default:
        return null
    }
  }

  private emitEvent(requestId: string, event: AiStreamEvent): void {
    this.emit('chat-event', requestId, event)
  }

  abort(requestId: string): void {
    // 先释放可能正在等待用户确认的工具，避免执行流悬挂
    this.clearPendingConfirms(requestId)
    this.abortControllers.get(requestId)?.abort()
  }

  isReady(): boolean {
    const settings = storage.getAiSettings()
    return Boolean(settings.activeConfigId)
  }
}

export const aiService = new AiService()
