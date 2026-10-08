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
  readProjectDoc,
  toModelMessages,
  type AgentFileState,
  type RawUsage
} from './agent-core'
import type {
  AgentChatRequest,
  AgentConfirmRequest,
  AgentStreamEvent,
  AgentWorkspace,
  AiModelConfig,
  AiSettings,
  ConfirmDecision
} from '@shared/types'
import { BUILTIN_CONFIRM_OPTIONS } from '@shared/confirm'
import { resolveModel } from './resolve-model'
import { compressContext, estimateBaseTokens, withSummaryPrefix } from './context'
import { sliceByCheckpoint } from './context-summary'
import { askFollowupBroker } from './ask-followup'
import { ASK_FOLLOWUP_HINT } from '@shared/ask-followup'
import { armConfirmTimeout, modelRunTimeout } from './timeouts'
import { DEFAULT_MAX_STEPS, resolveMaxRetries } from '@shared/ai-timeouts'
import { describeError, isRetryableNetworkError } from './error-utils'
import { retryDelayMs, sleepWithSignal } from './retry'
import { createToolInputThrottle } from './tool-input-throttle'
import { steerRegistry } from './steer'
import { skillsForAgent } from './skills'
import { findGitBash } from '../terminal/shells'
import { BROWSER_PROMPT_SECTION } from '../browser/agent'
import { buildTerminalSystemPrompt } from './terminal-tools'
import { toolRegistry, type ToolRunContext } from './tool-registry'
import { createSubAgentRunner } from './sub-agent'
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

/** 把设置里的权限模式收敛到三档（老存档 / 脏值一律按 full 处理，别让非法值漏进工具闸） */
function asPermissionMode(
  mode: AiSettings['permissionMode'] | undefined
): 'full' | 'confirm' | 'readonly' {
  return mode === 'confirm' || mode === 'readonly' ? mode : 'full'
}

/** 由 ipc 层注入：把确认请求与其最终结果广播给渲染进程 */
export interface AgentConfirmSink {
  request(req: AgentConfirmRequest): void
  resolved(id: string): void
}

interface PendingConfirm {
  requestId: string
  resolve: (decision: ConfirmDecision) => void
  /** 兜底定时器；按默认配置（不限时）时是 undefined（见 timeouts.ts） */
  timer?: ReturnType<typeof setTimeout>
}

/** 每个请求的归属元数据：会话关闭时按它中止对应的终端对话 */
interface RequestMeta {
  scope: 'workspace' | 'terminal'
  targetSessionId?: string | null
  /** 这一轮属于哪条会话：判断「这条会话现在有没有在跑」用（插话的准入） */
  conversationId: string
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
  /**
   * 「总是允许 / 总是拒绝」的记忆：key = 会话 id → 工具名 → 记忆的裁决。
   *
   * ⚠️ 只在**进程内**记忆（重启即忘，与 fishwork 的 confirm-gate 一致）：把「永远允许」
   * 落盘意味着一次误点会永久放行某类动作，代价太大。命中记忆时直接回一个 once 档、不再弹卡。
   */
  private alwaysDecisions = new Map<string, Map<string, 'allow' | 'reject'>>()

  /** 会话删除时清掉记忆，避免旧会话的「总是允许」泄漏到别处（同 id 复用 / 内存残留） */
  forgetConfirmMemory(conversationId: string): void {
    this.alwaysDecisions.delete(conversationId)
  }

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

