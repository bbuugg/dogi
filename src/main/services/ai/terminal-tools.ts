/**
 * 终端 AI 助手的工具定义（注册进 tool-registry，scope = 'terminal'）。
 *
 * 从旧 `services/ai/ai.ts` 整体迁来（该文件已随两条 AI 线统一而移除）：
 * - `run_in_terminal` / `send_keys` / `read_terminal_output` / `list_terminal_sessions`
 *   四件套，全部作用于**本轮绑定的终端会话**（`ctx.targetSessionId`，发起对话的那个
 *   终端页面）—— 不随激活终端漂移；
 * - 命令经 `ctx.queueToolExecution` 串行排队（模型并行发出多条时逐条执行）；
 * - 确认模式只有 `run_in_terminal` 拦（`guardTerminal`，写源标记 `[AI]` 照旧进主机日志）。
 *
 * 会话绑定按**请求**计算：同一会话记录在新终端里接着聊时，工具作用于新终端 ——
 * 这是刻意设计（会话是「一段和终端助手的对话」，不是某条 PTY 的遗产）。
 *
 * ⚠️ 输出捕获走**实时 data 事件**，不读环形缓冲：缓冲 256KB 会裁头，
 * 事后 `outputFrom(beforeLen)` 在刷过量之后返回 `''`，模型会收到「完全没有输出」。
 * 等待窗口内订阅 `sessionManager` 的 `data` 边收边喂给产物写入器（见 output-artifact.ts）。
 */
import { z } from 'zod'
import type { AiPermissionMode, ConfirmDecision, HostPlatform } from '@shared/types'
import { isAllowDecision } from '@shared/confirm'
import { sessionManager } from '../terminal/sessions'
import { storage } from '../storage'
import { OutputArtifactWriter, stripAnsi } from './output-artifact'
import type { AiToolDef, ToolRunContext } from './tool-registry'

/** 确认模式下的请示入口（agentService 注入并串行化），探针可替换；返回四档裁决 */
export type TerminalConfirmFn = (req: {
  requestId: string
  toolCallId: string
  toolName: string
  command: string
  sessionId?: string
  sessionTitle?: string
}) => Promise<ConfirmDecision>

/** 当前的命令执行权限模式：每次执行时实时读取，支持对话中途切换（三档直传） */
function currentPermissionMode(): AiPermissionMode {
  const mode = storage.getAiSettings().permissionMode
  return mode === 'confirm' || mode === 'readonly' ? mode : 'full'
}

/**
 * 完整清除终端输出中的 ANSI 转义序列，使 AI 拿到的是纯文本。
 *
 * 实现搬到了 `output-artifact.ts`（那里还有一份**有状态**的 `AnsiStripper`，
 * 处理序列被切成两个 chunk 的情况），这里只做转出，别再抄一份。
 */
export { stripAnsi } from './output-artifact'

/** 把 send_keys 的语义化按键翻译成终端控制字节 */
export function translateKeys(keys: string): string {
  return keys
    .replace(/C-([a-zA-Z])/g, (_m, c: string) =>
      String.fromCharCode(c.toUpperCase().charCodeAt(0) & 0x1f)
    )
    .replace(/Escape/gi, '\x1b')
    .replace(/Enter|Return/gi, '\r')
    .replace(/\r?\n/g, '\r')
}

/** 绑定会话的宿主平台提示（平台探测已知时注入，驱动模型使用对应语法的命令） */
export function sessionPlatformHint(platform: HostPlatform | undefined): string {
  if (platform === 'windows') {
    return '本会话主机平台：Windows（默认 shell 可能是 cmd/PowerShell）——请使用对应语法的命令（dir/type/ipconfig/Get-ChildItem 等），不要使用 apt/htop 等 Linux 命令。'
  }
  if (platform === 'linux') {
    return '本会话主机平台：Linux——请使用 Linux / POSIX 命令（ls/cat/ps 等）。'
  }
  if (platform === 'other') {
    return '本会话主机平台：类 Unix（BSD / macOS 等）——基础命令与 Linux 接近，但部分参数（如 ps/df）有差异，注意甄别。'
  }
  return ''
}

