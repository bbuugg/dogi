/**
 * ACP（Agent Client Protocol）Agent 服务。
 *
 * 应用作为 ACP 客户端，spawn 一个外部 ACP agent（如 codex-acp）并通过 stdio 通信，
 * 把 agent 的事件流映射为应用既有的 AgentStreamEvent，权限请求映射为确认卡。
 *
 * **会话模型（本轮架构调整后的约定）**：
 * - 一个本地会话 = 一条常驻连接 + 一个 ACP 会话；绑定关系是
 *   `conversationId → { acpAgentId, acpSessionId }`，**创建后不可切换 agent**。
 * - 消息**由 agent 自己管理**：本地不保存任何消息。
 *   - 新建的会话：首轮对话用 `session/new` 建会话，把返回的 sessionId 广播回渲染端落盘；
 *   - 导入的会话：打开时用 `session/load`，agent 把整段历史回放（拼成消息列表整段下发）。
 * - **配置项**：agent 把「这个会话用什么」表达成 `configOptions`（模型只是其中
 *   `category: 'model'` 的一项），我们在**创建会话时就 `session/new`**（`prepare`）把它整组取回，
 *   按 id 展示与下发，切换走 `session/set_config_option`、**不重建会话**。
 *   解析是纯逻辑，另见 `./acp-config-options.ts`（可脱离 Electron 单测）。
 * - **上下文水位**：`session/update` 的 `usage_update`（`{ used, size }`）映射成独立的
 *   `context-usage` 事件（刻意不并进 `usage` —— 那是一轮一加总的账，这是当下水位）。
 * - 会话发现与导入：`listSessions()`（`session/list`）、`deleteSession()`（`session/delete`）
 *   都建临时连接，用完即杀。
 */
import { randomUUID } from 'node:crypto'
import { spawn, spawnSync, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { statSync } from 'node:fs'
import * as os from 'node:os'
import { delimiter, join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { app } from 'electron'
import * as acp from '@agentclientprotocol/sdk'
import type {
  AgentCapabilities,
  ClientContext,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionMode,
  SessionUpdate
} from '@agentclientprotocol/sdk'
import type {
  AcpAgentConfig,
  AcpConfigOption,
  AcpConversationState,
  AcpModelList,
  AcpSessionInfo,
  AgentChatRequest,
  AgentStreamEvent,
  AgentWorkspace,
  AiPermissionMode,
  ConfirmDecision,
  ConfirmOption
} from '@shared/types'
import { confirmOptionsFromAcpKinds } from '@shared/confirm'
import { storage } from '../storage'
import type { AgentConfirmSink } from './agent'
import { HistoryAssembler, pushHistoryUpdate, toolLabelOf } from './acp-history'
import { acpToolKindOf, acpToolTitle } from '@shared/acp-tools'
// 配置项与 usage_update 的映射是**纯逻辑**，单独一个文件（可脱离 Electron 跑真源码验证）
import { extractConfigOptions, extractModelOption, usageUpdateToEvent } from './acp-config-options'
import { readWorkspaceTextFile, writeWorkspaceTextFile } from './acp-fs'
import { armConfirmTimeout } from './timeouts'
import { isWorkspaceDirAvailable } from './workspace-health'

/** 临时连接（列表 / 删除会话）的超时：agent 30 秒没建好会话就放弃 */
const TEMP_CONNECTION_TIMEOUT_MS = 30_000

/** 发出 session/cancel 后等 agent 收手的兜底时间；超时就强断连接（会话可能因此失效） */
const CANCEL_FALLBACK_MS = 8_000

/**
 * 「新建了 ACP 会话但一直没发消息」的连接回收时限。
 *
 * 形态选择在**创建会话时**就定了，所以打开一个 ACP 新会话页就会先建好 agent 会话
 * （好让配置项立刻可用，见 `prepare`）。若用户转头再没理它 —— 会话是草稿、不落盘、
 * 也没有可关的标签 —— 那条 agent 连接就成了纯孤儿进程。到期直接 teardown：
 * 真要继续用时 `ensureSession` 会重新建一条（agent 侧的会话 id 也随之丢，
 * 那本来就是个没人发过消息的空会话）。
 */
const DRAFT_IDLE_TTL_MS = 15 * 60_000

/** agent 派生的会话 id → 本地会话（用于会话列表落盘） */
function describeError(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

/**
 * Windows 上判断这条命令能不能直接 spawn；不能就交给 `cmd.exe /c`。
 *
 * 必须包 cmd 的两种情况：
 * - 命令本身以 `.cmd` / `.bat` 结尾（CreateProcess 不能直接执行脚本）；
 * - **无扩展名的命令，而 PATH 上命中的真身是 `xxx.CMD`**：npm / pnpm 全局安装的 CLI
 *   （npm、pnpm、pi-acp、codex-acp…）在 bin 目录里是三件套 —— `xxx`（POSIX sh 脚本，
 *   给 Git Bash 用）、`xxx.CMD`、`xxx.ps1`。**libuv 不按 PATHEXT 解析**，直接
 *   `spawn('xxx')` 抓不到那个 sh 脚本（CreateProcess 执行不了它），结果是 **ENOENT**
 *   （实测 `spawn('pi-acp')` 即如此）。
 *
 * `.exe` / `.com` 保持直连 —— 少一层 cmd 包装，参数也不会被 cmd 二次解析。
 */
function resolveWindowsCommand(command: string): { command: string; viaCmd: boolean } {
  if (process.platform !== 'win32') return { command, viaCmd: false }
  if (/\.(cmd|bat)$/i.test(command)) return { command, viaCmd: true }
  if (/\.(exe|com)$/i.test(command)) return { command, viaCmd: false }
  // 带路径分隔符的：当它是确定文件，且不是 .exe/.com → 一定是脚本
  if (/[\\/]/.test(command)) return { command, viaCmd: true }
  // 裸命令名：按 PATH × PATHEXT 找出真身，看它是不是脚本
  const exts = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
  for (const dir of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    for (const ext of exts) {
      let isFile = false
      try {
        isFile = statSync(join(dir, command + ext)).isFile()
      } catch {
        isFile = false
      }
      if (isFile) return { command, viaCmd: /\.(cmd|bat)$/i.test(ext) }
    }
  }
  // PATH 上找不到：仍走 cmd 兜底，报错信息与原来一致
  return { command, viaCmd: true }
}

/** .cmd/.bat（含无扩展名的全局 CLI 别名）在 Windows 下需经 cmd.exe 才能启动 */
function spawnAgentProcess(
  cfg: AcpAgentConfig,
  cwd: string
): ChildProcessWithoutNullStreams {
  const args = cfg.args ?? []
  // 用户配置的环境变量合并进进程环境（GUI 主进程不继承 shell 里的 key，
  // 例如 Claude Code 需要的 ANTHROPIC_API_KEY / ANTHROPIC_MODEL）。
  // 只覆盖显式给的 key，其余沿用父进程环境。
  const env: NodeJS.ProcessEnv = cfg.env ? { ...process.env, ...cfg.env } : process.env
  const resolved = resolveWindowsCommand(cfg.command)
  if (resolved.viaCmd) {
    return spawn('cmd.exe', ['/c', resolved.command, ...args], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env
    })
  }
  return spawn(resolved.command, args, {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    env
  })
}

/** 杀掉进程（Windows 下连子树一起，避免 cmd.exe 包装层残留 agent） */
function killProcessTree(proc: ChildProcess): void {
  if (proc.exitCode !== null || proc.signalCode !== null) return
  if (process.platform === 'win32' && proc.pid) {
    try {
      spawnSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], {
        windowsHide: true,
        timeout: 5000
      })
      return
    } catch {
      // 回退到直接 kill
    }
  }
  proc.kill()
}

