/**
 * ACP（Agent Client Protocol）Agent 服务。
 *
 * 应用作为 ACP 客户端，spawn 一个外部 ACP agent（如 codex-acp）并通过 stdio 通信，
 * 把 agent 的事件流映射为应用既有的 AgentStreamEvent，权限请求映射为确认卡。
 *
 * 会话模型：每个工作区一个常驻连接 + 一个 ACP 会话（session/new 后多次 prompt），
 * 这样多轮对话的上下文由 agent 侧自己保留；停止生成（abort）会杀掉子进程，
 * 下次提问时自动重建连接（上下文随之丢失）。
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
  ActiveSession,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionUpdate
} from '@agentclientprotocol/sdk'
import type {
  AcpAgentConfig,
  AgentChatRequest,
  AgentStreamEvent,
  AgentWorkspace
} from '@shared/types'
import { storage } from '../storage'
import type { AgentConfirmSink } from './agent'

/** 确认模式下等待用户响应的最长时间，超时按「取消」处理 */
const CONFIRM_TIMEOUT_MS = 10 * 60 * 1000

/** agent 上报的模型列表（configOptions 里 category=model 的下拉项） */
export interface AcpModelList {
  /** 该模型选择项的 configOption id（会话内切换时回传 set_config_option 用） */
  optionId: string
  /** agent 当前选中的模型 value */
  currentValue: string
  models: Array<{ value: string; name: string }>
}

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
  const resolved = resolveWindowsCommand(cfg.command)
  if (resolved.viaCmd) {
    return spawn('cmd.exe', ['/c', resolved.command, ...args], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })
  }
  return spawn(resolved.command, args, {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
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

interface PendingConfirm {
  requestId: string
  resolve: (approved: boolean) => void
  timer: ReturnType<typeof setTimeout>
}

/**
 * 一个**会话**的常驻 ACP 连接与会话。
 *
 * 按 conversationId 而不是 workspaceId 缓存：同一个工作区下的多个会话必须各有
 * 独立的 agent 上下文，共用一个连接会让两个会话互相串味。
 */
interface ConversationAcpSession {
  workspaceId: string
  conversationId: string
  workspaceName: string
  proc: ChildProcess
  /** connectWith 的连接生命周期 promise（op 挂起直到连接关闭） */
  connection: Promise<unknown>
  /** session/new 完成后的 ActiveSession；失败时 reject */
  sessionReady: Promise<ActiveSession>
  /** 正在进行的 turn 绑定的 requestId（权限确认卡回填用） */
  currentRequestId: string | null
  /** 会话创建时应用的模型 id（agent 上报的 configOptions value）；null = 用 agent 默认 */
  desiredModelId: string | null
  /** 通知连接关闭，让 connectWith 的 op 返回 */
  closeConnection: () => void
  closed: boolean
}

/** 工具调用卡片的展示名：ACP 只保证 title，name 是可选的程序化名称 */
function toolLabelOf(update: SessionUpdate): string {
  if (update.sessionUpdate === 'tool_call') {
    return update.name ?? update.title ?? 'tool'
  }
  if (update.sessionUpdate === 'tool_call_update') {
    return update.title ?? 'tool'
  }
  return 'tool'
}

/** 把 ACP 会话更新映射为应用的流事件 */
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
        input: update.rawInput ?? {}
      }
    case 'tool_call_update': {
      if (update.status !== 'completed' && update.status !== 'failed') return null
      const output = update.rawOutput ?? {}
      return {
        type: 'tool-result',
        toolCallId: update.toolCallId,
        toolName: toolLabelOf(update),
        output,
        isError: update.status === 'failed'
      }
    }
    default:
      // plan / agent_thought_chunk / usage_update 等：现有 UI 没有对应形态，忽略
      return null
  }
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
  private requestTargets = new Map<string, { workspaceId: string; conversationId: string }>()

  setConfirmSink(sink: AgentConfirmSink | null): void {
    this.confirmSink = sink
  }

  resolveConfirm(id: string, approved: boolean): void {
    const pending = this.pendingConfirms.get(id)
    if (!pending) return
    clearTimeout(pending.timer)
    pending.resolve(approved)
  }

  private clearPendingConfirms(requestId?: string): void {
    for (const pending of this.pendingConfirms.values()) {
      if (requestId && pending.requestId !== requestId) continue
      clearTimeout(pending.timer)
      pending.resolve(false)
    }
  }

  private requestConfirm(
    workspaceName: string,
    req: { requestId: string; toolCallId: string; toolName: string; command: string }
  ): Promise<boolean> {
    const sink = this.confirmSink
    if (!sink) return Promise.resolve(true)
    const result = this.confirmChain.then(() => this.doRequestConfirm(workspaceName, req, sink))
    this.confirmChain = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  private doRequestConfirm(
    workspaceName: string,
    req: { requestId: string; toolCallId: string; toolName: string; command: string },
    sink: AgentConfirmSink
  ): Promise<boolean> {
    const id = randomUUID()
    return new Promise<boolean>((resolve) => {
      const settle = (approved: boolean) => {
        this.pendingConfirms.delete(id)
        sink.resolved(id)
        resolve(approved)
      }
      const timer = setTimeout(() => settle(false), CONFIRM_TIMEOUT_MS)
      this.pendingConfirms.set(id, { requestId: req.requestId, resolve: settle, timer })
      sink.request({
        id,
        requestId: req.requestId,
        toolCallId: req.toolCallId,
        toolName: req.toolName,
        command: req.command,
        workspaceName
      })
    })
  }

  async chat(req: AgentChatRequest): Promise<{ requestId: string }> {
    const requestId = randomUUID()
    const workspace = storage.getAgentWorkspace(req.workspaceId)
    const settings = storage.getAiSettings()
    // 预定义列表 + 本次会话选中的项解析出要用的 agent 配置。
    // 会话自己选过就优先用它（`req.configId` 在 ACP 后端下存的是预置 id），
    // 没选过才回退到全局的 activeAcpId —— 切一个会话的 agent 不影响别的会话。
    const acpAgent =
      (req.configId ? settings.acpAgents?.find((a) => a.id === req.configId) : undefined) ??
      settings.acpAgents?.find((a) => a.id === settings.activeAcpId) ??
      settings.acpAgents?.[0]

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
    if (!acpAgent?.command) {
      fail('尚未配置 ACP agent，请先在设置中配置 agent 启动命令')
      return { requestId }
    }

    const text = lastUserText(req.history)
    if (!text) {
      fail('没有可发送的内容')
      return { requestId }
    }

    const conversationId = req.conversationId
    this.requestTargets.set(requestId, { workspaceId: workspace.id, conversationId })
    const chain = (this.turnChains.get(conversationId) ?? Promise.resolve()).then(() =>
      this.runTurn(requestId, workspace, conversationId, acpAgent, text, req.modelId)
    )
    this.turnChains.set(
      conversationId,
      chain.catch(() => undefined)
    )
    return { requestId }
  }

  /** 取历史中最后一条用户文本（本轮 prompt 内容） */
  private async runTurn(
    requestId: string,
    workspace: AgentWorkspace,
    conversationId: string,
    acpAgent: AcpAgentConfig,
    text: string,
    modelId?: string
  ): Promise<void> {
    console.error('[acp-agent] runTurn start', requestId, conversationId)
    try {
      const session = await this.ensureSession(workspace, conversationId, acpAgent, modelId)
      console.error('[acp-agent] session ready', session.sessionId)
      const ws = this.sessions.get(conversationId)
      if (ws) ws.currentRequestId = requestId
      // 不 await prompt：会话更新（文本/工具/权限）通过 nextUpdate() 流式消费，
      // prompt 的拒绝同样会经 updates 队列由 nextUpdate() 抛出
      session.prompt(text).catch(() => undefined)
      for (;;) {
        if (this.abortedRequests.has(requestId)) {
          this.emitEvent(requestId, { type: 'finish', finishReason: 'aborted' })
          return
        }
        const message = await session.nextUpdate()
        if (message.kind === 'stop') {
          this.emitEvent(requestId, {
            type: 'finish',
            // ACP 协议里的 stopReason 叫 'cancelled'，但落到我们的事件上统一用 'aborted'
            // （与 ai.ts 的中止语义、渲染端 notifyAgentFinished 的判定对齐，
            //   否则「用户主动停止」会被当成正常完成弹通知）
            finishReason: message.stopReason === 'cancelled' ? 'aborted' : 'done'
          })
          return
        }
        const event = toStreamEvent(message.update)
        if (event) this.emitEvent(requestId, event)
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
      if (ws) ws.currentRequestId = null
    }
  }

  /** 懒创建会话的常驻 ACP 连接；进程已死或模型切换时重建 */
  private async ensureSession(
    workspace: AgentWorkspace,
    conversationId: string,
    acpAgent: AcpAgentConfig,
    modelId?: string
  ): Promise<ActiveSession> {
    const existing = this.sessions.get(conversationId)
    if (existing) {
      const alive = !existing.closed && existing.proc.exitCode === null
      // 模型没变就复用；变了则重建会话并应用新模型（重建会丢 agent 侧上下文，与主流客户端行为一致）
      if (alive && (existing.desiredModelId ?? null) === (modelId ?? null)) {
        return existing.sessionReady
      }
      this.teardown(conversationId)
    }

    const ws = this.createSession(workspace, conversationId, acpAgent, modelId)
    this.sessions.set(conversationId, ws)
    try {
      return await ws.sessionReady
    } catch (err) {
      this.teardown(conversationId)
      throw err
    }
  }

  private createSession(
    workspace: AgentWorkspace,
    conversationId: string,
    acpAgent: AcpAgentConfig,
    modelId?: string
  ): ConversationAcpSession {
    let closeConnection: () => void = () => {}
    let resolveSession!: (s: ActiveSession) => void
    let rejectSession!: (err: unknown) => void
    const sessionReady = new Promise<ActiveSession>((resolve, reject) => {
      resolveSession = resolve
      rejectSession = reject
    })
    const ws: ConversationAcpSession = {
      workspaceId: workspace.id,
      conversationId,
      workspaceName: workspace.name,
      proc: spawnAgentProcess(acpAgent, workspace.path),
      connection: Promise.resolve(),
      sessionReady,
      currentRequestId: null,
      desiredModelId: modelId ?? null,
      closeConnection: () => {},
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

    ws.connection = app2
      .connectWith(stream, async (ctx) => {
        console.error('[acp-agent] connectWith op start')
        await ctx.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: { session: {} },
          clientInfo: { name: 'Dogi', version: app.getVersion() }
        })
        console.error('[acp-agent] initialized')
        const session = await ctx.buildSession(workspace.path).start()
        console.error('[acp-agent] session started', session.sessionId)
        // 会话选了具体模型：在 agent 上报的 configOptions（category=model）里切换。
        // agent 不支持 configOptions 时静默跳过 —— 模型由 agent 自己决定。
        if (modelId) {
          const option = session.newSessionResponse.configOptions?.find(
            (o) => o.type === 'select' && o.category === 'model'
          ) as { id: string; currentValue: string } | undefined
          if (option && option.currentValue !== modelId) {
            try {
              await ctx.request(acp.methods.agent.session.setConfigOption, {
                sessionId: session.sessionId,
                configId: option.id,
                value: modelId
              })
              console.error('[acp-agent] model set to', modelId)
            } catch (err) {
              console.error('[acp-agent] set model failed', describeError(err))
            }
          }
        }
        resolveSession(session)
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

  /** 移除会话的常驻连接：杀进程并触发 connectWith 返回 */
  private teardown(conversationId: string): void {
    const ws = this.sessions.get(conversationId)
    if (!ws) return
    this.sessions.delete(conversationId)
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

  /** ACP 权限请求：full 模式自动放行，confirm 模式弹确认卡 */
  private async handlePermission(
    ws: ConversationAcpSession,
    params: RequestPermissionRequest
  ): Promise<RequestPermissionResponse> {
    const { toolCall, options } = params
    const settings = storage.getAiSettings()
    const requestId = ws.currentRequestId

    const pick = (kind: string): string | undefined => {
      const opt = options.find((o) => o.kind === kind) ?? options[0]
      return opt?.optionId
    }

    if (settings.permissionMode !== 'confirm') {
      // 完全访问：自动允许（优先 allow_always，让 agent 后续不再逐次询问）
      const optionId = pick('allow_always') ?? pick('allow_once')
      if (!optionId) return { outcome: { outcome: 'cancelled' } }
      return { outcome: { outcome: 'selected', optionId } }
    }

    const approved = requestId
      ? await this.requestConfirm(ws.workspaceName, {
          requestId,
          toolCallId: toolCall.toolCallId,
          toolName: toolCall.title ?? 'tool',
          command: toolCall.title ?? ''
        })
      : false
    const optionId = approved ? pick('allow_once') ?? pick('allow_always') : pick('reject_once')
    if (!optionId) return { outcome: { outcome: 'cancelled' } }
    return { outcome: { outcome: 'selected', optionId } }
  }

  /** 中止对话：杀掉该会话的 agent 进程（会话作废，下次自动重建） */
  abort(requestId: string): void {
    this.clearPendingConfirms(requestId)
    const target = this.requestTargets.get(requestId)
    if (!target) return
    this.abortedRequests.add(requestId)
    this.teardown(target.conversationId)
  }

  /**
   * 向 ACP agent 询问可用模型（设置页「拉取模型」用）。
   *
   * 建一条临时连接：initialize → session/new（cwd 用系统临时目录，不影响任何工作区），
   * 从 session/new 响应的 configOptions 里取 category=model 的下拉项，然后杀掉进程。
   * agent 没有上报模型（旧版协议或未实现）时返回 null，由调用方提示。
   */
  async listModels(cfg: AcpAgentConfig): Promise<AcpModelList | null> {
    const cwd = os.tmpdir()
    const proc = spawnAgentProcess(cfg, cwd)
    let closeConnection: () => void = () => {}
    try {
      const result = await new Promise<AcpModelList | null>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error('拉取超时（agent 30 秒内未完成会话创建）'))
        }, 30_000)
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
        const app2 = acp.client({ name: 'Dogi' })
        app2
          .connectWith(stream, async (ctx) => {
            await ctx.request(acp.methods.agent.initialize, {
              protocolVersion: acp.PROTOCOL_VERSION,
              clientCapabilities: { session: {} },
              clientInfo: { name: 'Dogi', version: app.getVersion() }
            })
            const session = await ctx.buildSession(cwd).start()
            const option = session.newSessionResponse.configOptions?.find(
              (o) => o.type === 'select' && o.category === 'model'
            ) as
              | {
                  id: string
                  currentValue: string
                  options: Array<
                    { value: string; name: string } | { options: Array<{ value: string; name: string }> }
                  >
                }
              | undefined
            if (!option) {
              settle(() => resolve(null))
              return
            }
            // options 可能是平铺列表，也可能是分组结构，统一拍平
            const models = option.options.flatMap((o) =>
              'value' in o ? [{ value: o.value, name: o.name }] : o.options
            )
            settle(() => resolve({ optionId: option.id, currentValue: option.currentValue, models }))
            // 会话信息读完即可返回；连接随进程退出关闭
            closeConnection()
          })
          .catch((err) => settle(() => reject(err instanceof Error ? err : new Error(String(err)))))
      })
      return result
    } finally {
      killProcessTree(proc)
      closeConnection()
    }
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