/** 终端助手默认系统提示词（设置里的 systemPrompt 非空时覆盖它） */
export const DEFAULT_TERMINAL_SYSTEM_PROMPT = [
  '你是一个专业的运维助手，运行在一个运维终端工具（Dogi）中。',
  '你可以操作用户的终端会话：执行命令、读取输出。',
  '执行命令前先简要说明要做什么；优先使用安全、无破坏性的命令。',
  '涉及删除文件、重启服务、修改配置等危险操作时，先简要说明影响再执行。',
  '使用 run_in_terminal 执行命令后，终端原始输出即为事实依据；失败时结合输出排查原因再尝试。',
  '需要工具时直接调用工具，不要在正文里用「[调用工具 xxx]」「[工具 xxx 返回]」这类文字复述调用过程或结果 —— 写出来只会让用户看到一串假动作。',
  '终端命令按队列串行执行：前一条命令执行完毕并读取到输出后，下一条才会开始，不会出现并发冲突。',
  '注意：不同操作系统的命令语法不同（Windows 的 cmd/PowerShell 与 Linux 的 bash）。会话绑定提示标注了「主机平台」时以它为准，未标注时结合终端输出判断，不要仅凭会话标题猜测。',
  '部分命令会启动交互式 / 前台程序（如 htop、top、vim、nano、less、man、watch、python、node 等），它们占据终端且不返回 shell 提示符。执行这类命令后，不要继续向该会话输入新命令，应先用 send_keys 工具发送退出指令（多数程序用 "q"，卡死用 "C-c"，个别用 "exit" / "C-d"），并用 read_terminal_output 确认已回到 shell 提示符后再继续。'
].join('\n')

/**
 * 终端助手的系统提示词：默认/自定义提示 + 确认模式提示 + 绑定会话提示（含平台）+ 追问提示。
 * 与工作区 Agent 的 buildAgentSystemPrompt 对齐结构，别一处一个说法。
 */
export function buildTerminalSystemPrompt(input: {
  customPrompt?: string
  permissionMode: AiPermissionMode
  boundSession?: { title: string; platform?: HostPlatform }
  mcpErrors: string[]
}): string {
  const modeHint =
    input.permissionMode === 'readonly'
      ? '\n当前处于「只读模式」：任何终端命令都会被系统**直接拒绝**（不弹确认、没有例外）。请只用 read_terminal_output / list_terminal_sessions 了解现状，把要执行的命令讲清楚由用户自己动手，不要反复重试。'
      : input.permissionMode === 'confirm'
        ? '\n当前处于「确认模式」：执行任何终端命令都会先请求用户确认，用户可能拒绝。被拒绝时不要反复重试同一条命令，先询问用户的意见。'
        : ''
  const bound = input.boundSession
  const boundPlatformHint = bound ? sessionPlatformHint(bound.platform) : ''
  const boundHint = bound
    ? `\n本次对话绑定了一个终端会话（${bound.title}）。除非用户明确要求操作其他会话，终端工具一律作用于该会话，不要切换。${boundPlatformHint ? `\n${boundPlatformHint}` : ''}`
    : ''
  return [
    input.customPrompt?.trim() || DEFAULT_TERMINAL_SYSTEM_PROMPT,
    modeHint,
    boundHint,
    // ASK_FOLLOWUP_HINT 由调用方拼接（与工作区 Agent 同序）
    input.mcpErrors.length
      ? `\n注意，以下 MCP 服务当前不可用：\n${input.mcpErrors.join('\n')}`
      : ''
  ].join('\n')
}

/** 会话解析：显式指定 > 本轮绑定 > 当前活跃（历史行为，别改） */
function resolveTarget(ctx: ToolRunContext, sessionId?: string): string | undefined {
  return sessionId ?? ctx.targetSessionId ?? sessionManager.getActiveId() ?? undefined
}

/**
 * 等待窗口内捕获会话的实时输出，边收边喂给产物写入器。
 *
 * ⚠️ 必须订阅 `data` 事件而不是等结束再 `outputFrom`：
 * 环形缓冲上限 256KB（MAX_OUTPUT_BUFFER），刷过量之后头部已被裁掉，
 * 此时 `slice(beforeLen)` 返回空串 —— 模型会以为命令「没有任何输出」。
 * 订阅还有个附带好处：上一条命令仍在跑时陆续到达的输出不会被算到本次头上。
 *
 * 监听器在 finally 里摘掉；等待可被 abort 提前结束（否则用户按了停止，
 * 工具还在这里睡满 waitMs，界面看着像卡死）。
 */
