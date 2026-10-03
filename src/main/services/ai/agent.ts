/**
 * AI Agent 服务 —— **两条 AI 线统一的对话引擎**。
 *
 * `agent:chat` 按 `req.scope` 分派到两条路径（会话模型同构，工具与提示词不同）：
 * - `workspace`（缺省）：工作区 Agent，绑定本地目录，工具由 tool-registry
 *   按 scope 组装（文件 / 命令 / 浏览器 / 技能 / 客户端工具 / MCP）；
 * - `terminal`：终端 AI 助手，绑定发起对话的终端会话，工具为终端操作
 *   （定义见 terminal-tools.ts）。
 *
 * 共用的部分都在这个类里：确认请示（串行弹卡）、模型解析（resolve-model）、
 * 上下文三道闸（sliceByCheckpoint → 条数截断 → compressContext）、
 * Mastra Agent.stream + 自驱动重试（runStreamWithRetry）、abort 收尾
 * （确认卡 / 提问 / 客户端工具全部 settle，绝不悬挂）。
 *
 * ⚠️ 原生 AI SDK（`ai` 包的 `streamText`）路径已整体移除；旧 `services/ai/ai.ts`
 * （每终端会话一个 AiAssistant 实例的独立引擎）也随统一移除 —— 磁盘上
 * `backend: 'ai-sdk'` 的旧会话由 storage 读取时迁移为 mastra。
 */
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type { ToolSet } from 'ai'
import {
  adaptMastraPart,
  buildAgentSystemPrompt,
  createAgentFileState,
  normalizeUsage,
  readChunkUsage,
  toModelMessages,
  type AgentFileState,
  type RawUsage
} from './agent-core'
import type {
  AgentChatRequest,
  AgentConfirmRequest,
  AgentStreamEvent,
  AiModelConfig,
  AiSettings
} from '@shared/types'
import { resolveModel } from './resolve-model'
import { compressContext, withSummaryPrefix } from './context'
import { sliceByCheckpoint } from './context-summary'
import { askFollowupBroker } from './ask-followup'
import { ASK_FOLLOWUP_HINT } from '@shared/ask-followup'
import { armConfirmTimeout, modelRunTimeout } from './timeouts'
import { DEFAULT_MAX_STEPS, resolveMaxRetries } from '@shared/ai-timeouts'
import { describeError, isRetryableNetworkError } from './error-utils'
import { retryDelayMs, sleepWithSignal } from './retry'
import { createToolInputThrottle } from './tool-input-throttle'
import { skillsForAgent } from './skills'
import { findGitBash } from '../terminal/shells'
import { BROWSER_PROMPT_SECTION } from '../browser/agent'
import { buildTerminalSystemPrompt } from './terminal-tools'
import { toolRegistry, type ToolRunContext } from './tool-registry'
import { clientToolBroker } from './client-tools'
import { ensureBuiltinToolsRegistered } from './builtin-tools'
import { mcpManager } from './mcp'
import { storage } from '../storage'
import { sessionManager } from '../terminal/sessions'

/**
 * Windows 上 execute_command 的 POSIX 环境（Git Bash）：检测一次并缓存。
 * 检测含 `where git.exe` 扫盘，别每轮对话都跑；装了 Git 之后无需重启（缓存进程级即可接受）。
 */
let cachedBashPath: string | null | undefined
function agentBashPath(): string | null {
  if (process.platform !== 'win32') return null
  if (cachedBashPath === undefined) cachedBashPath = findGitBash()
  return cachedBashPath
}

/** 由 ipc 层注入：把确认请求与其最终结果广播给渲染进程 */
export interface AgentConfirmSink {
  request(req: AgentConfirmRequest): void
  resolved(id: string): void
}

interface PendingConfirm {
  requestId: string
  resolve: (approved: boolean) => void
  /** 兜底定时器；按默认配置（不限时）时是 undefined（见 timeouts.ts） */
  timer?: ReturnType<typeof setTimeout>
}

/** 每个请求的归属元数据：会话关闭时按它中止对应的终端对话 */
interface RequestMeta {
  scope: 'workspace' | 'terminal'
  targetSessionId?: string | null
}

/**
 * Agent 服务：一次对话绑定一个工作区（workspace）或发起它的终端会话（terminal）。
 * 确认请求全局串行弹出（同一时刻只等一张卡）；中止时释放挂起的确认与请求。
 */