  /**
   * 等待用户确认；无 UI 接入时放行，避免流程卡死。
   *
   * 返回**四档裁决**（见 `ConfirmDecision`）。「总是允许 / 总是拒绝」的记忆在这里短路：
   * 命中就回一个 once 档（allow_once / reject_once）、**不弹卡也不排队** —— 用户已经就这类工具
   * 表过态了，再问一遍是打扰。
   */
  private requestConfirm(req: {
    requestId: string
    conversationId: string
    toolCallId: string
    toolName: string
    command: string
    workspaceId?: string
    workspaceName?: string
    sessionId?: string
    sessionTitle?: string
  }): Promise<ConfirmDecision> {
    const remembered = this.alwaysDecisions.get(req.conversationId)?.get(req.toolName)
    if (remembered === 'allow') return Promise.resolve('allow_once')
    if (remembered === 'reject') return Promise.resolve('reject_once')

    const sink = this.confirmSink
    if (!sink) return Promise.resolve('allow_once')
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
      conversationId: string
      toolCallId: string
      toolName: string
      command: string
      workspaceId?: string
      workspaceName?: string
      sessionId?: string
      sessionTitle?: string
    },
    sink: AgentConfirmSink
  ): Promise<ConfirmDecision> {
    const id = randomUUID()
    return new Promise<ConfirmDecision>((resolve) => {
      const settle = (decision: ConfirmDecision) => {
        this.pendingConfirms.delete(id)
        // 「总是」档在这里被记住（会话 + 工具名），后续同名调用直接短路、不再弹卡
        if (decision === 'allow_always' || decision === 'reject_always') {
          let map = this.alwaysDecisions.get(req.conversationId)
          if (!map) {
            map = new Map()
            this.alwaysDecisions.set(req.conversationId, map)
          }
          map.set(req.toolName, decision === 'allow_always' ? 'allow' : 'reject')
        }
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
        // 内置工具恒为四档（ACP 会按 agent 广告的 option 收窄，见 acp-agent.ts）
        options: BUILTIN_CONFIRM_OPTIONS,
        ...(req.workspaceId ? { workspaceId: req.workspaceId } : {}),
        ...(req.workspaceName ? { workspaceName: req.workspaceName } : {}),
        ...(req.sessionId ? { sessionId: req.sessionId } : {}),
        ...(req.sessionTitle ? { sessionTitle: req.sessionTitle } : {})
      })
    })
  }

  /** 渲染进程回复确认结果（四档裁决） */
  resolveConfirm(id: string, decision: ConfirmDecision): void {
    const pending = this.pendingConfirms.get(id)
    if (!pending) return
    clearTimeout(pending.timer)
    pending.resolve(decision)
  }

  /** 结束挂起的确认（中止对话 / 流结束兜底），按「拒绝一次」处理 —— 确认卡不限时，就靠它收尾 */
  private clearPendingConfirms(requestId?: string): void {
    for (const pending of this.pendingConfirms.values()) {
      if (requestId && pending.requestId !== requestId) continue
      clearTimeout(pending.timer)
      pending.resolve('reject_once')
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
    this.requestMeta.set(requestId, { scope: 'workspace', conversationId: req.conversationId })

    /**
     * ⚠️ **准备阶段在后台跑，这里立即把 requestId 交回渲染端**（起流部分见
     * `prepareWorkspaceTurn` 之后的 `then`）。理由是 requestId 是「停止」的唯一把手：
     * 渲染端只有拿到它才发得了 `agent:abort`。而准备阶段动辄几百毫秒 —— 扫技能目录、
     * **启动 MCP server 子进程**、估算 baseTokens、按窗口压缩上下文（要真调一次模型）、
     * 动态 import agent；开了 MCP 或触发了压缩时能到好几秒。这段时间界面已经是「运行中」，
     * 用户点「停止」会扑空（渲染端没有 requestId 可中止），那一轮照跑到底、跑完还会把
     * **待发送队列**接着发出去 —— 用户想停的正是这个。
     *
     * 失败照旧由事件表达（error + finish('error')）：此刻 ipc 层已把 requestId 登记进
     * chatConversations，渲染端认得归属（见 4.2「事件必须自带归属」）。
     */
    void this.prepareWorkspaceTurn(requestId, controller, req, settings, config, workspace)
      .then(async ({ model, tools, instructions, modelMessages }) => {
        // 准备期间用户已经叫停：controller 早就 aborted，不必再起流（省掉一次真实请求）。
        // ⚠️ 这里要自己收尾 —— 清理只写在 runStreamWithRetry 的 finally 里，早退不经它。
        if (controller.signal.aborted) return this.forgetRequest(requestId, req.conversationId)
        // ⚠️ 动态 import（主进程产物是 ESM，不能用 require）：与原先一致，只是挪到了后台。
        const { Agent } = await import('@mastra/core/agent')
        const agent = new Agent({
          id: 'dogi',
          name: 'Dogi',
          instructions,
          model: model as never,
          tools: tools as never
        })
        // 起流 + 消费流整体交给带重试的 runStreamWithRetry（每次尝试都重建流）。
        // ⚠️ 不再用 mastra 的 `modelSettings.maxRetries`：那条路只在 SDK 内部静默重试，界面看不到
        //    任何迹象；自己驱动才能在每次重试时发一条 `retry` 事件（界面显示「第 N 次重试」）。
        return this.runStreamWithRetry(requestId, {
          controller,
          maxRetries: resolveMaxRetries(settings.maxRetries),
          conversationId: req.conversationId,
          start: () =>
            agent.stream(modelMessages as never, {
              maxSteps: settings.maxSteps ?? DEFAULT_MAX_STEPS,
              abortSignal: controller.signal,
              modelSettings: this.mastraModelSettings(config, settings)
            }) as unknown as Promise<{ fullStream: AsyncIterable<unknown>; usage?: Promise<unknown> }>
        })
      })
      .catch((err) => this.failPreparation(requestId, controller, err))
    return { requestId }
  }

  /**
   * 工作区对话的**准备阶段**：扫技能 → 组装工具集 → 建提示词 → 三道闸算出这一轮要发的消息。
   * 起流在调用方（拿到这些之后立即 return requestId）。
   */
  private async prepareWorkspaceTurn(
    requestId: string,
    controller: AbortController,
    req: AgentChatRequest,
    settings: AiSettings,
    config: AiModelConfig,
    workspace: AgentWorkspace
  ): Promise<{
    model: ReturnType<typeof resolveModel>
    tools: ToolSet
    instructions: string
    modelMessages: Awaited<ReturnType<typeof compressContext>>['messages']
  }> {
    // 技能每次对话现扫（磁盘即真源，用户随时可以往技能目录里丢东西）：
    // 清单进系统提示词，正文由 read_skill 工具按需读取
    const skills = await skillsForAgent(workspace.path)
    // 项目约束文档同样每轮现读（磁盘即真源）：用户改完 AGENTS.md 下一轮就生效
    const projectDoc = await readProjectDoc(workspace.path).catch(() => null)
    // 会话级的 MCP 允许清单：从**磁盘上的会话记录**读（它才是真源，渲染端每次落盘都带上）。
    // undefined = 不限制（用全部全局启用的），见 AgentConversation.mcpServerIds。
    const conversationRecord = storage.getAgentConversation(req.conversationId)
    const { tools: mcpTools, errors: mcpErrors } = await mcpManager.buildToolset({
      serverIds: conversationRecord?.mcpServerIds
    })
    if (mcpErrors.length) console.warn('[agent] MCP 工具加载异常：', mcpErrors.join('；'))

    /**
     * ⚠️ 必须带上 req.modelId：会话在「同一配置下切换具体模型」时，modelId 是用户选的，
     * 不传就回退到配置的默认模型 —— 表现为「切换模型不生效，请求还在用旧模型」。
     *
     * 位置比 ctx 早是**故意的**：子 Agent 要用当前这一轮的模型与 modelSettings，
     * 而它们要挂到 ctx 上（见下面的 subAgent）—— 两者都得在组装工具集之前算好。
     * 这一步是纯同步的，不依赖 ctx / tools，提前没有任何副作用。
     */
    const model = resolveModel(config, req.modelId)
    const modelSettings = this.mastraModelSettings(config, settings)

    const ctx: ToolRunContext = {
      requestId,
      conversationId: req.conversationId,
      scope: 'workspace',
      workspace,
      signal: controller.signal,
      permissionMode: asPermissionMode(settings.permissionMode),
      requestConfirm: (r) =>
        this.requestConfirm({
          ...r,
          requestId,
          conversationId: req.conversationId,
          workspaceId: workspace.id,
          workspaceName: workspace.name
        }),
      fileState: this.fileStateFor(req.conversationId),
      skills,
      bashPath: agentBashPath()
    }
    // 子 Agent（delegate 工具）：**只在设置里开启时**注入执行器 —— 没注入则工具不暴露。
    // 注在工具集组装之前，因为 `available` 是组装期判定的（见 tool-registry.buildToolset）。
    if (settings.subAgents) {
      ctx.subAgent = createSubAgentRunner({ parent: ctx, model, modelSettings })
    }
    // 工具集从注册表组装：内置定义 + 随请求携带的客户端工具 + MCP（extra，同名覆盖内置）
    const tools: ToolSet = toolRegistry.buildToolset({
      ctx,
      extra: mcpTools,
      clientTools: this.clientToolExecutors(req)
    })

    const hasBrowser = Object.keys(tools).some((k) => k.startsWith('browser_'))
    const historyLimit = config.contextMessages ?? 20
    /**
     * ⚠️ 抽成局部变量而不是内联在下面的 `new Agent({...})` 里：
     * 系统提示词每轮都发出去却不进 `messages`，不算进 baseTokens 的话统计会明显偏小
     * （提示条上的「压缩前后」会看着几乎没变化）。
     */
    const instructions =
      buildAgentSystemPrompt(
        workspace.path,
        workspace.name,
        skills,
        ctx.permissionMode,
        projectDoc
      ) +
      (hasBrowser ? '\n\n' + BROWSER_PROMPT_SECTION : '') +
      ASK_FOLLOWUP_HINT
    const baseTokens = await estimateBaseTokens(instructions, tools)
    // 三道闸，**顺序不能换**：① 手动压缩的检查点切片 → ② 按条数截断 → ③ 按上下文窗口自动压缩。
    // ① 必须在 ② 之前：反过来 slice(-historyLimit) 可能把刚注入的摘要消息本身切掉，
    // 检查点就白设了（而且是静默白设，界面看不出任何异常）。
    // ③ 只改「这一次请求怎么带上下文」，不碰落盘的历史（屏幕上的原文始终可翻可复制）。
    // （会话记录在上面读 MCP 允许清单时已经取过一次，这里复用，别重复读盘）
    const sliced = sliceByCheckpoint(req.history, conversationRecord?.contextSummary)
    const recent = toModelMessages(sliced.messages.slice(-historyLimit))
    const { messages: modelMessages, compressed } = await compressContext(
      sliced.summaryText ? withSummaryPrefix(recent, sliced.summaryText) : recent,
      {
        model: config,
        modelId: req.modelId,
        baseTokens,
        signal: controller.signal
      }
    )
    if (compressed) {
      // ⚠️ 必须延后到 invoke 回包之后（见 ipc/agent.ts 的注释）：此刻 requestId 还没登记进
      // chatConversations，广播出去的事件渲染端认不出归属、会被整条丢掉。
      const info = compressed
      setTimeout(() => this.emitEvent(requestId, { type: 'context-compressed', info }), 0)
    }
    return { model, tools, instructions, modelMessages }
  }

  /**
   * 准备阶段抛错时的收尾：清理归属信息 + 把失败当事件发出去（渲染端只认事件收尾）。
   * 用户已叫停（controller 已 aborted）则按中止静默收场 —— 没人再听这一轮。
   */
  private failPreparation(requestId: string, controller: AbortController, err: unknown): void {
    this.forgetRequest(requestId)
    if (controller.signal.aborted) return
    console.error(`[agent] 对话准备失败 requestId=${requestId}：`, err)
    this.emitEvent(requestId, { type: 'error', message: describeError(err) })
    this.emitEvent(requestId, { type: 'finish', finishReason: 'error' })
  }

  /**
   * 清掉某个请求的归属信息（与 runStreamWithRetry 的 finally 同一套）。
   * 准备阶段就走掉（起流前抛错 / 中止）时不经那个 finally，必须显式调用，
   * 否则 abortControllers / requestMeta 留下孤儿条目（终端会话关闭时还会拿它误中止）。
   */
  private forgetRequest(requestId: string, conversationId?: string): void {
    this.abortControllers.delete(requestId)
    this.requestMeta.delete(requestId)
    this.toolQueues.delete(requestId)
    // 这一轮根本没起流就走掉了：同样把没赶上的插话清掉（同 runStreamWithRetry 的 finally）
    if (conversationId) steerRegistry.clear(conversationId)
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
    this.requestMeta.set(requestId, {
      scope: 'terminal',
      targetSessionId: req.targetSessionId,
      conversationId: req.conversationId
    })

    // ⚠️ 同 chatWorkspace：准备阶段（MCP 启动 / 估算 token / 上下文压缩）在后台跑，
    // 这里立即交回 requestId —— 它是「停止」的唯一把手，迟了用户就按不住这一轮。
    void this.prepareTerminalTurn(requestId, controller, req, settings, config)
      .then(async ({ model, tools, systemPrompt, modelMessages }) => {
        // 准备期间已被叫停：不必再起流（清理只写在 runStreamWithRetry 的 finally 里，早退不经它）
        if (controller.signal.aborted) return this.forgetRequest(requestId, req.conversationId)
        const { Agent } = await import('@mastra/core/agent')
        const agent = new Agent({
          id: 'dogi-terminal',
          name: 'Dogi Terminal',
          instructions: systemPrompt,
          model: model as never,
          tools: tools as never
        })
        return this.runStreamWithRetry(requestId, {
          controller,
          maxRetries: resolveMaxRetries(settings.maxRetries),
          conversationId: req.conversationId,
          start: () =>
            agent.stream(modelMessages as never, {
              maxSteps: settings.maxSteps ?? DEFAULT_MAX_STEPS,
              abortSignal: controller.signal,
              modelSettings: this.mastraModelSettings(config, settings)
            }) as unknown as Promise<{ fullStream: AsyncIterable<unknown>; usage?: Promise<unknown> }>
        })
      })
      .catch((err) => this.failPreparation(requestId, controller, err))
    return { requestId }
  }

  /** 终端助手对话的**准备阶段**（同 chatWorkspace → prepareWorkspaceTurn 的分工） */
  private async prepareTerminalTurn(
    requestId: string,
    controller: AbortController,
    req: AgentChatRequest,
    settings: AiSettings,
    config: AiModelConfig
  ): Promise<{
    model: ReturnType<typeof resolveModel>
    tools: ToolSet
    systemPrompt: string
    modelMessages: Awaited<ReturnType<typeof compressContext>>['messages']
  }> {
    const { tools: mcpTools, errors: mcpErrors } = await mcpManager.buildToolset()
    const permissionMode = asPermissionMode(settings.permissionMode)
    const ctx: ToolRunContext = {
      requestId,
      conversationId: req.conversationId,
      scope: 'terminal',
      targetSessionId: req.targetSessionId ?? null,
      signal: controller.signal,
      permissionMode,
      requestConfirm: (r) =>
        this.requestConfirm({ ...r, requestId, conversationId: req.conversationId }),
      queueToolExecution: (fn) => this.queueToolExecution(requestId, fn)
    }
    const tools: ToolSet = toolRegistry.buildToolset({
      ctx,
      extra: mcpTools,
      clientTools: this.clientToolExecutors(req)
    })

    const model = resolveModel(config, req.modelId)
    const historyLimit = config.contextMessages ?? 20

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

    // ⚠️ 系统提示词必须在压缩**之前**算好：它每轮都发出去却不进 messages，
    // 不计入 baseTokens 的话统计会明显偏小（提示条上「压缩前后」会看着没变化）。
    const baseTokens = await estimateBaseTokens(systemPrompt, tools)

    // 与工作区同口径：先按条数截断，再按上下文窗口压缩（只影响本次请求，不动历史）。
    // 终端会话不支持手动压缩（没有检查点），自动压缩照常生效。
    const { messages: modelMessages, compressed } = await compressContext(
      toModelMessages(req.history.slice(-historyLimit)),
      {
        model: config,
        modelId: req.modelId,
        baseTokens,
        signal: controller.signal
      }
    )
    if (compressed) {
      // ⚠️ 延后到 invoke 回包之后：渲染端在 await 返回之后才登记 requestId → 会话，
      // 此刻发出的事件认不出归属会被丢掉（同 chatWorkspace / ipc/agent.ts 的说明）。
      const info = compressed
      setTimeout(() => this.emitEvent(requestId, { type: 'context-compressed', info }), 0)
    }
    return { model, tools, systemPrompt, modelMessages }
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
      /** 用于收尾时清掉「运行中插话」的残留（见 steer.ts） */
      conversationId: string
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
      // 本轮结束：丢掉没赶上工具步的插话（渲染端那条 user 消息仍在历史里，下一轮照样看得到）
      steerRegistry.clear(opts.conversationId)
    }
  }

  /**
   * **运行中插话**：把用户这句话排进「下一个工具步边界」（见 steer.ts）。
   *
   * 返回 false = 这条会话此刻没有在跑的一轮 —— 那就不是插话，该走正常的发消息。
   * 渲染端据此决定提示（不会真的丢：它本来就是按普通消息发的）。
   *
   * ⚠️ 准入只看「有没有在跑」，**不看准备阶段是否结束**：准备阶段（MCP 启动 /
   * 上下文压缩）正是用户最想插话的时刻，那时拒掉等于最需要它的时候用不了。
   */
  steer(conversationId: string, text: string): boolean {
    if (!this.isConversationRunning(conversationId)) return false
    steerRegistry.push(conversationId, text)
    return true
  }

  /** 这条会话此刻有没有在跑的一轮（工作区 / 终端两条线共用 requestMeta） */
  private isConversationRunning(conversationId: string): boolean {
    for (const meta of this.requestMeta.values()) {
      if (meta.conversationId === conversationId) return true
    }
    return false
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