/** 把 ACP 会话更新映射为应用的流事件（**实时回合**路径，不含历史回放） */
function toStreamEvent(update: SessionUpdate): AgentStreamEvent | null {
  switch (update.sessionUpdate) {
    case 'agent_message_chunk':
      return update.content.type === 'text'
        ? { type: 'text-delta', delta: update.content.text }
        : null
    case 'agent_thought_chunk':
      // agent 的思考过程（如 codex-acp 的 thinking 输出），渲染端显示为推理面板
      return update.content.type === 'text'
        ? { type: 'reasoning-delta', delta: update.content.text }
        : null
    case 'tool_call':
      return {
        type: 'tool-call',
        toolCallId: update.toolCallId,
        toolName: toolLabelOf(update),
        input: update.rawInput ?? {},
        // kind → 中文工具名（拿不到 name 时的唯一线索），title → 工具名后面的明细
        acpKind: acpToolKindOf(update),
        title: acpToolTitle(update.title)
      }
    case 'tool_call_update': {
      if (update.status !== 'completed' && update.status !== 'failed') return null
      return {
        type: 'tool-result',
        toolCallId: update.toolCallId,
        toolName: toolLabelOf(update),
        output: update.rawOutput ?? update.content ?? {},
        isError: update.status === 'failed'
      }
    }
    default:
      // 其余（usage_update / plan / available_commands / session_info …）：
      // 用得上的走各自的专门映射，其余没有对应界面形态，忽略
      return usageUpdateToEvent(update as { sessionUpdate: string })
  }
}

interface PendingConfirm {
  requestId: string
  resolve: (decision: ConfirmDecision) => void
  /** 兜底定时器；按默认配置（不限时）时是 undefined（见 timeouts.ts） */
  timer?: ReturnType<typeof setTimeout>
}

/**
 * 一个**会话**的常驻 ACP 连接与会话。
 *
 * 按 conversationId（而不是 workspaceId）缓存：同一个工作区下的多个会话必须各有
 * 独立的 agent 上下文，共用一个连接会让两个会话互相串味。
 */
interface ConversationAcpSession {
  conversationId: string
  /** 工作区名（确认卡上要显示「在哪个工作区」） */
  workspaceName: string
  /** 绑定的 ACP agent 配置 id（不可切换） */
  acpAgentId: string
  /** agent 侧会话 id；尚未建立时为 null */
  sessionId: string | null
  proc: ChildProcess
  /** connectWith 的连接生命周期 promise（op 挂起直到连接关闭） */
  connection: Promise<unknown>
  /** initialize + session/new|load 完成后的就绪 promise；失败时 reject */
  sessionReady: Promise<void>
  /** 客户端上下文（session/prompt / set_config_option / session/cancel 都靠它发） */
  ctx: ClientContext | null
  /** 当前正在消费 `session/update` 的接收器（一轮对话 / 一次历史回放） */
  updateSink: ((update: SessionUpdate) => void) | null
  /** 正在进行的 turn 绑定的 requestId（权限确认卡回填用） */
  currentRequestId: string | null
  /**
   * agent 在 `session/new` 里**可选**广告的会话档位（ACP Session Modes）。
   * 空数组 = 它没广告 / 不支持 —— 那我们就只剩「被问到时批准或拒绝」这一条路
   * （协议不支持客户端强制它来问，见 pickModeId / applyPermissionMode）。
   */
  availableModes: SessionMode[]
  /** 会话建立时的档位（约定对应「自动执行」档） */
  defaultModeId: string | null
  /** 当前已生效的档位（避免每轮重复下发） */
  appliedModeId: string | null
  /** agent 是否支持 `session/load`（不支持时导入的历史回放不了） */
  canLoad: boolean
  /** agent 上报的模型选择项；null = 不上报（模型由 agent 自己决定） */
  modelOption: AcpModelList | null
  /**
   * agent 广告出来的**全部**会话配置项（模型项只是其中 `category: 'model'` 的那一项）。
   * 会话页按它渲染每个开关、按 id 下发 `session/set_config_option`。
   */
  configOptions: AcpConfigOption[]
  /**
   * 「已建好会话但还没发过消息」的连接的兜底回收定时器（见 DRAFT_IDLE_TTL_MS）。
   * 真正开始对话（sessionId 落盘）后即清掉。
   */
  draftIdleTimer: ReturnType<typeof setTimeout> | null
  /** 通知连接关闭，让 connectWith 的 op 返回 */
  closeConnection: () => void
  /** 取消兜底定时器（见 CANCEL_FALLBACK_MS） */
  cancelFallback: ReturnType<typeof setTimeout> | null
  /** 是否已把会话状态（sessionId / 模型）广播给渲染端 */
  stateBroadcast: boolean
  closed: boolean
}

class AcpAgentService extends EventEmitter {
  private confirmSink: AgentConfirmSink | null = null
  /** key 为 conversationId（同一工作区的不同会话各有一条常驻连接） */
  private sessions = new Map<string, ConversationAcpSession>()
  /** 每会话的 turn 串行链：前一轮结束才启动下一轮 */
  private turnChains = new Map<string, Promise<unknown>>()
  private pendingConfirms = new Map<string, PendingConfirm>()
  /** 确认请求串行链（与 agent.ts 一致） */
  private confirmChain: Promise<unknown> = Promise.resolve()
  private abortedRequests = new Set<string>()
  /** requestId -> 归属：事件路由与中止都要按会话定位到具体连接 */
  private requestTargets = new Map<string, { conversationId: string }>()
  /** 正在进行的「历史回放」请求：同一会话重复打开（StrictMode / 多标签）时复用同一次 */
  private loadRequests = new Map<string, string>()

  setConfirmSink(sink: AgentConfirmSink | null): void {
    this.confirmSink = sink
  }

  /** 渲染进程回复确认结果（四档裁决） */
  resolveConfirm(id: string, decision: ConfirmDecision): void {
    const pending = this.pendingConfirms.get(id)
    if (!pending) return
    clearTimeout(pending.timer)
    pending.resolve(decision)
  }

  /** 结束挂起的确认（中止 / 连接关闭兜底），按「拒绝一次」处理 —— 确认卡不限时，就靠它收尾 */
  private clearPendingConfirms(requestId?: string): void {
    for (const pending of this.pendingConfirms.values()) {
      if (requestId && pending.requestId !== requestId) continue
      clearTimeout(pending.timer)
      pending.resolve('reject_once')
    }
  }