class AgentService extends EventEmitter {
  private confirmSink: AgentConfirmSink | null = null
  private abortControllers = new Map<string, AbortController>()
  private requestMeta = new Map<string, RequestMeta>()
  private pendingConfirms = new Map<string, PendingConfirm>()
  /** 确认请求串行链：前一个确认被应答（或中止）后才弹下一个 */
  private confirmChain: Promise<unknown> = Promise.resolve()
  /**
   * 「先读后改」状态按会话持有（read_file 记录快照，write/edit 校验）。
   * 工具集每轮重建，状态必须活在服务里才跨得了轮；超过上限丢弃最早的会话
   * （丢了的后果只是那条会话下次要先重读一遍，无正确性风险）。
   */
  private fileStates = new Map<string, AgentFileState>()
  private static readonly MAX_FILE_STATES = 64
  /** terminal 作用域的工具执行串行队列（key = requestId；与旧终端助手的语义一致） */
  private toolQueues = new Map<string, { chain: Promise<unknown>; aborted: boolean }>()

  private fileStateFor(conversationId: string): AgentFileState {
    let state = this.fileStates.get(conversationId)
    if (!state) {
      if (this.fileStates.size >= AgentService.MAX_FILE_STATES) {
        const oldest = this.fileStates.keys().next().value
        if (oldest !== undefined) this.fileStates.delete(oldest)
      }
      state = createAgentFileState()
      this.fileStates.set(conversationId, state)
    }
    return state
  }

  setConfirmSink(sink: AgentConfirmSink | null): void {
    this.confirmSink = sink
  }