async function captureDuring(
  sessionId: string,
  writer: OutputArtifactWriter,
  waitMs: number,
  signal: AbortSignal
): Promise<void> {
  const onData = (payload: { sessionId: string; data: string | Buffer }) => {
    if (payload.sessionId !== sessionId) return
    writer.append(typeof payload.data === 'string' ? payload.data : payload.data.toString('utf8'))
  }
  sessionManager.on('data', onData)
  try {
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer)
        signal.removeEventListener('abort', done)
        resolve()
      }
      const timer = setTimeout(done, waitMs)
      if (signal.aborted) done()
      else signal.addEventListener('abort', done, { once: true })
    })
  } finally {
    sessionManager.off('data', onData)
  }
}

/** 改动类命令的统一入口：读实时设置 + 走 ctx 的请示入口（requestId 由 service 补） */
async function confirmIfNeeded(
  ctx: ToolRunContext,
  req: { toolCallId: string; toolName: string; command: string; sessionId?: string; sessionTitle?: string }
): Promise<string | null> {
  const mode = currentPermissionMode()
  // 只读模式：直接回绝（不弹卡）—— 与工作区 Agent 的 guardWrite 同一档语义
  if (mode === 'readonly') {
    return '当前权限模式为「只读」，命令未运行。请只做只读的分析与说明，把需要执行的命令讲清楚由用户决定，不要反复重试。'
  }
  if (mode !== 'confirm') return null
  const decision = await ctx.requestConfirm(req)
  // 「总是允许 / 总是拒绝」由 service 记忆：命中时直接回 once 档，不会弹卡
  return isAllowDecision(decision)
    ? null
    : '用户取消了本次命令执行（命令未运行）。请询问用户接下来希望怎么做，不要擅自重试。'
}

