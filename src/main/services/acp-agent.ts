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
import { storage } from './storage'
import type { AgentConfirmSink } from './agent'

/** 确认模式下等待用户响应的最长时间，超时按「取消」处理 */
const CONFIRM_TIMEOUT_MS = 10 * 60 * 1000

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

/** 命令以 .cmd/.bat 结尾时（Windows npm 脚本），需经 cmd.exe 才能启动 */
function spawnAgentProcess(
  cfg: AcpAgentConfig,
  cwd: string
): ChildProcessWithoutNullStreams {
  const args = cfg.args ?? []
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(cfg.command)) {
    return spawn('cmd.exe', ['/c', cfg.command, ...args], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })
  }
  return spawn(cfg.command, args, {
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

/** 一个工作区的常驻 ACP 连接与会话 */
interface WorkspaceAcpSession {
  workspaceId: string
  workspaceName: string
  proc: ChildProcess
  /** connectWith 的连接生命周期 promise（op 挂起直到连接关闭） */
  connection: Promise<unknown>
  /** session/new 完成后的 ActiveSession；失败时 reject */
  sessionReady: Promise<ActiveSession>
  /** 正在进行的 turn 绑定的 requestId（权限确认卡回填用） */
  currentRequestId: string | null
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
  private sessions = new Map<string, WorkspaceAcpSession>()
  /** 每工作区的 turn 串行链：前一轮结束才启动下一轮 */
  private turnChains = new Map<string, Promise<unknown>>()
  private pendingConfirms = new Map<string, PendingConfirm>()
  /** 确认请求串行链（与 agent.ts 一致） */
  private confirmChain: Promise<unknown> = Promise.resolve()
  private abortedRequests = new Set<string>()
  private requestWorkspaces = new Map<string, string>()

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
    // 预定义列表 + 当前选中项解析出本次使用的 agent 配置
    const acpAgent =
      settings.acpAgents?.find((a) => a.id === settings.activeAcpId) ?? settings.acpAgents?.[0]

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

    this.requestWorkspaces.set(requestId, workspace.id)
    const chain = (this.turnChains.get(workspace.id) ?? Promise.resolve()).then(() =>
      this.runTurn(requestId, workspace, acpAgent, text)
    )
    this.turnChains.set(
      workspace.id,
      chain.catch(() => undefined)
    )
    return { requestId }
  }

  /** 取历史中最后一条用户文本（本轮 prompt 内容） */
  private async runTurn(
    requestId: string,
    workspace: AgentWorkspace,
    acpAgent: AcpAgentConfig,
    text: string
  ): Promise<void> {
    console.error('[acp-agent] runTurn start', requestId, workspace.id)
    try {
      const session = await this.ensureSession(workspace, acpAgent)
      console.error('[acp-agent] session ready', session.sessionId)
      const ws = this.sessions.get(workspace.id)
      if (ws) ws.currentRequestId = requestId
      // 不 await prompt：会话更新（文本/工具/权限）通过 nextUpdate() 流式消费，
      // prompt 的拒绝同样会经 updates 队列由 nextUpdate() 抛出
      session.prompt(text).catch(() => undefined)
      for (;;) {
        if (this.abortedRequests.has(requestId)) {
          this.emitEvent(requestId, { type: 'finish', finishReason: 'cancelled' })
          return
        }
        const message = await session.nextUpdate()
        if (message.kind === 'stop') {
          this.emitEvent(requestId, {
            type: 'finish',
            finishReason: message.stopReason === 'cancelled' ? 'cancelled' : 'done'
          })
          return
        }
        const event = toStreamEvent(message.update)
        if (event) this.emitEvent(requestId, event)
      }
    } catch (err) {
      console.error('[acp-agent] runTurn error', requestId, describeError(err))
      if (this.abortedRequests.has(requestId)) {
        this.emitEvent(requestId, { type: 'finish', finishReason: 'cancelled' })
      } else {
        this.emitEvent(requestId, { type: 'error', message: describeError(err) })
        this.emitEvent(requestId, { type: 'finish', finishReason: 'error' })
      }
    } finally {
      this.clearPendingConfirms(requestId)
      this.abortedRequests.delete(requestId)
      this.requestWorkspaces.delete(requestId)
      const ws = this.sessions.get(workspace.id)
      if (ws) ws.currentRequestId = null
    }
  }

  /** 懒创建工作区的常驻 ACP 连接与会话；进程已死时重建 */
  private async ensureSession(
    workspace: AgentWorkspace,
    acpAgent: AcpAgentConfig
  ): Promise<ActiveSession> {
    const existing = this.sessions.get(workspace.id)
    if (existing && !existing.closed && existing.proc.exitCode === null) {
      return existing.sessionReady
    }
    if (existing) this.teardown(workspace.id)

    const ws = this.createSession(workspace, acpAgent)
    this.sessions.set(workspace.id, ws)
    try {
      return await ws.sessionReady
    } catch (err) {
      this.teardown(workspace.id)
      throw err
    }
  }

  private createSession(workspace: AgentWorkspace, acpAgent: AcpAgentConfig): WorkspaceAcpSession {
    let closeConnection: () => void = () => {}
    let resolveSession!: (s: ActiveSession) => void
    let rejectSession!: (err: unknown) => void
    const sessionReady = new Promise<ActiveSession>((resolve, reject) => {
      resolveSession = resolve
      rejectSession = reject
    })
    const ws: WorkspaceAcpSession = {
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      proc: spawnAgentProcess(acpAgent, workspace.path),
      connection: Promise.resolve(),
      sessionReady,
      currentRequestId: null,
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
      if (this.sessions.get(workspace.id) === ws) {
        this.sessions.delete(workspace.id)
        if (!this.abortedRequests.size) {
          // 非主动中止的意外退出：把仍在等待的用户请求标记为失败
          this.failActiveTurns(workspace.id, `ACP agent 已退出（code=${code ?? 'unknown'}）`)
        }
      }
    })

    const input = Writable.toWeb(proc.stdin!)
    const output = Readable.toWeb(proc.stdout!)
    const stream = acp.ndJsonStream(input, output)

    const app2 = acp
      .client({ name: 'OpsDesk' })
      .onRequest(acp.methods.client.session.requestPermission, (ctx) =>
        this.handlePermission(ws, ctx.params)
      )

    ws.connection = app2
      .connectWith(stream, async (ctx) => {
        console.error('[acp-agent] connectWith op start')
        await ctx.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: { session: {} },
          clientInfo: { name: 'OpsDesk', version: app.getVersion() }
        })
        console.error('[acp-agent] initialized')
        const session = await ctx.buildSession(workspace.path).start()
        console.error('[acp-agent] session started', session.sessionId)
        resolveSession(session)
        await new Promise<void>((resolve) => {
          closeConnection = resolve
        })
      })
      .catch((err) => {
        // 连接关闭（进程退出 / 主动 teardown）时静默
        console.error('[acp-agent] connection closed', describeError(err))
        if (!ws.closed) rejectSession(new Error('ACP agent 连接已关闭'))
      })
    return ws
  }

  /** 移除工作区的常驻连接：杀进程并触发 connectWith 返回 */
  private teardown(workspaceId: string): void {
    const ws = this.sessions.get(workspaceId)
    if (!ws) return
    this.sessions.delete(workspaceId)
    killProcessTree(ws.proc)
    ws.closeConnection()
    if (ws.currentRequestId) this.abortedRequests.add(ws.currentRequestId)
  }

  /** 工作区意外断开时，把正在进行的 turn 标记为失败 */
  private failActiveTurns(workspaceId: string, message: string): void {
    for (const [requestId, wid] of this.requestWorkspaces) {
      if (wid !== workspaceId) continue
      this.emitEvent(requestId, { type: 'error', message })
      this.emitEvent(requestId, { type: 'finish', finishReason: 'error' })
    }
  }

  /** ACP 权限请求：full 模式自动放行，confirm 模式弹确认卡 */
  private async handlePermission(
    ws: WorkspaceAcpSession,
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

  /** 中止对话：杀掉该工作区的 agent 进程（会话作废，下次自动重建） */
  abort(requestId: string): void {
    this.clearPendingConfirms(requestId)
    const workspaceId = this.requestWorkspaces.get(requestId)
    if (!workspaceId) return
    this.abortedRequests.add(requestId)
    this.teardown(workspaceId)
  }

  /** 应用退出时清理所有常驻 agent 进程 */
  dispose(): void {
    for (const workspaceId of [...this.sessions.keys()]) {
      this.teardown(workspaceId)
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