  /**
   * 弹确认卡等用户裁决。
   *
   * `options` 按 agent 广告的 `option.kind` 收窄（见 `confirmOptionsFromAcpKinds`）——
   * agent 只给 allow_once / reject_once 时，界面上就不会出现「总是」那一档。
   * 「总是允许」的记忆交给 agent 自己（ACP 的 allow_always 语义就是「以后别再问」），
   * 本地不再记一份，免得与 agent 侧的判断打架。
   */
  private requestConfirm(
    workspaceName: string,
    options: ConfirmOption[],
    req: { requestId: string; toolCallId: string; toolName: string; command: string }
  ): Promise<ConfirmDecision> {
    const sink = this.confirmSink
    if (!sink) return Promise.resolve('allow_once')
    const result = this.confirmChain.then(() =>
      this.doRequestConfirm(workspaceName, options, req, sink)
    )
    this.confirmChain = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  private doRequestConfirm(
    workspaceName: string,
    options: ConfirmOption[],
    req: { requestId: string; toolCallId: string; toolName: string; command: string },
    sink: AgentConfirmSink
  ): Promise<ConfirmDecision> {
    const id = randomUUID()
    return new Promise<ConfirmDecision>((resolve) => {
      const settle = (decision: ConfirmDecision) => {
        this.pendingConfirms.delete(id)
        sink.resolved(id)
        resolve(decision)
      }
      const timer = armConfirmTimeout(
        () => settle('reject_once'),
        storage.getAiSettings().confirmTimeoutMs
      )
      this.pendingConfirms.set(id, { requestId: req.requestId, resolve: settle, timer })
      sink.request({
        id,
        requestId: req.requestId,
        toolCallId: req.toolCallId,
        toolName: req.toolName,
        command: req.command,
        options,
        workspaceName
      })
    })
  }

  // ---------------------------------------------------------------- 会话发现

  /**
   * 拉取某个 ACP agent 侧的会话列表（`session/list`）。
   *
   * 建一条临时连接：initialize → session/list（可带 cwd 过滤）→ 杀掉进程。
   * agent 没广告 `sessionCapabilities.list` 时给出明确报错（而不是空列表）。
   */
  async listSessions(cfg: AcpAgentConfig, cwd?: string): Promise<AcpSessionInfo[]> {
    return this.withTempConnection(cfg, async (ctx, capabilities) => {
      if (!capabilities.sessionCapabilities?.list) {
        throw new Error('该 agent 不支持会话列表（未声明 sessionCapabilities.list）')
      }
      const sessions: AcpSessionInfo[] = []
      let cursor: string | null | undefined
      // 分页：nextCursor 存在就继续翻页，最多 20 页（防 agent 给错数据时无限循环）
      for (let page = 0; page < 20; page++) {
        const res = await ctx.request(acp.methods.agent.session.list, {
          ...(cwd ? { cwd } : {}),
          ...(cursor ? { cursor } : {})
        })
        for (const s of res.sessions) {
          sessions.push({
            sessionId: s.sessionId,
            cwd: s.cwd,
            ...(s.title ? { title: s.title } : {}),
            ...(s.updatedAt ? { updatedAt: s.updatedAt } : {})
          })
        }
        cursor = res.nextCursor
        if (!cursor) break
      }
      return sessions
    })
  }

  /**
   * 让 agent 删掉它那边的会话（`session/delete`）。
   *
   * 只在用户显式勾选「同时删除 agent 侧会话」时调用；agent 不支持就抛错，
   * 由调用方提示（本地记录该删还是删）。
   */
  async deleteSession(cfg: AcpAgentConfig, sessionId: string): Promise<void> {
    await this.withTempConnection(cfg, async (ctx, capabilities) => {
      if (!capabilities.sessionCapabilities?.delete) {
        throw new Error('该 agent 不支持删除会话（未声明 sessionCapabilities.delete）')
      }
      await ctx.request(acp.methods.agent.session.delete, { sessionId })
    })
  }

  /**
   * 向 agent 询问可用模型：临时建连（initialize → `session/new`）读 `configOptions` 里
   * `category=model` 那一项，用完即杀。
   *
   * 结果供**设置页勾选**（`AcpAgentConfig.models`），会话页的模型下拉只列勾选过的那些
   * （见 4.18：模型来源 = ACP 设置里勾选的模型）。agent 不上报模型时返回 null。
   */
  async listModels(cfg: AcpAgentConfig): Promise<AcpModelList | null> {
    return this.withTempConnection(cfg, async (ctx) => {
      const created = await ctx.request(acp.methods.agent.session.new, {
        cwd: os.tmpdir(),
        mcpServers: []
      })
      return extractModelOption(created.configOptions)
    })
  }

  /** 建一条临时连接跑一段逻辑（用完必杀进程），返回逻辑的结果 */
  private async withTempConnection<T>(
    cfg: AcpAgentConfig,
    op: (ctx: ClientContext, capabilities: AgentCapabilities) => Promise<T>
  ): Promise<T> {
    const cwd = os.tmpdir()
    const proc = spawnAgentProcess(cfg, cwd)
    let closeConnection: () => void = () => {}
    try {
      return await new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error('超时（agent 30 秒内未响应）'))
        }, TEMP_CONNECTION_TIMEOUT_MS)
        let settled = false
        const settle = (fn: () => void): void => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          fn()
        }
        proc.stderr?.on('data', (chunk: Buffer) => {
          process.stderr.write(`[acp-agent] ${chunk.toString()}`)
        })
        proc.on('error', (err) => settle(() => reject(err)))
        proc.on('exit', (code) =>
          settle(() => reject(new Error(`agent 已退出（code=${code ?? 'unknown'}）`)))
        )

        const stream = acp.ndJsonStream(Writable.toWeb(proc.stdin!), Readable.toWeb(proc.stdout!))
        acp
          .client({ name: 'Dogi' })
          .connectWith(stream, async (ctx) => {
            const res = await ctx.request(acp.methods.agent.initialize, {
              protocolVersion: acp.PROTOCOL_VERSION,
              clientCapabilities: { session: {} },
              clientInfo: { name: 'Dogi', version: app.getVersion() }
            })
            const result = await op(ctx, res.agentCapabilities ?? {})
            settle(() => resolve(result))
            // 结果已拿到：等连接关闭（下面的 finally 会杀进程）
            await new Promise<void>((r) => {
              closeConnection = r
            })
          })
          .catch((err) => settle(() => reject(err instanceof Error ? err : new Error(String(err)))))
      })
    } finally {
      killProcessTree(proc)
      closeConnection()
    }
  }

  // ---------------------------------------------------------------- 对话

  async chat(req: AgentChatRequest): Promise<{ requestId: string }> {
    const requestId = randomUUID()
    const workspace = req.workspaceId ? storage.getAgentWorkspace(req.workspaceId) : undefined
    const acpAgent = this.resolveAgent(req.acpAgentId)

    const fail = (message: string) => {
      // 延迟到 invoke 返回 requestId 之后再发事件，避免渲染端因 requestId 未设置而丢弃
      setTimeout(() => {
        this.emitEvent(requestId, { type: 'error', message })
        this.emitEvent(requestId, { type: 'finish', finishReason: 'error' })
      }, 0)
    }
    if (!workspace) {
      fail('工作区不存在，请先选择或新建一个工作区')
      return { requestId }
    }
    /**
     * 目录被删 / 被移走：外部 agent 进程就是**以工作区目录为 cwd** 起来的
     * （见 runTurn 里的 `spawnAgentProcess(acpAgent, workspace.path)`），目录没了
     * 连 spawn 都起不来，报出来的错与「agent 没装好」长得一样、极难分辨。
     * 在这里当场给一句人话。
     *
     * 判据与内置 agent / 巡检共用同一份 `isWorkspaceDirAvailable`
     * （见 services/ai/workspace-health.ts）；自己 `stat` 而不看 `dirMissing`，
     * 因为那个标记可能慢半拍。
     */
    if (!(await isWorkspaceDirAvailable(workspace.path))) {
      fail(`工作区目录不存在：${workspace.path}（可能已被删除或移动）`)
      return { requestId }
    }
    if (!acpAgent) {
      fail('该会话绑定的 ACP agent 已不存在，请重新导入或删除这个会话')
      return { requestId }
    }

    const text = lastUserText(req.history)
    if (!text) {
      fail('没有可发送的内容')
      return { requestId }
    }

    const conversationId = req.conversationId
    this.requestTargets.set(requestId, { conversationId })
    const chain = (this.turnChains.get(conversationId) ?? Promise.resolve()).then(() =>
      this.runTurn(requestId, workspace, conversationId, acpAgent, req.acpSessionId, text, req.modelId)
    )
    this.turnChains.set(
      conversationId,
      chain.catch(() => undefined)
    )
    return { requestId }
  }

  /** 取历史中最后一条用户文本（ACP 会话保留上下文，每轮只发新输入） */
  private async runTurn(
    requestId: string,
    workspace: AgentWorkspace,
    conversationId: string,
    acpAgent: AcpAgentConfig,
    acpSessionId: string | undefined,
    text: string,
    modelId?: string
  ): Promise<void> {
    console.error('[acp-agent] runTurn start', requestId, conversationId)
    try {
      const ws = await this.ensureSession(
        workspace,
        conversationId,
        acpAgent,
        acpSessionId,
        modelId
      )
      console.error('[acp-agent] session ready', ws.sessionId)
      ws.currentRequestId = requestId
      // 先按当前权限模式把 agent 档位摆正，再提问 —— 否则「需确认」在 ACP agent 上
      // 只是被动等着它来问，很多 agent 的默认档根本不会问（见 pickModeId 的注释）
      await this.applyPermissionMode(ws)
      await this.applyModel(ws, modelId, true)

      const ctx = ws.ctx
      const sessionId = ws.sessionId
      if (!ctx || !sessionId) throw new Error('ACP 会话未就绪')

      // 本轮的更新接收器：文本 / 思考 / 工具调用都经它映射成流事件
      ws.updateSink = (update) => {
        if (this.abortedRequests.has(requestId)) return
        // agent 自己换了档位（如切到 plan）：把「已生效档位」跟着更新。否则下一轮我们
        // 以为还停在自己设的档上、直接跳过切换，权限模式就悄悄失效了。
        if (update.sessionUpdate === 'current_mode_update') {
          ws.appliedModeId = update.currentModeId
        }
        if (update.sessionUpdate === 'config_option_update') {
          this.onConfigOptionUpdate(ws, update)
        }
        const event = toStreamEvent(update)
        if (event) this.emitEvent(requestId, event)
      }

      // 等 prompt 结束：中途的更新由上面的接收器实时产出，这里只拿最终 stopReason
      const res = await ctx.request(acp.methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: 'text', text }]
      })
      if (this.abortedRequests.has(requestId)) {
        this.emitEvent(requestId, { type: 'finish', finishReason: 'aborted' })
      } else {
        this.emitEvent(requestId, {
          type: 'finish',
          // ACP 协议里的 stopReason 叫 'cancelled'，但落到我们的事件上统一用 'aborted'
          // （与 mastra 路径的中止语义、渲染端 notifyAgentFinished 的判定对齐，
          //   否则「用户主动停止」会被当成正常完成弹通知）
          finishReason: res.stopReason === 'cancelled' ? 'aborted' : 'done'
        })
      }
    } catch (err) {
      console.error('[acp-agent] runTurn error', requestId, describeError(err))
      if (this.abortedRequests.has(requestId)) {
        this.emitEvent(requestId, { type: 'finish', finishReason: 'aborted' })
      } else {
        this.emitEvent(requestId, { type: 'error', message: describeError(err) })
        this.emitEvent(requestId, { type: 'finish', finishReason: 'error' })
      }
    } finally {
      this.clearPendingConfirms(requestId)
      this.abortedRequests.delete(requestId)
      this.requestTargets.delete(requestId)
      const ws = this.sessions.get(conversationId)
      if (ws) {
        ws.currentRequestId = null
        ws.updateSink = null
        if (ws.cancelFallback) {
          clearTimeout(ws.cancelFallback)
          ws.cancelFallback = null
        }
      }
    }
  }

  /**
   * 打开一个 ACP 会话：让 agent 用 `session/load` 回放整段历史（**本地不落盘**）。
   *
   * 回放出来的更新由 HistoryAssembler 拼成消息列表，作为一条 `history` 事件整段下发 ——
   * 渲染端拿到后直接替换本地镜像，避免「流式拼装 + 重复打开」造成的重复消息。
   */
  async load(req: {
    workspaceId: string
    conversationId: string
    acpAgentId?: string
    acpSessionId?: string
    modelId?: string
  }): Promise<{ requestId: string }> {
    const requestId = randomUUID()
    // 同一会话重复请求（StrictMode / 多标签同时挂载）复用同一次回放，别把历史上屏两遍
    const existing = this.loadRequests.get(req.conversationId)
    if (existing) return { requestId: existing }

    const workspace = req.workspaceId ? storage.getAgentWorkspace(req.workspaceId) : undefined
    const acpAgent = this.resolveAgent(req.acpAgentId)
    const fail = (message: string) => {
      setTimeout(() => {
        this.emitEvent(requestId, { type: 'error', message })
        this.emitEvent(requestId, { type: 'finish', finishReason: 'error' })
      }, 0)
    }
    if (!workspace) {
      fail('工作区不存在，请先选择或新建一个工作区')
      return { requestId }
    }
    if (!acpAgent) {
      fail('该会话绑定的 ACP agent 已不存在，请重新导入或删除这个会话')
      return { requestId }
    }
    // 还没有 agent 侧会话（新建后尚未发过消息）：没有历史可回放，直接结束
    if (!req.acpSessionId) {
      setTimeout(() => this.emitEvent(requestId, { type: 'finish', finishReason: 'done' }), 0)
      return { requestId }
    }

    this.loadRequests.set(req.conversationId, requestId)
    this.requestTargets.set(requestId, { conversationId: req.conversationId })
    void this.runLoad(requestId, workspace, req.conversationId, acpAgent, req.acpSessionId, req.modelId)
    return { requestId }
  }

  private async runLoad(
    requestId: string,
    workspace: AgentWorkspace,
    conversationId: string,
    acpAgent: AcpAgentConfig,
    acpSessionId: string,
    modelId?: string
  ): Promise<void> {
    try {
      // allowNewOnUnsupportedLoad = false：回放历史失败就报错，不许把绑定换成新会话
      const ws = await this.ensureSession(
        workspace,
        conversationId,
        acpAgent,
        acpSessionId,
        modelId,
        false
      )
      const ctx = ws.ctx
      if (!ctx) throw new Error('ACP 会话未就绪')
      await this.applyModel(ws, modelId, true)
      const assembler = new HistoryAssembler()
      // 回放期间也可能带 `usage_update`（回放完 agent 会报一次上下文水位）——
      // 装配器不认识它，所以这里照常用 toStreamEvent 捡出水位那条转发出去（其余照旧只进装配器）
      ws.updateSink = (update) => {
        pushHistoryUpdate(assembler, update)
        const event = toStreamEvent(update)
        if (event?.type === 'context-usage') this.emitEvent(requestId, event)
      }
      // session/load 的响应在回放完之后才返回，所以这里拿到响应即回放完毕
      await ctx.request(acp.methods.agent.session.load, {
        sessionId: acpSessionId,
        cwd: workspace.path,
        mcpServers: []
      })
      ws.updateSink = null
      this.emitEvent(requestId, { type: 'history', messages: assembler.finish() })
      this.emitEvent(requestId, { type: 'finish', finishReason: 'done' })
    } catch (err) {
      console.error('[acp-agent] load error', requestId, describeError(err))
      this.emitEvent(requestId, {
        type: 'error',
        message: `无法加载该会话的历史：${describeError(err)}`
      })
      this.emitEvent(requestId, { type: 'finish', finishReason: 'error' })
    } finally {
      const ws = this.sessions.get(conversationId)
      if (ws) ws.updateSink = null
      this.loadRequests.delete(conversationId)
      this.requestTargets.delete(requestId)
    }
  }

  /** 按 id 找 ACP agent 配置（会话绑定的那个） */
  private resolveAgent(acpAgentId?: string): AcpAgentConfig | undefined {
    if (!acpAgentId) return undefined
    return storage.getAiSettings().acpAgents?.find((a) => a.id === acpAgentId)
  }

  // ---------------------------------------------------------------- 连接与会话

  /**
   * 懒创建 / 复用会话的常驻连接。
   *
   * - 已有连接且 agent / 会话 id 都对得上 → 直接复用（模型变化不重建，见 applyModel）；
   * - 传了 `acpSessionId`（导入的会话）→ `session/load` 重新接上它；
   * - 没传 → `session/new` 建一个新会话，并把新 sessionId 广播回渲染端落盘。
   */
  private async ensureSession(
    workspace: AgentWorkspace,
    conversationId: string,
    acpAgent: AcpAgentConfig,
    acpSessionId?: string,
    modelId?: string,
    /**
     * agent 不支持 `session/load` 而会话又带着 acpSessionId 时，是否允许**退回新建会话**。
     *
     * - 提问（runTurn）：true —— 那条导入的会话在本连接里无法激活，只能新建一个继续干活
     *   （agent 侧会回填新的 sessionId，历史随之看不到了）；
     * - 回放历史（runLoad）：false —— **不许**为了「看历史」把绑定悄悄换掉，
     *   直接报错让用户知道这个 agent 不支持加载历史。
     */
    allowNewOnUnsupportedLoad = true
  ): Promise<ConversationAcpSession> {
    const existing = this.sessions.get(conversationId)
    if (existing) {
      const alive = !existing.closed && existing.proc.exitCode === null
      const sameAgent = existing.acpAgentId === acpAgent.id
      /**
       * 会话 id 对得上才算同一条。⚠️ `acpSessionId` **没给**时（新建会话的第一条消息与
       * `prepare` 并发：连接已经建好、渲染端还没把 id 落盘）按「复用已建好的那条」处理 ——
       * 否则会白白拆掉连接重建一个会话（agent 侧那个空会话就成孤儿了）。
       */
      const sameSession =
        acpSessionId === undefined
          ? existing.sessionId !== null
          : existing.sessionId === acpSessionId
      if (alive && sameAgent && sameSession) return existing
      this.teardown(conversationId)
    }

    const ws = this.createSession(
      workspace,
      conversationId,
      acpAgent,
      acpSessionId,
      allowNewOnUnsupportedLoad
    )
    this.sessions.set(conversationId, ws)
    try {
      await ws.sessionReady
      this.broadcastState(ws)
      return ws
    } catch (err) {
      this.teardown(conversationId)
      throw err
    }
  }

  /** 把会话状态（agent 侧 id + 它广告出来的配置项）广播给渲染端，让本地会话记录跟上 */
  private broadcastState(ws: ConversationAcpSession): void {
    if (!ws.sessionId || ws.stateBroadcast) return
    ws.stateBroadcast = true
    // 会话 id 已有归属（落盘 / 至少被渲染端记账）后才不再重发，配置项变化仍会重新广播
    const state: AcpConversationState = {
      conversationId: ws.conversationId,
      acpSessionId: ws.sessionId,
      canLoad: ws.canLoad,
      models: ws.modelOption,
      configOptions: ws.configOptions
    }
    this.emit('acp-state', state)
  }

  private createSession(
    workspace: AgentWorkspace,
    conversationId: string,
    acpAgent: AcpAgentConfig,
    acpSessionId?: string,
    allowNewOnUnsupportedLoad = true
  ): ConversationAcpSession {
    let closeConnection: () => void = () => {}
    let resolveSession!: () => void
    let rejectSession!: (err: unknown) => void
    const sessionReady = new Promise<void>((resolve, reject) => {
      resolveSession = resolve
      rejectSession = reject
    })
    const ws: ConversationAcpSession = {
      conversationId,
      workspaceName: workspace.name,
      acpAgentId: acpAgent.id,
      sessionId: null,
      proc: spawnAgentProcess(acpAgent, workspace.path),
      connection: Promise.resolve(),
      sessionReady,
      ctx: null,
      updateSink: null,
      currentRequestId: null,
      availableModes: [],
      defaultModeId: null,
      appliedModeId: null,
      canLoad: false,
      modelOption: null,
      configOptions: [],
      draftIdleTimer: null,
      closeConnection: () => {},
      cancelFallback: null,
      stateBroadcast: false,
      closed: false
    }
    ws.closeConnection = () => {
      if (ws.closed) return
      ws.closed = true
      closeConnection()
    }

    const proc = ws.proc
    proc.stderr?.on('data', (chunk: Buffer) => {
      // agent 的 stderr 只做旁路记录，不进会话事件流
      process.stderr.write(`[acp-agent] ${chunk.toString()}`)
    })
    proc.on('error', (err) => {
      rejectSession(err)
    })
    proc.on('exit', (code) => {
      ws.closed = true
      if (ws.draftIdleTimer) {
        clearTimeout(ws.draftIdleTimer)
        ws.draftIdleTimer = null
      }
      ws.closeConnection()
      // 进程没了 → sessionReady 必须落定。否则 `ensureSession` 里的
      // `await ws.sessionReady` 会永远悬着（详见下面 .catch 的注释）。
      rejectSession(new Error(`ACP agent 已退出（code=${code ?? 'unknown'}）`))
      if (this.sessions.get(conversationId) === ws) {
        this.sessions.delete(conversationId)
        if (!this.abortedRequests.size) {
          // 非主动中止的意外退出：把仍在等待的用户请求标记为失败
          this.failActiveTurns(conversationId, `ACP agent 已退出（code=${code ?? 'unknown'}）`)
        }
      }
    })

    const input = Writable.toWeb(proc.stdin!)
    const output = Readable.toWeb(proc.stdout!)
    const stream = acp.ndJsonStream(input, output)

    const app2 = acp
      .client({ name: 'Dogi' })
      .onRequest(acp.methods.client.session.requestPermission, (ctx) =>
        this.handlePermission(ws, ctx.params)
      )
      // agent 借客户端读写文件（opencode 等都会请求）：不实现这两个 handler，agent 侧
      // 收到的是 "Method not found"，那一轮工具调用直接失败。
      .onRequest(acp.methods.client.fs.readTextFile, async (ctx) => {
        const { path, line, limit } = ctx.params
        return { content: await readWorkspaceTextFile(workspace.path, path, line, limit) }
      })
      .onRequest(acp.methods.client.fs.writeTextFile, async (ctx) => {
        await writeWorkspaceTextFile(workspace.path, ctx.params.path, ctx.params.content)
        return {}
      })
      // `session/update` 是 agent 推给客户端的通知：按 sessionId 分派给本会话的接收器
      .onNotification(acp.methods.client.session.update, (ctx) => {
        if (ctx.params.sessionId !== ws.sessionId) return
        ws.updateSink?.(ctx.params.update)
      })

    ws.connection = app2
      .connectWith(stream, async (ctx) => {
        ws.ctx = ctx
        const init = await ctx.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          // fs 能力要在握手时广告，agent 才会发 fs/read_text_file / fs/write_text_file
          // （两个 handler 见上面 client() 的 onRequest）
          clientCapabilities: {
            session: {},
            fs: { readTextFile: true, writeTextFile: true }
          },
          clientInfo: { name: 'Dogi', version: app.getVersion() }
        })
        ws.canLoad = init.agentCapabilities?.loadSession === true

        // ---- 接上已有会话（导入的）或新建一个 ----
        if (acpSessionId && !ws.canLoad && !allowNewOnUnsupportedLoad) {
          // 只是要回放历史：绝不为了「看一眼历史」把绑定悄悄换掉
          throw new Error(
            '该 ACP agent 不支持加载已有会话（未声明 loadSession），无法回放历史'
          )
        }
        if (acpSessionId && !ws.canLoad) {
          /**
           * agent 不支持 `session/load`：导入的 sessionId 在本连接里**无法激活**
           * （`session/prompt` 只认本连接建过 / 载入过的会话）。此时降级为新建一个会话，
           * 把新的 id 广播回渲染端重绑 —— 代价是那段历史看不到，只能看后续输出。
           */
          console.error('[acp-agent] agent 不支持 session/load，改用新会话（原历史不可回放）')
          const created = await ctx.request(acp.methods.agent.session.new, {
            cwd: workspace.path,
            mcpServers: []
          })
          this.applySessionResponse(ws, created.sessionId, created.modes, created.configOptions)
        } else if (acpSessionId) {
          const loaded = await ctx.request(acp.methods.agent.session.load, {
            sessionId: acpSessionId,
            cwd: workspace.path,
            mcpServers: []
          })
          this.applySessionResponse(ws, acpSessionId, loaded.modes, loaded.configOptions)
        } else {
          const created = await ctx.request(acp.methods.agent.session.new, {
            cwd: workspace.path,
            mcpServers: []
          })
          this.applySessionResponse(ws, created.sessionId, created.modes, created.configOptions)
        }

        // 启动链路只留这一条汇总（原来每步各打一行，dev 终端每开一个会话都刷一屏）；
        // 出错路径仍各自单独打。
        console.error(
          `[acp-agent] 会话就绪 session=${ws.sessionId}` +
            (ws.modelOption ? ` model=${ws.modelOption.currentValue}` : '') +
            ` 档位=${ws.defaultModeId ?? '无'}（可选 ${ws.availableModes.length ? ws.availableModes.map((m) => m.id).join('/') : '无'}）`
        )
        resolveSession()
        await new Promise<void>((resolve) => {
          closeConnection = resolve
        })
      })
      .catch((err) => {
        /**
         * 连接关闭（进程退出 / 主动 teardown / 启动失败）。
         *
         * ⚠️ 这里**必须**无条件把 sessionReady 落定，不能因为「是主动 teardown」就跳过：
         * `teardown()` 会先把 `ws.closed` 置 true，而 `connecting` 期间 `closeConnection`
         * 还是空函数（它要等 resolveSession 之后才被赋值）。原来写成 `if (!ws.closed) reject`，
         * 于是「连接还没建好时用户点停止」这条路**两个条件都不成立** —— resolve 没发生、
         * reject 被跳过，`await ws.sessionReady` 永久悬着：runTurn 既不产出事件也不报错，
         * 界面就一直卡在「正在思考…」（用户实测；进程其实已经杀了，什么都不在跑）。
         *
         * 已经 resolve 过时再 reject 是空操作，不会误伤正常轮次。
         */
        console.error('[acp-agent] connection closed', describeError(err))
        rejectSession(err instanceof Error ? err : new Error(describeError(err)))
      })
    return ws
  }

  /** 把 session/new | session/load 的结果落到会话上（id / 档位 / 配置项） */
  private applySessionResponse(
    ws: ConversationAcpSession,
    sessionId: string,
    modes: { currentModeId: string; availableModes: SessionMode[] } | null | undefined,
    configOptions: Array<unknown> | null | undefined
  ): void {
    ws.sessionId = sessionId
    ws.availableModes = modes?.availableModes ?? []
    ws.defaultModeId = modes?.currentModeId ?? null
    ws.appliedModeId = ws.defaultModeId
    ws.modelOption = extractModelOption(configOptions)
    ws.configOptions = extractConfigOptions(configOptions)
    /**
     * 有些 agent 把「档位」也表达成 `category: 'mode'` 的配置项而不是 `modes`（协议里
     * 两者都合法）。权限模式要能切档（见 pickModeId），所以把这类选项也并进 availableModes
     * —— 否则这类 agent 上「需确认 / 自动执行」永远切不动。
     */
    this.mergeModeConfigOptions(ws)
    this.armDraftIdleTimer(ws)
  }

  /** 把 `category: 'mode'` 的配置项并进 availableModes（幂等，可重复调用） */
  private mergeModeConfigOptions(ws: ConversationAcpSession): void {
    for (const opt of ws.configOptions) {
      if (opt.category !== 'mode' || opt.type !== 'select') continue
      if (ws.availableModes.some((m) => m.id === opt.currentValue)) continue
      ws.availableModes = [
        ...ws.availableModes,
        ...opt.options.map((o) => ({ id: o.value, name: o.name }))
      ]
      if (!ws.defaultModeId && typeof opt.currentValue === 'string') {
        ws.defaultModeId = opt.currentValue
        ws.appliedModeId = opt.currentValue
      }
    }
  }

  /**
   * 给「还没发过消息」的连接挂上兜底回收定时器（见 DRAFT_IDLE_TTL_MS）。
   *
   * 只在**渲染端还没落盘 acpSessionId** 的窗口期有价值：一旦 id 落盘（真会话了）就清掉，
   * 之后由删除会话 / 应用退出负责收尾。
   */
  private armDraftIdleTimer(ws: ConversationAcpSession): void {
    if (ws.draftIdleTimer) {
      clearTimeout(ws.draftIdleTimer)
      ws.draftIdleTimer = null
    }
    if (!ws.sessionId) return
    if (storage.getAgentConversation(ws.conversationId)?.acpSessionId) return
    ws.draftIdleTimer = setTimeout(() => {
      ws.draftIdleTimer = null
      // 期间用户可能已经发出第一条消息（id 落盘了），那就不是孤儿、留着继续用
      if (storage.getAgentConversation(ws.conversationId)?.acpSessionId) return
      console.error('[acp-agent] 新建会话长时间未使用，回收 agent 连接', ws.conversationId)
      this.teardown(ws.conversationId)
    }, DRAFT_IDLE_TTL_MS)
  }

  /** agent 主动更新了 configOptions（如自己换了模型 / 思考档位）：刷新本地记录并同步渲染端 */
  private onConfigOptionUpdate(
    ws: ConversationAcpSession,
    update: SessionUpdate
  ): void {
    const configOptions = (update as { configOptions?: Array<unknown> }).configOptions
    const next = extractConfigOptions(configOptions)
    // 协议说这是一次「全量」下发，但拿到空数组时按脏数据处理：什么都不改，
    // 免得一次异常把这一整组开关从会话页抹光（下一轮 `config_option_update` 会补回来）。
    if (next.length === 0) return
    ws.configOptions = next
    ws.modelOption = next.find((o) => o.category === 'model' && o.type === 'select')
      ? extractModelOption(configOptions)
      : ws.modelOption
    this.mergeModeConfigOptions(ws)
    ws.stateBroadcast = false
    this.broadcastState(ws)
  }

  /** 移除会话的常驻连接：杀进程并触发 connectWith 返回 */
  private teardown(conversationId: string): void {
    const ws = this.sessions.get(conversationId)
    if (!ws) return
    this.sessions.delete(conversationId)
    if (ws.cancelFallback) clearTimeout(ws.cancelFallback)
    if (ws.draftIdleTimer) clearTimeout(ws.draftIdleTimer)
    killProcessTree(ws.proc)
    ws.closeConnection()
    if (ws.currentRequestId) this.abortedRequests.add(ws.currentRequestId)
  }

  /** 会话的连接意外断开时，把正在进行的 turn 标记为失败 */
  private failActiveTurns(conversationId: string, message: string): void {
    for (const [requestId, target] of this.requestTargets) {
      if (target.conversationId !== conversationId) continue
      this.emitEvent(requestId, { type: 'error', message })
      this.emitEvent(requestId, { type: 'finish', finishReason: 'error' })
    }
  }

  /**
   * 把应用的权限模式映射到 agent 自己广告的档位（ACP Session Modes）。
   *
   * 为什么需要它：**协议不支持「客户端强制 agent 必须来问」**（`ClientCapabilities` 里
   * 没有权限相关能力位，也没有强制审批的方法）—— 问不问由 agent 自己的策略决定。
   * 所以「需确认」对 ACP agent 的唯一强制手段，就是切到它自己语义等价的那个档位
   * （如 opencode 的 plan / 各种「需审批」档）；agent 没广告档位就什么都不做 ——
   * 绝不假装拦住了，真正的兜底是 handlePermission：它来问就照样弹确认卡。
   */
  private pickModeId(ws: ConversationAcpSession, mode: AiPermissionMode): string | null {
    if (!ws.availableModes.length) return null
    const describe = (m: SessionMode): string => `${m.id} ${m.name} ${m.description ?? ''}`
    if (mode === 'full') {
      /**
       * 自动执行：优先找 agent 里那个「完全不问」的档（bypassPermissions / full-auto / yolo…）。
       * 找不到再用会话建立时的默认档 —— 多数 agent 的默认档就是「不打扰」，但也有 agent
       * 一上来停在 plan 这类保守档上，沿用默认会把「自动执行」变成「什么都不能干」。
       */
      const permissive = ws.availableModes.find((m) =>
        /bypass|full[-\s_]?auto|yolo|auto[-\s_]?accept|完全|自动/i.test(describe(m))
      )
      return permissive?.id ?? ws.defaultModeId
    }
    const hit = ws.availableModes.find((m) =>
      /ask|confirm|approv|审批|确认|supervised/i.test(describe(m))
    )
    if (hit) return hit.id
    /**
     * ⚠️ 没匹配到具名档位时**回落到会话默认档**，而不是「不动」：很多 agent 的「先问再做」
     * 档就叫 default / build 之类，模式匹配永远打不中 —— 返回 null 会让档位停在上一轮切过去
     * 的那个（用户看到的就是「切权限模式不生效」）。默认档基本都是「先问」语义，回落是对的。
     */
    return ws.defaultModeId
  }

  /** 每轮提问前把当前权限模式下发到 agent 档位；agent 不支持 / 切不动只记日志，不打断这一轮 */
  private async applyPermissionMode(ws: ConversationAcpSession): Promise<void> {
    /**
     * ⚠️ `readonly` 与 `confirm` 走同一条路（切到 agent 的「先问」档）——
     * 若把 readonly 映射成「不问」档，agent 会自己就把动作做了、我们连权限请求都收不到，
     * 只读就形同虚设。真正的拒绝在 `handlePermission` 的 readonly 分支。
     */
    const mode: AiPermissionMode = storage.getAiSettings().permissionMode ?? 'full'
    const targetId = this.pickModeId(ws, mode)
    if (!targetId || targetId === ws.appliedModeId || !ws.ctx || !ws.sessionId) return
    try {
      await ws.ctx.request(acp.methods.agent.session.setMode, {
        sessionId: ws.sessionId,
        modeId: targetId
      })
      ws.appliedModeId = targetId
      console.error(`[acp-agent] 档位已切到 ${targetId}（权限模式：${mode}）`)
    } catch (err) {
      // agent 不支持 / 拒绝切档：只记日志，权限语义仍由 handlePermission 兜底
      console.error('[acp-agent] 切换档位失败', targetId, describeError(err))
    }
  }

  /**
   * 下发一个会话配置项（`session/set_config_option`），**不重建会话** ——
   * 重建会丢 agent 侧上下文。模型只是其中一项（见 `applyModel`）。
   *
   * agent 不上报这一项 / 值没变 / 切不动时按 `silent` 决定：静默记日志还是抛出去。
   */
  private async applyConfigOption(
    ws: ConversationAcpSession,
    optionId: string,
    value: string | boolean,
    silent = false
  ): Promise<void> {
    const option = ws.configOptions.find((o) => o.id === optionId)
    if (!option || !ws.ctx || !ws.sessionId) return
    if (option.currentValue === value) return
    try {
      await ws.ctx.request(acp.methods.agent.session.setConfigOption, {
        sessionId: ws.sessionId,
        configId: optionId,
        value
      })
      ws.configOptions = ws.configOptions.map((o) =>
        o.id === optionId ? { ...o, currentValue: value } : o
      )
      // 模型项的镜像同步更新（会话页的模型下拉据此显示「已经在用哪个」）
      if (ws.modelOption && ws.modelOption.optionId === optionId && typeof value === 'string') {
        ws.modelOption = { ...ws.modelOption, currentValue: value }
      }
      if (typeof value === 'string' && option.category === 'mode') ws.appliedModeId = value
      ws.stateBroadcast = false
      this.broadcastState(ws)
    } catch (err) {
      if (!silent) throw err
      console.error('[acp-agent] 切换配置项失败', optionId, String(value), describeError(err))
    }
  }

  /** 把会话选中的模型下发到 agent；会话页的模型下拉走它 */
  private async applyModel(
    ws: ConversationAcpSession,
    modelId: string | undefined,
    silent = false
  ): Promise<void> {
    const option = ws.modelOption
    if (!modelId || !option) return
    await this.applyConfigOption(ws, option.optionId, modelId, silent)
  }

  /** 渲染端在下拉里切换某个 ACP 会话的模型：立即下发到 agent（会话 id / 模型已由渲染端落盘） */
  async setModel(conversationId: string, modelId: string | undefined): Promise<void> {
    const ws = this.sessions.get(conversationId)
    // 会话还没连上（没打开过 / 没发过消息）不必报错：模型 id 已落盘，
    // 真正建会话时 `ensureSession` 之后的 applyModel 会一并下发
    if (!ws || !ws.ctx) return
    await this.applyModel(ws, modelId)
  }

  /**
   * 渲染端切换 agent 广告出来的**任意**配置项（模型之外的思考档位 / 开关等）。
   *
   * 会话还没连上时静默跳过：那一次的选择可以由调用方重发时带上，
   * 真建好会话时 `ensureSession` 之后的 `applyConfigOption` 会补下发。
   */
  async setConfigOption(
    conversationId: string,
    optionId: string,
    value: string | boolean
  ): Promise<void> {
    const ws = this.sessions.get(conversationId)
    if (!ws || !ws.ctx) return
    await this.applyConfigOption(ws, optionId, value)
  }

  /**
   * **创建会话时**就建好 agent 侧的会话（`session/new`），把 agent 广告的配置项取回来。
   *
   * 为什么不是等第一条消息：形态在创建时就选了，打开会话页就该能看到「这个 agent
   * 有哪些开关、当前各是什么」，而不是发完第一条才冒出来。
   *
   * 与 `load` 不同：这里**不需要回放历史**（本来就是空的），所以直接复用常驻连接
   * （`ensureSession` 会把 agent 侧会话 id 广播回渲染端落盘）。
   */
  async prepare(payload: {
    workspaceId?: string
    conversationId: string
    acpAgentId?: string
    modelId?: string
  }): Promise<{ acpSessionId?: string }> {
    const workspace = payload.workspaceId
      ? storage.getAgentWorkspace(payload.workspaceId)
      : undefined
    const acpAgent = this.resolveAgent(payload.acpAgentId)
    if (!workspace || !acpAgent) return {}
    // 已经有会话了（发过消息 / 已 import）：别重建，只把当前状态再广播一次
    if (this.sessions.has(payload.conversationId)) {
      const ws = this.sessions.get(payload.conversationId)!
      ws.stateBroadcast = false
      this.broadcastState(ws)
      return { acpSessionId: ws.sessionId ?? undefined }
    }
    try {
      const ws = await this.ensureSession(
        workspace,
        payload.conversationId,
        acpAgent,
        undefined,
        payload.modelId
      )
      // 会话建好就把它选的模型摆正（agent 的默认值未必是用户在这一栏选的那个）
      await this.applyModel(ws, payload.modelId, true)
      return { acpSessionId: ws.sessionId ?? undefined }
    } catch (err) {
      // 建不起来不是致命错误：这个会话页照样能打开，发第一条消息时会再试一次
      console.error('[acp-agent] 准备会话失败', payload.conversationId, describeError(err))
      return {}
    }
  }

  /** 会话被删 / 标签关闭时的收尾：干掉它那条常驻 agent 连接（否则进程变孤儿） */
  disposeConversation(conversationId: string): void {
    if (this.loadRequests.has(conversationId)) this.loadRequests.delete(conversationId)
    this.teardown(conversationId)
  }

  /** ACP 权限请求：full 模式自动放行，confirm 模式弹确认卡 */
  private async handlePermission(
    ws: ConversationAcpSession,
    params: RequestPermissionRequest
  ): Promise<RequestPermissionResponse> {
    const { toolCall, options } = params
    // 收到权限请求就记一笔：full 模式是静默放行的，不记日志会让人误以为「agent 从不来问」。
    // 这行是诊断用的，grep '[acp-agent] 收到权限请求' 就能确认某 agent（含 pi-acp）到底发不发请求。
    console.error(
      `[acp-agent] 收到权限请求 tool=${toolCall.title ?? toolCall.toolCallId}` +
        ` options=[${options.map((o) => o.kind).join(', ')}]`
    )
    const settings = storage.getAiSettings()
    const requestId = ws.currentRequestId

    /**
     * ⚠️ 只按 kind 精确取，**不做「取不到就退 options[0]」的兜底**：option 的 kind 是 agent
     * 给的语义，`options[0]` 完全可能是 allow —— 在用户点了「拒绝」之后挑到它，等于把用户的
     * 拒绝**静默反转**成放行。取不到就回 cancelled，让 agent 自己收手。
     */
    const pick = (kind: string): string | undefined =>
      options.find((o) => o.kind === kind)?.optionId
    const selected = (optionId?: string): RequestPermissionResponse =>
      optionId
        ? { outcome: { outcome: 'selected', optionId } }
        : { outcome: { outcome: 'cancelled' } }

    // 只读模式：一律拒绝（不弹卡）—— 与内置工具的 guardWrite 同一档语义
    if (settings.permissionMode === 'readonly') {
      return selected(pick('reject_once') ?? pick('reject_always'))
    }
    if (settings.permissionMode !== 'confirm') {
      // 自动执行：直接放行（优先 allow_always，让 agent 后续不再逐次询问）
      return selected(pick('allow_always') ?? pick('allow_once'))
    }

    // 确认卡：可用档位按 agent 广告的 kind 收窄（它没给 allow_always 就不显示「总是允许」）
    const decision: ConfirmDecision = requestId
      ? await this.requestConfirm(
          ws.workspaceName,
          confirmOptionsFromAcpKinds(options.map((o) => o.kind)),
          {
            requestId,
            toolCallId: toolCall.toolCallId,
            toolName: toolCall.title ?? 'tool',
            command: toolCall.title ?? ''
          }
        )
      : 'reject_once'
    /**
     * 裁决 → ACP option。⚠️ 只在**同类**里兜底（allow 退回 allow、reject 退回 reject）——
     * 绝不跨类兜底：那会在用户点了「拒绝」之后挑到一个 allow 档，把拒绝静默反转成放行
     * （这也是上面 `pick` 刻意不兜 `options[0]` 的原因）。
     */
    switch (decision) {
      case 'allow_once':
        return selected(pick('allow_once') ?? pick('allow_always'))
      case 'allow_always':
        return selected(pick('allow_always') ?? pick('allow_once'))
      case 'reject_always':
        return selected(pick('reject_always') ?? pick('reject_once'))
      default:
        return selected(pick('reject_once') ?? pick('reject_always'))
    }
  }

  /**
   * 中止当前回合。
   *
   * 优先用协议自带的 `session/cancel`（只停这一轮，**agent 侧会话与上下文都保留**）；
   * agent 迟迟不理会时再强断连接（会话可能因此失效，但总比一直卡着强）。
   */
  abort(requestId: string): void {
    this.clearPendingConfirms(requestId)
    const target = this.requestTargets.get(requestId)
    if (!target) return
    this.abortedRequests.add(requestId)
    const ws = this.sessions.get(target.conversationId)
    if (!ws) return
    if (!ws.ctx || !ws.sessionId) {
      this.teardown(target.conversationId)
      return
    }
    void ws.ctx
      .notify(acp.methods.agent.session.cancel, { sessionId: ws.sessionId })
      .catch(() => undefined)
    if (ws.cancelFallback) clearTimeout(ws.cancelFallback)
    ws.cancelFallback = setTimeout(() => {
      ws.cancelFallback = null
      this.abortedRequests.add(requestId)
      this.teardown(target.conversationId)
    }, CANCEL_FALLBACK_MS)
  }

  /** 应用退出时清理所有常驻 agent 进程 */
  dispose(): void {
    for (const conversationId of [...this.sessions.keys()]) {
      this.teardown(conversationId)
    }
  }

  private emitEvent(requestId: string, event: AgentStreamEvent): void {
    this.emit('chat-event', requestId, event)
  }
}

/** 取 history 中最后一条用户文本（ACP 会话保留上下文，每轮只发新输入） */
function lastUserText(history: AgentChatRequest['history']): string {
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i]
    if (msg.role !== 'user') continue
    const text = msg.parts
      .filter((p) => p.type === 'text')
      .map((p) => (p.type === 'text' ? p.text : ''))
      .join('')
      .trim()
    if (text) return text
  }
  return ''
}

export const acpAgentService = new AcpAgentService()