export function buildTerminalToolDefs(): AiToolDef[] {
  return [
    {
      name: 'list_terminal_sessions',
      scope: 'terminal',
      description: '列出当前打开的所有终端会话（本地终端与 SSH）',
      inputSchema: z.object({}),
      execute: async (_rawInput, _call, ctx) => {
        const sessions = sessionManager.list()
        const activeId = sessionManager.getActiveId()
        return {
          activeSessionId: activeId,
          /** 本轮绑定的会话：工具缺省作用于它 */
          boundSessionId: ctx.targetSessionId ?? null,
          sessions: sessions.map((s) => ({
            sessionId: s.id,
            type: s.type,
            title: s.title,
            exited: s.exited,
            /** 探测到的主机平台（unknown = 未探测 / 探测失败） */
            platform: s.platform ?? 'unknown'
          }))
        }
      }
    },

    {
      name: 'run_in_terminal',
      scope: 'terminal',
      description:
        '在指定终端会话中执行命令（等同于用户在键盘输入并回车），等待片刻后返回本次命令的新增输出（不含历史内容）。未指定会话时使用本轮绑定的会话。命令串行执行：前一条完成并读取结果后才开始下一条。返回的输出中如果末尾有 shell 提示符（如 $ 或 # 结尾的行），说明命令已执行完毕、终端可继续输入；如果没有 shell 提示符，说明命令可能仍在运行或启动了交互式/前台程序（如 htop、vim、less、python REPL 等），此时不要继续执行新命令，应先用 send_keys 发送退出指令。输出过长时会返回开头与结尾片段，并在文本里给出产物 id 与总长度，用 read_tool_output 按 offset 继续读完整内容。',
      inputSchema: z.object({
        command: z.string().describe('要执行的命令，无需附加换行符'),
        sessionId: z.string().optional().describe('目标会话 ID，缺省为本轮绑定的会话'),
        waitMs: z.number().optional().describe('执行后等待毫秒数，默认 3000，长耗时命令可适当增大')
      }),
      execute: async (rawInput, call, ctx) => {
        const { command, sessionId, waitMs } = rawInput as {
          command: string
          sessionId?: string
          waitMs?: number
        }
        return ctx.queueToolExecution!(async () => {
          const id = resolveTarget(ctx, sessionId)
          if (!id) throw new Error('当前没有打开的终端会话')
          const session = sessionManager.get(id)
          if (!session) throw new Error(`会话不存在: ${id}`)

          const refused = await confirmIfNeeded(ctx, {
            toolCallId: call.toolCallId,
            toolName: 'run_in_terminal',
            command,
            sessionId: id,
            sessionTitle: session.info.title
          })
          if (refused) return refused

          // 监听要在写入之前挂上，否则命令回显的那一段会漏掉
          const writer = new OutputArtifactWriter({
            conversationId: ctx.conversationId,
            toolCallId: call.toolCallId,
            strip: true
          })
          // 'ai' 来源：命令记录里会打 [AI] 标记（主机日志 terminal 作用域）
          sessionManager.write(id, command.endsWith('\n') ? command : `${command}\r`, 'ai')
          await captureDuring(id, writer, Math.min(waitMs ?? 3000, 180000), ctx.signal)
          const result = await writer.finish()
          return result.text
        })
      }
    },

    {
      name: 'send_keys',
      scope: 'terminal',
      description:
        '向终端发送按键或控制序列（不会自动回车）。主要用于退出交互式 / 前台程序：如发送 "q" 退出 htop/less/man，发送 "C-c" 发送 Ctrl-C，发送 "C-d" 发送 Ctrl-D，发送 "Escape" 退出某些程序。普通命令执行前一般不需要此工具。',
      inputSchema: z.object({
        keys: z
          .string()
          .describe(
            "要发送的按键序列。普通字符直接写，如 'q'、'exit'；控制键写法 'C-c'、'C-d'、'C-z'、'Escape'；换行 / 回车用 'Enter' 或 '\\n'。"
          ),
        sessionId: z.string().optional().describe('目标会话 ID，缺省为本轮绑定的会话')
      }),
      execute: async (rawInput, call, ctx) => {
        const { keys, sessionId } = rawInput as { keys: string; sessionId?: string }
        // 只读模式：连按键也不许发 —— send_keys 直接驱动终端，等同于执行命令。
        // 刻意**不**套 confirmIfNeeded：确认模式本来就不拦 send_keys（它多是退出交互程序的 q / C-c）。
        if (currentPermissionMode() === 'readonly') {
          return '当前权限模式为「只读」，按键未发送。请把需要发送的内容说明给用户，由用户自己操作。'
        }
        return ctx.queueToolExecution!(async () => {
          const id = resolveTarget(ctx, sessionId)
          if (!id) throw new Error('当前没有打开的终端会话')
          if (!sessionManager.get(id)) throw new Error(`会话不存在: ${id}`)
          // 增量捕获：只收发送按键之后到达的输出（监听先挂上再写，命令回显才不漏）
          const writer = new OutputArtifactWriter({
            conversationId: ctx.conversationId,
            toolCallId: call.toolCallId,
            strip: true
          })
          sessionManager.write(id, translateKeys(keys), 'ai')
          await captureDuring(id, writer, 300, ctx.signal)
          const result = await writer.finish()
          return result.text
        })
      }
    },

    {
      name: 'read_terminal_output',
      scope: 'terminal',
      description:
        '读取指定终端会话**当前**的最近输出（不执行任何命令）。注意这是会话的实时缓冲区（只保留最近 256KB），适合看命令跑完之后终端现在是什么状态；如果上一次工具调用返回了产物 id，要读那段被截断的完整输出请改用 read_tool_output 按 id + offset 读。',
      inputSchema: z.object({
        sessionId: z.string().optional().describe('目标会话 ID，缺省为本轮绑定的会话'),
        maxChars: z.number().optional().describe('最多返回字符数，默认 4000')
      }),
      execute: async (rawInput, _call, ctx) => {
        const { sessionId, maxChars } = rawInput as { sessionId?: string; maxChars?: number }
        return ctx.queueToolExecution!(async () => {
          const id = resolveTarget(ctx, sessionId)
          if (!id) throw new Error('当前没有打开的终端会话')
          return stripAnsi(sessionManager.recentOutput(id, maxChars ?? 4000) ?? '')
        })
      }
    }
  ]
}
