import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { streamText, tool, stepCountIs, type ToolSet } from 'ai'
import { z } from 'zod'
import type {
  AiChatRequest,
  AiConfirmRequest,
  AiPermissionMode,
  AiStreamEvent
} from '@shared/types'
import { sessionManager } from '../terminal/sessions'
import { storage } from '../storage'
import { mcpManager } from './mcp'
import { askFollowupBroker, buildAskFollowupTool } from './ask-followup'
import { ASK_FOLLOWUP_HINT } from '@shared/ask-followup'
import { resolveModel } from './resolve-model'
import { toModelMessages } from './agent-core'

// 兼容旧引用路径（agent.ts 从 './ai' 取）
export { resolveModel }

const DEFAULT_SYSTEM_PROMPT = [
  '你是一个专业的运维助手，运行在一个运维终端工具（Dogi）中。',
  '你可以操作用户的终端会话：执行命令、读取输出。',
  '执行命令前先简要说明要做什么；优先使用安全、无破坏性的命令。',
  '涉及删除文件、重启服务、修改配置等危险操作时，先简要说明影响再执行。',
  '使用 run_in_terminal 执行命令后，终端原始输出即为事实依据；失败时结合输出排查原因再尝试。',
  '需要工具时直接调用工具，不要在正文里用「[调用工具 xxx]」「[工具 xxx 返回]」这类文字复述调用过程或结果 —— 写出来只会让用户看到一串假动作。',
  '终端命令按队列串行执行：前一条命令执行完毕并读取到输出后，下一条才会开始，不会出现并发冲突。',
  '注意根据会话标题判断操作系统（PowerShell 与 bash 语法不同）。',
  '部分命令会启动交互式 / 前台程序（如 htop、top、vim、nano、less、man、watch、python、node 等），它们占据终端且不返回 shell 提示符。执行这类命令后，不要继续向该会话输入新命令，应先用 send_keys 工具发送退出指令（多数程序用 "q"，卡死用 "C-c"，个别用 "exit" / "C-d"），并用 read_terminal_output 确认已回到 shell 提示符后再继续。'
].join('\n')

const MAX_STEPS = 15
/** 确认模式下等待用户响应的最长时间，超时按「取消」处理 */
const CONFIRM_TIMEOUT_MS = 10 * 60 * 1000

/** 由 ipc 层注入：把确认请求与其最终结果（用户回复 / 超时 / 中止）广播给渲染进程 */
export interface ConfirmSink {
  /** 弹出一张确认卡 */
  request(req: AiConfirmRequest): void
  /** 确认已有结论（渲染端据此移除卡片） */
  resolved(id: string): void
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

/** 当前的命令执行权限模式：每次执行时实时读取，支持对话中途切换 */
function currentPermissionMode(): AiPermissionMode {
  return storage.getAiSettings().permissionMode === 'confirm' ? 'confirm' : 'full'
}

/**
 * 完整清除终端输出中的 ANSI 转义序列，使 AI 拿到的是纯文本。
 *
 * 覆盖以下序列类型：
 * - OSC（Operating System Command）：\x1b]... BEL(\x07) 或 ST(\x1b\\)，
 *   如设置窗口标题 \x1b]0;root@host:~\x07
 * - CSI（Control Sequence Introducer）：\x1b[...字母，
 *   如颜色 \x1b[32m、光标移动 \x1b[H、清行 \x1b[K、bracketed paste \x1b[?2004h
 * - DCS / SOS / PM / APC：\x1bP...\x1b\\ 等（同 OSC 用 ST 结尾）
 * - 单字符转义：\x1b= / \x1b>（键盘模式）、\x1b7 / \x1b8（光标保存/恢复）等
 * - 其他 C1 控制字符（\x80-\x9f 范围内除 \x1b 外的偶尔出现的控制字节）
 */
function stripAnsi(input: string): string {
  return input
    // OSC / DCS / SOS / PM / APC：\x1b 后跟 ] P _ ^ X，以 BEL(\x07) 或 ST(\x1b\\) 结尾
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b[DP^X][\s\S]*?\x1b\\/g, '')
    // CSI：\x1b[ 后跟参数字节(0x30-0x3F)和中间字节(0x20-0x2F)，以终结字节(0x40-0x7E)结尾
    .replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '')
    // 单字符转义序列：\x1b 后跟一个非 [ ] P D ^ X 的可打印字符（如 \x1b= \x1b> \x1b7 \x1b8 \x1bM）
    .replace(/\x1b[^\x1b]/g, '')
    // 残留的孤立 ESC 字符
    .replace(/\x1b/g, '')
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