  /** 等待用户确认；无 UI 接入时放行，避免流程卡死 */
  private requestConfirm(req: {
    requestId: string
    toolCallId: string
    toolName: string
    command: string
    workspaceName?: string
    sessionId?: string
    sessionTitle?: string
  }): Promise<boolean> {
    const sink = this.confirmSink
    if (!sink) return Promise.resolve(true)
    const result = this.confirmChain.then(() => this.doRequestConfirm(req, sink))
    this.confirmChain = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  private doRequestConfirm(
    req: {
      requestId: string
      toolCallId: string
      toolName: string
      command: string
      workspaceName?: string
      sessionId?: string
      sessionTitle?: string
    },
    sink: AgentConfirmSink
  ): Promise<boolean> {
    const id = randomUUID()
    return new Promise<boolean>((resolve) => {
      const settle = (approved: boolean) => {
        this.pendingConfirms.delete(id)
        sink.resolved(id)
        resolve(approved)
      }
      const timer = armConfirmTimeout(
        () => settle(false),
        storage.getAiSettings().confirmTimeoutMs
      )
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

  /** 结束挂起的确认（中止对话 / 流结束兜底），按「取消」处理 —— 确认卡不限时，就靠它收尾 */
  private clearPendingConfirms(requestId?: string): void {
    for (const pending of this.pendingConfirms.values()) {
      if (requestId && pending.requestId !== requestId) continue
      clearTimeout(pending.timer)
      pending.resolve(false)
    }
  }

  /** terminal 作用域的工具执行排队：同一对话内串行，中止时未开始的直接拒绝 */
  private queueToolExecution<T>(requestId: string, fn: () => Promise<T>): Promise<T> {
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

  /** 模型配置解析：优先请求里带的 configId，回退设置里的默认模型（两条路径共用） */
  private resolveChatConfig(req: AgentChatRequest): {
    settings: AiSettings
    config: AiModelConfig | undefined
  } {
    const settings = storage.getAiSettings()
    const config =
      (req.configId ? storage.getAiConfig(req.configId) : undefined) ??
      (settings.activeConfigId ? storage.getAiConfig(settings.activeConfigId) : undefined)
    return { settings, config }
  }

  async chat(req: AgentChatRequest): Promise<{ requestId: string }> {
    ensureBuiltinToolsRegistered()
    return (req.scope ?? 'workspace') === 'terminal' ? this.chatTerminal(req) : this.chatWorkspace(req)
  }

  /**
   * 内置 Mastra agent 的**工作区**对话。
   *
   * 模型按会话独立：优先用请求里带的 `configId`，回退到设置里的默认模型；
   * 会话选的配置被删掉时也要回退，否则这个会话会直接报「未配置」。
   */
  private async chatWorkspace(req: AgentChatRequest): Promise<{ requestId: string }> {
    const requestId = randomUUID()
    const workspace = req.workspaceId ? storage.getAgentWorkspace(req.workspaceId) : undefined
    const { settings, config } = this.resolveChatConfig(req)

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
    if (!config) {
      fail('尚未配置 AI 模型，请先在设置中添加模型配置')
      return { requestId }
    }

    const controller = new AbortController()
    this.abortControllers.set(requestId, controller)
    this.requestMeta.set(requestId, { scope: 'workspace' })

    // 技能每次对话现扫（磁盘即真源，用户随时可以往技能目录里丢东西）：
    // 清单进系统提示词，正文由 read_skill 工具按需读取
    const skills = await skillsForAgent(workspace.path)
    const { tools: mcpTools, errors: mcpErrors } = await mcpManager.buildToolset()
    if (mcpErrors.length) console.warn('[agent] MCP 工具加载异常：', mcpErrors.join('；'))

    const ctx: ToolRunContext = {
      requestId,
      conversationId: req.conversationId,
      scope: 'workspace',
      workspace,
      signal: controller.signal,
      permissionMode: settings.permissionMode === 'confirm' ? 'confirm' : 'full',
      requestConfirm: (r) => this.requestConfirm({ ...r, requestId, workspaceName: workspace.name }),
      fileState: this.fileStateFor(req.conversationId),
      skills,
      bashPath: agentBashPath()
    }
    // 工具集从注册表组装：内置定义 + 随请求携带的客户端工具 + MCP（extra，同名覆盖内置）
    const tools: ToolSet = toolRegistry.buildToolset({
      ctx,
      extra: mcpTools,
      clientTools: this.clientToolExecutors(req)
    })

    const hasBrowser = Object.keys(tools).some((k) => k.startsWith('browser_'))
    // ⚠️ 必须带上 req.modelId：会话在「同一配置下切换具体模型」时，modelId 是用户选的，
    // 不传就回退到配置的默认模型 —— 表现为「切换模型不生效，请求还在用旧模型」。
    const model = resolveModel(config, req.modelId)
    const historyLimit = config.contextMessages ?? 20
    // 三道闸，**顺序不能换**：① 手动压缩的检查点切片 → ② 按条数截断 → ③ 按 token 自动压缩。
    // ① 必须在 ② 之前：反过来 slice(-historyLimit) 可能把刚注入的摘要消息本身切掉，
    // 检查点就白设了（而且是静默白设，界面看不出任何异常）。
    // ③ 只改「这一次请求怎么带上下文」，不碰落盘的历史（屏幕上的原文始终可翻可复制）。
    const conversation = storage.getAgentConversation(req.conversationId)
    const sliced = sliceByCheckpoint(req.history, conversation?.contextSummary)
    const recent = toModelMessages(sliced.messages.slice(-historyLimit))
    const { messages: modelMessages, compressed } = await compressContext(
      sliced.summaryText ? withSummaryPrefix(recent, sliced.summaryText) : recent,
      {
        budget: config.contextBudget,
        model: config,
        modelId: req.modelId,
        signal: controller.signal
      }
    )
    if (compressed) {
      // ⚠️ 必须延后到 invoke 回包之后（见 ipc/agent.ts 的注释）：此刻 requestId 还没登记进
      // chatConversations，广播出去的事件渲染端认不出归属、会被整条丢掉。
      const info = compressed
      setTimeout(() => this.emitEvent(requestId, { type: 'context-compressed', info }), 0)
    }

    const { Agent } = await import('@mastra/core/agent')
    const agent = new Agent({
      id: 'dogi',
      name: 'Dogi',
      instructions:
        buildAgentSystemPrompt(workspace.path, workspace.name, skills) +
        (hasBrowser ? '\n\n' + BROWSER_PROMPT_SECTION : '') +
        ASK_FOLLOWUP_HINT,
      model: model as never,
      tools: tools as never
    })

    // 起流 + 消费流整体交给带重试的 runStreamWithRetry（每次尝试都重建流）。
    // ⚠️ 不再用 mastra 的 `modelSettings.maxRetries`：那条路只在 SDK 内部静默重试，界面看不到
    //    任何迹象；自己驱动才能在每次重试时发一条 `retry` 事件（界面显示「第 N 次重试」）。
    void this.runStreamWithRetry(requestId, {
      controller,
      maxRetries: resolveMaxRetries(settings.maxRetries),
      start: () =>
        agent.stream(modelMessages as never, {
          maxSteps: settings.maxSteps ?? DEFAULT_MAX_STEPS,
          abortSignal: controller.signal,
          modelSettings: this.mastraModelSettings(config, settings)
        }) as unknown as Promise<{ fullStream: AsyncIterable<unknown>; usage?: Promise<unknown> }>
    })
    return { requestId }
  }

  /**
   * 终端 AI 助手对话（mastra 引擎；**terminal 作用域只有这一种形态** ——
   * ACP 的上下文绑定工作区目录，终端拿不到 CWD，绑不上去）。
   */
  private async chatTerminal(req: AgentChatRequest): Promise<{ requestId: string }> {
    const requestId = randomUUID()
    const { settings, config } = this.resolveChatConfig(req)

    const fail = (message: string) => {
      setTimeout(() => {
        this.emitEvent(requestId, { type: 'error', message })
        this.emitEvent(requestId, { type: 'finish', finishReason: 'error' })
      }, 0)
    }
    if (!config) {
      fail('尚未配置 AI 模型，请先在设置中添加模型配置')
      return { requestId }
    }

    const controller = new AbortController()
    this.abortControllers.set(requestId, controller)
    this.requestMeta.set(requestId, { scope: 'terminal', targetSessionId: req.targetSessionId })

    const { tools: mcpTools, errors: mcpErrors } = await mcpManager.buildToolset()
    const permissionMode = settings.permissionMode === 'confirm' ? 'confirm' : 'full'
    const ctx: ToolRunContext = {
      requestId,
      conversationId: req.conversationId,
      scope: 'terminal',
      targetSessionId: req.targetSessionId ?? null,
      signal: controller.signal,
      permissionMode,
      requestConfirm: (r) => this.requestConfirm({ ...r, requestId }),
      queueToolExecution: (fn) => this.queueToolExecution(requestId, fn)
    }
    const tools: ToolSet = toolRegistry.buildToolset({
      ctx,
      extra: mcpTools,
      clientTools: this.clientToolExecutors(req)
    })

    const model = resolveModel(config, req.modelId)
    const historyLimit = config.contextMessages ?? 20
    // 与工作区同口径：先按条数截断，再按 token 预算压缩（只影响本次请求，不动历史）。
    // 终端会话不支持手动压缩（没有检查点），自动压缩照常生效。
    const { messages: modelMessages, compressed } = await compressContext(
      toModelMessages(req.history.slice(-historyLimit)),
      {
        budget: config.contextBudget,
        model: config,
        modelId: req.modelId,
        signal: controller.signal
      }
    )
    if (compressed) {
      // ⚠️ 延后到 invoke 回包之后：渲染端在 await 返回之后才登记 requestId → 会话，
      // 此刻发出的事件认不出归属会被丢掉（同 chatWorkspace / ipc/agent.ts 的说明）。
      const info = compressed
      setTimeout(() => this.emitEvent(requestId, { type: 'context-compressed', info }), 0)
    }

    const boundSession = req.targetSessionId ? sessionManager.get(req.targetSessionId) : undefined
    const systemPrompt =
      buildTerminalSystemPrompt({
        customPrompt: settings.systemPrompt,
        permissionMode,
        boundSession: boundSession
          ? { title: boundSession.info.title, platform: boundSession.info.platform }
          : undefined,
        mcpErrors
      }) + ASK_FOLLOWUP_HINT

    const { Agent } = await import('@mastra/core/agent')
    const agent = new Agent({
      id: 'dogi-terminal',
      name: 'Dogi Terminal',
      instructions: systemPrompt,
      model: model as never,
      tools: tools as never
    })

    void this.runStreamWithRetry(requestId, {
      controller,
      maxRetries: resolveMaxRetries(settings.maxRetries),
      start: () =>
        agent.stream(modelMessages as never, {
          maxSteps: settings.maxSteps ?? DEFAULT_MAX_STEPS,
          abortSignal: controller.signal,
          modelSettings: this.mastraModelSettings(config, settings)
        }) as unknown as Promise<{ fullStream: AsyncIterable<unknown>; usage?: Promise<unknown> }>
    })
    return { requestId }
  }

  /**
   * 把请求里携带的客户端工具定义接上回填通道（执行器 = clientToolBroker.invoke）。
   * 权限与确认全在渲染端（invoke 事件到达后由渲染端按 permissionMode 处理），
   * 主进程不做任何闸 —— 这里只是「把调用广播回去、等结果」。
   */
  private clientToolExecutors(
    req: AgentChatRequest
  ): Array<{
    name: string
    description: string
    inputSchema?: Record<string, unknown>
    execute(input: unknown, call: { toolCallId: string }, ctx: ToolRunContext): Promise<unknown>
  }> {
    return (req.clientTools ?? []).map((def) => ({
      name: def.name,
      description: def.description,
      ...(def.inputSchema ? { inputSchema: def.inputSchema } : {}),
      execute: (input: unknown, call: { toolCallId: string }, runCtx: ToolRunContext) =>
        clientToolBroker.invoke(def.name, input, call, runCtx)
    }))
  }

  /** mastra 的 modelSettings：默认不限时（只设 firstChunkMs），重试由 runStreamWithRetry 自己驱动 */
  private mastraModelSettings(config: AiModelConfig, settings: AiSettings): Record<string, unknown> {
    return {
      // mastra 侧同样默认不限时；只设 firstChunkMs（见 timeouts.ts）
      timeout: modelRunTimeout(settings.modelTimeoutMs),
      // 重试由 runStreamWithRetry 自己驱动，SDK 内部重试关掉（否则两套叠加、事件对不上）
      maxRetries: 0,
      ...(config.temperature !== undefined ? { temperature: config.temperature } : {}),
      ...(config.maxTokens !== undefined ? { maxOutputTokens: config.maxTokens } : {})
    }
  }

  /**
   * 跑一轮流式对话，带**自动重试**。
   *
   * 重试条件（需同时满足）：错误是**可重试的网络类错误**、用户没中止、重试次数没到上限，
   * 且**失败的尝试没执行过工具**（重试 = 从头再跑一轮，已执行的工具会产生重复副作用）。
   * 每次重试前发一条 `retry` 事件 —— 界面据此清掉这一次尝试的半截输出、显示「第 N 次重试」。
   *
   * `opts.start` 每次尝试都重新起流（闭包持有 agent / 消息 / 配置）。
   */
  private async runStreamWithRetry(
    requestId: string,
    opts: {
      start: () => Promise<{ fullStream: AsyncIterable<unknown>; usage?: Promise<unknown> }>
      controller: AbortController
      maxRetries: number
    }
  ): Promise<void> {
    const { controller, maxRetries } = opts
    const startedAt = Date.now()
    /** 已经重试过几次（发 retry 事件时先 +1，作为「第几次重试」） */
    let retries = 0
    /** 本轮是否已经真实执行过工具（发出过 tool-call）：有就不再自动重试 */
    let toolExecuted = false

    /**
     * 入参增量的节流器（见 `tool-input-throttle.ts`）。
     *
     * ⚠️ 本轮**所有**事件都必须走下面这个 `send` —— 非增量事件前要先把攒着的增量冲干净，
     * 否则同一个 toolCallId 的增量会排到它自己的完整 `tool-call` 之后，前端又用旧增量盖回去。
     */
    const inputDelta = createToolInputThrottle((delta) =>
      this.emitEvent(requestId, { type: 'tool-call-delta', ...delta })
    )
    const send = (event: AgentStreamEvent): void => {
      if (event.type === 'tool-call-delta') {
        inputDelta.push(event)
        return
      }
      inputDelta.flush()
      this.emitEvent(requestId, event)
    }
    try {
      for (;;) {
        /** 首块时刻（TPS 的生成窗口起点）：每次尝试各算一份 */
        let firstTokenAt = 0
        /**
         * 本轮用量。**优先取自 `finish` chunk**（AI SDK 原样透出的那份，字段最全），
         * 拿不到才回退到 Mastra 的 `stream.usage` —— 后者是它自己归一化过的形状，
         * 「思考 / 缓存命中」的明细不一定保留（见 `agent-core/usage.ts` 的说明）。
         * 多步时每个 step 都会带 usage，后写覆盖先写，最终留的是整轮累计值。
         */
        let rawUsage: RawUsage | null = null
        try {
          const stream = await opts.start()
          for await (const part of stream.fullStream) {
            const p = part as { type: string; [k: string]: unknown }
            if (
              (p.type === 'text' ||
                p.type === 'text-delta' ||
                p.type === 'reasoning' ||
                p.type === 'reasoning-delta') &&
              !firstTokenAt
            ) {
              firstTokenAt = Date.now()
            }
            const chunkUsage = readChunkUsage(p)
            if (chunkUsage) rawUsage = chunkUsage
            const event = adaptMastraPart(p)
            if (event) {
              // 流内 error 块（不抛、只发事件）：底层可重试就抛出去，交给 catch 走重试 ——
              // 否则限流 / 网关错误会被当成终态直接失败（界面停在 loading 后弹一句错误）
              if (event.type === 'error') {
                const rawPayload = p.payload as { error?: unknown } | undefined
                const rawError = rawPayload?.error ?? p.error
                if (isRetryableNetworkError(rawError)) {
                  throw rawError instanceof Error ? rawError : new Error(event.message)
                }
              }
              if (event.type === 'tool-call') toolExecuted = true
              send(event)
            }
          }
          if (!rawUsage) {
            try {
              rawUsage = normalizeUsage(await stream.usage)
            } catch {
              // 用量缺失时静默跳过
            }
          }
          if (rawUsage) {
            const endAt = Date.now()
            const durationMs = endAt - startedAt
            const genWindowMs = firstTokenAt ? endAt - firstTokenAt : durationMs
            const tps =
              genWindowMs > 0 ? rawUsage.outputTokens / (genWindowMs / 1000) : 0
            send({
              type: 'usage',
              usage: {
                inputTokens: rawUsage.inputTokens,
                outputTokens: rawUsage.outputTokens,
                totalTokens: rawUsage.totalTokens,
                ...(rawUsage.reasoningTokens != null
                  ? { reasoningTokens: rawUsage.reasoningTokens }
                  : {}),
                ...(rawUsage.cachedInputTokens != null
                  ? { cachedInputTokens: rawUsage.cachedInputTokens }
                  : {}),
                durationMs,
                tps: Math.round(tps * 10) / 10
              }
            })
          }
          send({ type: 'finish', finishReason: 'done' })
          return
        } catch (err) {
          const elapsed = firstTokenAt ? Date.now() - firstTokenAt : -1
          console.error(
            `[agent] 流式对话中断 requestId=${requestId} ` +
              `首块时间=${firstTokenAt || '未输出任何文本'} ` +
              `流已持续=${elapsed >= 0 ? elapsed + 'ms' : 'N/A'} ` +
              `(负值=首块前就断，多为鉴权/请求被拒；正值=输出中途断，多为连接/网关超时断流)`
          )
          // 可重试的网络中断：用户没中止、没执行过工具、也没到次数上限 → 退避后重来
          if (
            !controller.signal.aborted &&
            isRetryableNetworkError(err) &&
            !toolExecuted &&
            retries < maxRetries
          ) {
            retries += 1
            send({ type: 'retry', attempt: retries, maxRetries })
            console.warn(`[agent] 模型请求失败，第 ${retries} 次重试：${describeError(err)}`)
            const waited = await sleepWithSignal(retryDelayMs(retries), controller.signal)
            // 退避期间用户点了停止：按中止收场，不再重试
            if (!waited) {
              send({ type: 'finish', finishReason: 'aborted' })
              return
            }
            continue
          }
          send({
            type: 'error',
            message: describeError(err),
            retryable: isRetryableNetworkError(err)
          })
          send({ type: 'finish', finishReason: 'error' })
          return
        }
      }
    } finally {
      this.clearPendingConfirms(requestId)
      askFollowupBroker.cancel(requestId)
      clientToolBroker.cancel(requestId)
      this.abortControllers.delete(requestId)
      this.requestMeta.delete(requestId)
      // terminal 队列对象由排队中的闭包持有，清理 Map 不影响已中止标志的感知
      this.toolQueues.delete(requestId)
    }
  }

  private emitEvent(requestId: string, event: AgentStreamEvent): void {
    this.emit('chat-event', requestId, event)
  }

  /** 中止某次对话：释放挂起的确认并中止底层请求 */
  abort(requestId: string): void {
    // 标记 terminal 队列中止：尚未开始执行的排队命令直接跳过，不再写入终端
    const queue = this.toolQueues.get(requestId)
    if (queue) queue.aborted = true
    // 先释放可能正在等待用户确认的工具，避免执行流悬挂
    this.clearPendingConfirms(requestId)
    askFollowupBroker.cancel(requestId)
    clientToolBroker.cancel(requestId)
    this.abortControllers.get(requestId)?.abort()
  }

  /**
   * 终端会话关闭：中止绑定在它上面的全部终端对话（挂起的确认 / 提问 / 客户端工具一并收尾）。
   * 由 ipc 层订阅 sessionManager 的 'closed' 事件转发过来。
   */
  disposeTerminalSession(sessionId: string): void {
    for (const [requestId, meta] of [...this.requestMeta.entries()]) {
      if (meta.scope === 'terminal' && meta.targetSessionId === sessionId) this.abort(requestId)
    }
  }
}

export const agentService = new AgentService()