/** 终端操作工具：AI 通过这些工具查看与驱动真实终端。
 * targetSessionId：对话绑定的终端会话，工具缺省作用于它（不随激活终端漂移）。
 * queueExec：工具执行串行队列——模型可能在同一步并行发出多个工具调用，
 * 排队保证前一条命令执行完毕、读取到结果后，下一条才开始执行。
 * requestConfirm：确认模式下的请示入口（绑定所属助手实例）。 */
function buildTerminalTools(
  requestId: string,
  targetSessionId: string | null | undefined,
  queueExec: <T>(fn: () => Promise<T>) => Promise<T>,
  requestConfirm: (req: Omit<AiConfirmRequest, 'id'>) => Promise<boolean>
): ToolSet {
  /** 工具会话解析：显式指定 > 对话绑定 > 当前活跃 */
  const resolveTarget = (sessionId?: string) =>
    sessionId ?? targetSessionId ?? sessionManager.getActiveId()
  const listSessions = tool({
    description: '列出当前打开的所有终端会话（本地终端与 SSH）',
    inputSchema: z.object({}),
    execute: async () => {
      const sessions = sessionManager.list()
      const activeId = sessionManager.getActiveId()
      return {
        activeSessionId: activeId,
        /** 本次对话绑定的会话：工具缺省作用于它 */
        boundSessionId: targetSessionId ?? null,
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
      '在指定终端会话中执行命令（等同于用户在键盘输入并回车），等待片刻后返回本次命令的新增输出（不含历史内容）。未指定会话时使用本次对话绑定的会话。命令串行执行：前一条完成并读取结果后才开始下一条。返回的输出中如果末尾有 shell 提示符（如 $ 或 # 结尾的行），说明命令已执行完毕、终端可继续输入；如果没有 shell 提示符，说明命令可能仍在运行或启动了交互式/前台程序（如 htop、vim、less、python REPL 等），此时不要继续执行新命令，应先用 send_keys 发送退出指令。',
    inputSchema: z.object({
      command: z.string().describe('要执行的命令，无需附加换行符'),
      sessionId: z.string().optional().describe('目标会话 ID，缺省为本次对话绑定的会话'),
      waitMs: z.number().optional().describe('执行后等待毫秒数，默认 3000，长耗时命令可适当增大')
    }),
    execute: ({ command, sessionId, waitMs }, { toolCallId }) =>
      queueExec(async () => {
        const id = resolveTarget(sessionId)
        if (!id) throw new Error('当前没有打开的终端会话')
        const session = sessionManager.get(id)
        if (!session) throw new Error(`会话不存在: ${id}`)

        // 确认模式：先请示用户，被拒绝则不执行
        if (currentPermissionMode() === 'confirm') {
          const approved = await requestConfirm({
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

        // 记录写入前的缓冲区位置，执行后只返回新增部分（增量读取），
        // 避免每次都把 SSH 登录横幅等历史内容重复返回给 AI。
        const beforeLen = sessionManager.outputLength(id)
        sessionManager.write(id, command.endsWith('\n') ? command : `${command}\r`)
        const waited = Math.min(waitMs ?? 3000, 180000)
        await new Promise((resolve) => setTimeout(resolve, waited))
        const raw = sessionManager.outputFrom(id, beforeLen) ?? ''
        return stripAnsi(raw)
      })
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
      sessionId: z.string().optional().describe('目标会话 ID，缺省为本次对话绑定的会话')
    }),
    execute: ({ keys, sessionId }) =>
      queueExec(async () => {
        const id = resolveTarget(sessionId)
        if (!id) throw new Error('当前没有打开的终端会话')
        if (!sessionManager.get(id)) throw new Error(`会话不存在: ${id}`)
        // 增量读取：只返回发送按键后的新增输出
        const beforeLen = sessionManager.outputLength(id)
        sessionManager.write(id, translateKeys(keys))
        await new Promise((resolve) => setTimeout(resolve, 300))
        return stripAnsi(sessionManager.outputFrom(id, beforeLen) ?? '')
      })
  })

  const readOutput = tool({
    description: '读取指定终端会话的最近输出（不执行任何命令）',
    inputSchema: z.object({
      sessionId: z.string().optional().describe('目标会话 ID，缺省为本次对话绑定的会话'),
      maxChars: z.number().optional().describe('最多返回字符数，默认 4000')
    }),
    execute: ({ sessionId, maxChars }) =>
      queueExec(async () => {
        const id = resolveTarget(sessionId)
        if (!id) throw new Error('当前没有打开的终端会话')
        return stripAnsi(sessionManager.recentOutput(id, maxChars ?? 4000) ?? '')
      })
  })

  return {
    list_terminal_sessions: listSessions,
    run_in_terminal: runInTerminal,
    read_terminal_output: readOutput,
    send_keys: sendKeys
  }
}

interface PendingConfirm {
  requestId: string
  resolve: (approved: boolean) => void
  timer: ReturnType<typeof setTimeout>
}

/**
 * 单个终端会话的 AI 助手实例：持有自己的确认队列、工具执行串行链与请求管理，
 * 各终端会话的实例互不共享、互不影响（确认卡、命令队列、中止均独立）。
 */
class AiAssistant extends EventEmitter {
  private readonly getSink: () => ConfirmSink | null
  private abortControllers = new Map<string, AbortController>()
  private pendingConfirms = new Map<string, PendingConfirm>()
  /** 确认请求串行链：前一个确认被应答（或超时）后才弹出下一个 */
  private confirmChain: Promise<unknown> = Promise.resolve()
  /** 每次对话的工具执行串行链：模型并行发出的命令逐条排队执行 */
  private toolQueues = new Map<string, { chain: Promise<unknown>; aborted: boolean }>()

  constructor(getSink: () => ConfirmSink | null) {
    super()
    this.getSink = getSink
  }

  /** 等待用户确认；无 UI 接入时放行，避免流程卡死 */
  requestConfirm(req: Omit<AiConfirmRequest, 'id'>): Promise<boolean> {
    const sink = this.getSink()
    if (!sink) return Promise.resolve(true)
    // 串行化：模型可能在同一步并行发出多个工具调用（多个 run_in_terminal），
    // 渲染端每张确认卡一次只显示一个待确认请求。这里排队逐个弹出，
    // 保证该实例同一时刻只有一个待确认请求。
    const result = this.confirmChain.then(() => this.doRequestConfirm(req, sink))
    this.confirmChain = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  private doRequestConfirm(
    req: Omit<AiConfirmRequest, 'id'>,
    sink: ConfirmSink
  ): Promise<boolean> {
    const id = randomUUID()
    return new Promise<boolean>((resolve) => {
      // 无论以何种方式得出结论（用户回复 / 超时 / 中止），都先通知渲染端移除卡片
      const settle = (approved: boolean) => {
        this.pendingConfirms.delete(id)
        sink.resolved(id)
        resolve(approved)
      }
      const timer = setTimeout(() => settle(false), CONFIRM_TIMEOUT_MS)
      this.pendingConfirms.set(id, { requestId: req.requestId, resolve: settle, timer })
      sink.request({ ...req, id })
    })
  }

  /** 渲染进程回复确认结果 */
  resolveConfirm(id: string, approved: boolean): void {
    const pending = this.pendingConfirms.get(id)
    if (!pending) return
    clearTimeout(pending.timer)
    pending.resolve(approved)
  }

  /** 结束挂起的确认（中止对话 / 超时兜底），按「取消」处理 */
  private clearPendingConfirms(requestId?: string): void {
    for (const pending of this.pendingConfirms.values()) {
      if (requestId && pending.requestId !== requestId) continue
      clearTimeout(pending.timer)
      pending.resolve(false)
    }
  }

  /**
   * 终端工具执行排队：同一对话内串行——前一个工具完成（含确认等待、命令执行、
   * 输出读取）后，下一个才开始。模型在同一步并行发出多条命令时由此保证顺序。
   * 中止对话时队列中尚未开始执行的工具直接拒绝，不再写入终端。
   */
  queueToolExecution<T>(requestId: string, fn: () => Promise<T>): Promise<T> {
    let queue = this.toolQueues.get(requestId)
    if (!queue) {
      queue = { chain: Promise.resolve(), aborted: false }
      this.toolQueues.set(requestId, queue)
    }
    // aborted 标志由闭包持有：流结束后 Map 清理，排队中的项仍能感知中止
    const q = queue
    const run = q.chain.then(() =>
      q.aborted ? Promise.reject(new Error('对话已中止，命令未执行')) : fn()
    )
    q.chain = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  async chat(req: AiChatRequest): Promise<{ requestId: string }> {
    const { history, targetSessionId = null } = req
    const requestId = randomUUID()
    const settings = storage.getAiSettings()
    // 模型按终端会话独立：优先用请求里带的 configId，回退到设置里的默认模型。
    // 会话选的配置被删掉时也要回退，否则这个会话会直接报「未配置」。
    const config =
      (req.configId ? storage.getAiConfig(req.configId) : undefined) ??
      (settings.activeConfigId ? storage.getAiConfig(settings.activeConfigId) : undefined)

    if (!config) {
      // 延迟到 invoke 返回 requestId 之后再发事件，避免渲染端因 requestId 未设置而丢弃
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
    const tools: ToolSet = {
      ...buildTerminalTools(
        requestId,
        targetSessionId,
        // 终端命令串行队列：绑定本次对话，与其他实例互不影响
        (fn) => this.queueToolExecution(requestId, fn),
        // 确认请示走本实例（多实例各自的确认卡独立弹出）
        (confirmReq) => this.requestConfirm(confirmReq)
      ),
      ...mcp.tools,
      // 提问工具不走确认流程：提问本身就是让用户在卡片上做决定
      ...buildAskFollowupTool(requestId, targetSessionId)
    }

    const model = resolveModel(config, req.modelId)
    const historyLimit = config.contextMessages ?? 20
    const modelMessages = toModelMessages(history.slice(-historyLimit))

    const mode = settings.permissionMode === 'confirm' ? 'confirm' : 'full'
    const modeHint =
      mode === 'confirm'
        ? '\n当前处于「确认模式」：执行任何终端命令都会先请求用户确认，用户可能拒绝。被拒绝时不要反复重试同一条命令，先询问用户的意见。'
        : ''

    // 终端绑定提示：本段对话固定作用于绑定的会话
    const boundSession = targetSessionId ? sessionManager.get(targetSessionId) : undefined
    const boundHint = boundSession
      ? `\n本次对话绑定了一个终端会话（${boundSession.info.title}）。除非用户明确要求操作其他会话，终端工具一律作用于该会话，不要切换。`
      : ''

    const systemPrompt = [
      settings.systemPrompt?.trim() || DEFAULT_SYSTEM_PROMPT,
      modeHint,
      boundHint,
      ASK_FOLLOWUP_HINT,
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
      // 挂着的提问也要收尾：不然工具 Promise 不 settle，回合永远卡着
      askFollowupBroker.cancel(requestId)
      this.abortControllers.delete(requestId)
      // 队列对象由排队中的闭包持有，清理 Map 不影响已中止标志的感知
      this.toolQueues.delete(requestId)
    }
  }

  /** 将 AI SDK 流事件转换为渲染进程事件（兼容字段名差异） */
  private adaptPart(part: { type: string } & Record<string, unknown>): AiStreamEvent | null {
    switch (part.type) {
      case 'text-delta':
        return { type: 'text-delta', delta: String(part.text ?? '') }
      // AI SDK 7 的 fullStream 里思考内容是 reasoning-delta（增量在 text 字段），
      // reasoning-start / reasoning-end 只是起止标记，不带内容
      case 'reasoning-delta':
        return { type: 'reasoning-delta', delta: String(part.text ?? '') }
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

  /** 只中止属于自己的请求（其余实例不受影响） */
  abort(requestId: string): void {
    // 标记队列中止：尚未开始执行的排队命令直接跳过，不再写入终端
    const queue = this.toolQueues.get(requestId)
    if (queue) queue.aborted = true
    // 先释放可能正在等待用户确认的工具，避免执行流悬挂
    this.clearPendingConfirms(requestId)
    askFollowupBroker.cancel(requestId)
    this.abortControllers.get(requestId)?.abort()
  }

  /** 会话关闭时销毁实例：中止一切进行中的请求与挂起的确认 */
  dispose(): void {
    this.clearPendingConfirms()
    // 挂着的提问一并收尾（会话关了，卡片也跟着没了，工具不能继续等）
    for (const requestId of this.abortControllers.keys()) askFollowupBroker.cancel(requestId)
    for (const controller of this.abortControllers.values()) controller.abort()
    // 排队中尚未开始的工具直接拒绝
    for (const q of this.toolQueues.values()) q.aborted = true
    this.toolQueues.clear()
    this.removeAllListeners()
  }
}

/**
 * AI 服务注册中心：每个终端会话一个独立的 AiAssistant 实例（多实例互不共享），
 * 对 ipc 层统一收口事件广播与确认转发；会话关闭时销毁其实例。
 */
class AiService extends EventEmitter {
  /** sessionId -> 助手实例（'__no_session__' 为未绑定会话时的共享兜底） */
  private assistants = new Map<string, AiAssistant>()
  private confirmSink: ConfirmSink | null = null

  /** ipc 层注入确认广播（request + resolved） */
  setConfirmSink(sink: ConfirmSink | null): void {
    this.confirmSink = sink
  }

  private assistantFor(sessionId: string): AiAssistant {
    let assistant = this.assistants.get(sessionId)
    if (!assistant) {
      assistant = new AiAssistant(() => this.confirmSink)
      // 实例事件聚合到注册中心统一转发，ipc 层无需感知多实例
      assistant.on('chat-event', (requestId: string, event: AiStreamEvent) =>
        this.emit('chat-event', requestId, event)
      )
      this.assistants.set(sessionId, assistant)
    }
    return assistant
  }

  async chat(req: AiChatRequest): Promise<{ requestId: string }> {
    // 每个终端会话独立实例：对话固定路由到所属会话的助手
    const key = req.targetSessionId ?? sessionManager.getActiveId() ?? '__no_session__'
    return this.assistantFor(key).chat(req)
  }

  /** 渲染进程回复确认结果：转发给持有该确认的实例 */
  resolveConfirm(id: string, approved: boolean): void {
    for (const assistant of this.assistants.values()) assistant.resolveConfirm(id, approved)
  }

  /** 中止某次对话请求：只作用于所属实例 */
  abort(requestId: string): void {
    for (const assistant of this.assistants.values()) assistant.abort(requestId)
  }

  /** 会话关闭：销毁其助手实例（中止进行中的对话与挂起的确认） */
  disposeSession(sessionId: string): void {
    const assistant = this.assistants.get(sessionId)
    if (!assistant) return
    this.assistants.delete(sessionId)
    assistant.dispose()
  }

  isReady(): boolean {
    const settings = storage.getAiSettings()
    return Boolean(settings.activeConfigId)
  }
}

export const aiService = new AiService()
