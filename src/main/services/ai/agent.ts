/**
 * AI Agent（工作区编程/运维助手）服务。
 *
 * 核心能力来自同目录下的 agent-core（工具集 / 系统提示词 / 事件适配），
 * 这里只做三件事：
 * 1. 用当前激活的 AI 模型配置把对话跑起来（streamText，复用 ai.ts 的 resolveModel）；
 * 2. 绑定工作区：工具全部限定在该目录内读写与执行命令；
 * 3. 确认模式：**会改动东西的工具**（执行命令 / 写入 / 编辑 / 删除）执行前先请示用户
 *    （串行弹卡；默认不限时，中止即释放；闸门在 agent-core/tools.ts 的 guardWrite）。
 */
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { streamText, stepCountIs, type ToolSet } from 'ai'
import {
  MAX_STEPS,
  adaptAgentPart,
  buildAgentSystemPrompt,
  buildAgentTools,
  toModelMessages
} from './agent-core'
import type {
  AgentChatRequest,
  AgentConfirmRequest,
  AgentStreamEvent,
  BrowserChannel
} from '@shared/types'
import { resolveModel } from './ai'
import { askFollowupBroker, buildAskFollowupTool } from './ask-followup'
import { armConfirmTimeout, modelRunTimeout, modelStreamTimeout } from './timeouts'
import { skillsForAgent } from './skills'
import { ASK_FOLLOWUP_HINT } from '@shared/ask-followup'
import { agentBrowserSessionId } from '@shared/browser'
import { buildBrowserAgentTools, BROWSER_PROMPT_SECTION } from '../browser/agent'
import { mcpManager } from './mcp'
import { storage } from '../storage'

/**
 * 应用**自带**的浏览器工具：浏览器无窗口运行，画面通过 screencast 镜像到界面里的浏览器面板
 * （会话 id 由 conversationId 推导，与面板用同一个 id —— 见 @shared/browser）。
 *
 * 只在浏览器工具选了 `in-app` 时才挂：
 * - `off`：一个浏览器工具都不给（Agent 不该碰浏览器）；
 * - `system`：交给内置 Playwright MCP（拉起本机窗口），**这里让位** ——
 *   两套工具同名（`browser_navigate` 等），同时注册会静默互相覆盖；
 * - `in-app`：走这一套（默认）。此外若用户自己配的 MCP 也带 `browser_*`，同样让位，
 *   避免同名覆盖。
 */
function appBrowserTools(req: AgentChatRequest, workspacePath: string, mcpTools: ToolSet): ToolSet {
  if ((storage.getPreferences().browserToolMode ?? 'in-app') !== 'in-app') return {}
  if (Object.keys(mcpTools).some((k) => k.startsWith('browser_'))) return {}
  return buildBrowserAgentTools({
    sessionId: agentBrowserSessionId(req.conversationId),
    channel: (storage.getPreferences().browserChannel ?? 'auto') as BrowserChannel,
    workspaceRoot: workspacePath
  })
}

/** 由 ipc 层注入：把确认请求与其最终结果广播给渲染进程 */
export interface AgentConfirmSink {
  request(req: AgentConfirmRequest): void
  resolved(id: string): void
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

/** 将 Mastra 流事件转换为 Agent 流事件。
 *  Mastra 的 fullStream 块为 { type, payload: {...} } 形态（文本/思考在 payload.text，
 *  工具在 payload.{toolCallId,toolName,args/result}），这里同时兼容 AI SDK 原生形态做兜底。 */
function adaptMastraPart(part: {
  type?: string
  payload?: {
    text?: unknown
    toolCallId?: unknown
    toolName?: unknown
    args?: unknown
    input?: unknown
    result?: unknown
    output?: unknown
    error?: unknown
  }
  [k: string]: unknown
}): AgentStreamEvent | null {
  const payload = part.payload
  const str = (v: unknown) => (v == null ? '' : String(v))
  switch (part.type) {
    case 'text':
    case 'text-delta':
      return { type: 'text-delta', delta: str(payload?.text ?? part.text ?? part.textDelta ?? part.delta) }
    case 'reasoning':
    case 'reasoning-delta': {
      const delta = str(payload?.text ?? part.reasoning ?? part.text ?? part.textDelta ?? part.delta)
      return delta ? { type: 'reasoning-delta', delta } : null
    }
    case 'tool-call':
      return {
        type: 'tool-call',
        toolCallId: str(payload?.toolCallId ?? part.toolCallId),
        toolName: str(payload?.toolName ?? part.toolName),
        input: (payload?.args ?? payload?.input ?? part.args ?? part.input ?? null) as unknown
      }
    case 'tool-result':
      return {
        type: 'tool-result',
        toolCallId: str(payload?.toolCallId ?? part.toolCallId),
        toolName: str(payload?.toolName ?? part.toolName),
        output: (payload?.result ?? payload?.output ?? part.result ?? part.output ?? null) as unknown,
        // 有的版本把失败也塞在 tool-result 里（带 isError），一并认下来，
        // 否则那行会显示成「已完成」而不是「失败」
        ...((payload as { isError?: unknown } | undefined)?.isError === true ||
        (part as { isError?: unknown }).isError === true
          ? { isError: true }
          : {})
      }
    /**
     * 工具**抛错**时 mastra 发的不是 `tool-result` 而是 `tool-error`。
     *
     * 漏掉这一个分支的代价很直观：块落到 default 被丢掉 → 那条工具行永远停在「调用中」，
     * 后面几步都跑完了它还转圈（读取不存在的文件、路径是目录… 这类报错最容易碰到）。
     * 与 ai-sdk 路径（agent-core/agent.ts）以及终端助手（ai.ts）的适配保持一致。
     */
    case 'tool-error':
      return {
        type: 'tool-result',
        toolCallId: str(payload?.toolCallId ?? part.toolCallId),
        toolName: str(payload?.toolName ?? part.toolName),
        output: `工具执行失败: ${describeError(payload?.error ?? part.error)}`,
        isError: true
      }
    case 'error':
      return { type: 'error', message: describeError(payload?.error ?? part.error) }
    default:
      return null
  }
}

interface PendingConfirm {
  requestId: string
  resolve: (approved: boolean) => void
  /** 兜底定时器；按默认配置（不限时）时是 undefined（见 timeouts.ts） */
  timer?: ReturnType<typeof setTimeout>
}

/**
 * Agent 服务：一次对话绑定一个工作区，工具作用于该目录。
 * 确认请求串行弹出（同一时刻只等一张卡）；中止时释放挂起的确认与请求。
 */
class AgentService extends EventEmitter {
  private confirmSink: AgentConfirmSink | null = null
  private abortControllers = new Map<string, AbortController>()
  private pendingConfirms = new Map<string, PendingConfirm>()
  /** 确认请求串行链：前一个确认被应答（或中止）后才弹下一个 */
  private confirmChain: Promise<unknown> = Promise.resolve()

  setConfirmSink(sink: AgentConfirmSink | null): void {
    this.confirmSink = sink
  }

  /** 等待用户确认；无 UI 接入时放行，避免流程卡死 */
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
      const timer = armConfirmTimeout(
        () => settle(false),
        storage.getAiSettings().confirmTimeoutMs
      )
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

  async chat(req: AgentChatRequest): Promise<{ requestId: string }> {
    const requestId = randomUUID()
    const workspace = storage.getAgentWorkspace(req.workspaceId)
    const settings = storage.getAiSettings()
    // 模型按会话独立：优先用请求里带的 configId，回退到设置里的默认模型。
    // 会话选的配置被删掉时也要回退，否则这个会话会直接报「未配置」。
    const config =
      (req.configId ? storage.getAiConfig(req.configId) : undefined) ??
      (settings.activeConfigId ? storage.getAiConfig(settings.activeConfigId) : undefined)

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
    if (!config) {
      fail('尚未配置 AI 模型，请先在设置中添加模型配置')
      return { requestId }
    }

    const controller = new AbortController()
    this.abortControllers.set(requestId, controller)

    // 技能每次对话现扫（磁盘即真源，用户随时可以往技能目录里丢东西）：
    // 清单进系统提示词，正文由 read_skill 工具按需读取
    const skills = await skillsForAgent(workspace.path)

    const { tools: mcpTools, errors: mcpErrors } = await mcpManager.buildToolset()
    if (mcpErrors.length) console.warn('[agent] MCP 工具加载异常：', mcpErrors.join('；'))
    const tools: ToolSet = {
      ...buildAgentTools(workspace.path, {
        permissionMode: settings.permissionMode === 'confirm' ? 'confirm' : 'full',
        requestConfirm: (r) =>
          this.requestConfirm(workspace.name, { requestId, ...r }),
        skills
      }),
      // 浏览器能力：默认用应用自带的（无窗口、画面在面板里）；只有内置 Playwright MCP
      // 被显式打开时才让位给它（两者同名工具互斥，见 appBrowserTools）
      ...appBrowserTools(req, workspace.path, mcpTools),
      // 其余用户在设置里添加的 MCP server 在此统一注入（见 services/ai/mcp.ts）
      ...mcpTools,
      // 提问工具不走确认流程：提问本身就是让用户在卡片上做决定
      ...buildAskFollowupTool(requestId)
    }

    const model = resolveModel(config)
    const historyLimit = config.contextMessages ?? 20
    const modelMessages = toModelMessages(req.history.slice(-historyLimit))

    const result = streamText({
      model,
      system:
        buildAgentSystemPrompt(workspace.path, workspace.name, skills) +
        (Object.keys(tools).some((k) => k.startsWith('browser_'))
          ? '\n\n' + BROWSER_PROMPT_SECTION
          : '') +
        ASK_FOLLOWUP_HINT,
      messages: modelMessages,
      tools,
      stopWhen: stepCountIs(MAX_STEPS),
      abortSignal: controller.signal,
      // 流超时（设置里可改）：默认 5 分钟等不到第一个内容块就判连接死了
      timeout: modelStreamTimeout(settings.modelTimeoutMs),
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
    const startedAt = Date.now()
    let firstTokenAt = 0
    try {
      for await (const part of result.fullStream) {
        // 记下首字时间，用来算「生成窗口」（首字 → 结束），更贴近真实输出速度
        if ((part.type === 'text-delta' || part.type === 'reasoning-delta') && !firstTokenAt) {
          firstTokenAt = Date.now()
        }
        const event = adaptAgentPart(part)
        if (event) this.emitEvent(requestId, event)
      }
      // 用量独立采集：拿不到（部分 provider 不回报）也不影响整轮消息
      try {
        const u = (await result.usage) as
          | {
              promptTokens?: number
              completionTokens?: number
              totalTokens?: number
              reasoningTokens?: number
              cachedInputTokens?: number
              // OpenAI responses 风格（apiStyle=responses / openai.responses 提供方）的字段名
              inputTokens?: number
              outputTokens?: number
            }
          | undefined
        if (u) {
          const endAt = Date.now()
          const durationMs = endAt - startedAt
          const genWindowMs = firstTokenAt ? endAt - firstTokenAt : durationMs
          // 同时兼容 chat 风格（promptTokens/completionTokens）与 responses 风格（inputTokens/outputTokens）
          const inputTokens = u.promptTokens ?? u.inputTokens ?? 0
          const outputTokens = u.completionTokens ?? u.outputTokens ?? 0
          const tps = genWindowMs > 0 ? outputTokens / (genWindowMs / 1000) : 0
          this.emitEvent(requestId, {
            type: 'usage',
            usage: {
              inputTokens,
              outputTokens,
              totalTokens: u.totalTokens ?? 0,
              ...(u.reasoningTokens != null ? { reasoningTokens: u.reasoningTokens } : {}),
              ...(u.cachedInputTokens != null ? { cachedInputTokens: u.cachedInputTokens } : {}),
              durationMs,
              tps: Math.round(tps * 10) / 10
            }
          })
        }
      } catch {
        // 用量缺失时静默跳过
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
    }
  }

  /** Mastra 后端实现（实验性）：编排改用 Mastra Agent.stream，工具与模型与 ai-sdk 路径完全一致 */
  async mastraChat(req: AgentChatRequest): Promise<{ requestId: string }> {
    const requestId = randomUUID()
    const workspace = storage.getAgentWorkspace(req.workspaceId)
    const settings = storage.getAiSettings()
    const config =
      (req.configId ? storage.getAiConfig(req.configId) : undefined) ??
      (settings.activeConfigId ? storage.getAiConfig(settings.activeConfigId) : undefined)

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

    const skills = await skillsForAgent(workspace.path)
    const { tools: mcpTools, errors: mcpErrors } = await mcpManager.buildToolset()
    if (mcpErrors.length) console.warn('[agent] MCP 工具加载异常：', mcpErrors.join('；'))
    const tools: ToolSet = {
      ...buildAgentTools(workspace.path, {
        permissionMode: settings.permissionMode === 'confirm' ? 'confirm' : 'full',
        requestConfirm: (r) => this.requestConfirm(workspace.name, { requestId, ...r }),
        skills
      }),
      // 同上：自带浏览器工具与内置 MCP 的 browser_* 互斥
      ...appBrowserTools(req, workspace.path, mcpTools),
      ...mcpTools,
      ...buildAskFollowupTool(requestId)
    }
    const hasBrowser = Object.keys(tools).some((k) => k.startsWith('browser_'))
    const model = resolveModel(config)
    const historyLimit = config.contextMessages ?? 20
    const modelMessages = toModelMessages(req.history.slice(-historyLimit))

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

    let stream: { fullStream: AsyncIterable<unknown>; usage?: Promise<unknown> }
    try {
      stream = (await agent.stream(modelMessages as never, {
        maxSteps: MAX_STEPS,
        abortSignal: controller.signal,
        modelSettings: {
          // mastra 侧同样默认不限时；只设 firstChunkMs（见 timeouts.ts）
          timeout: modelRunTimeout(settings.modelTimeoutMs),
          ...(config.temperature !== undefined ? { temperature: config.temperature } : {}),
          ...(config.maxTokens !== undefined ? { maxOutputTokens: config.maxTokens } : {})
        }
      })) as typeof stream
    } catch (err) {
      fail(describeError(err))
      return { requestId }
    }

    void this.consumeMastraStream(requestId, stream)
    return { requestId }
  }

  private async consumeMastraStream(
    requestId: string,
    stream: { fullStream: AsyncIterable<unknown>; usage?: Promise<unknown> }
  ): Promise<void> {
    const startedAt = Date.now()
    let firstTokenAt = 0
    try {
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
        const event = adaptMastraPart(p)
        if (event) this.emitEvent(requestId, event)
      }
      try {
        const u = (await stream.usage) as
          | {
              promptTokens?: number
              completionTokens?: number
              totalTokens?: number
              reasoningTokens?: number
              cachedInputTokens?: number
              inputTokens?: number
              outputTokens?: number
            }
          | undefined
        if (u) {
          const endAt = Date.now()
          const durationMs = endAt - startedAt
          const genWindowMs = firstTokenAt ? endAt - firstTokenAt : durationMs
          const inputTokens = u.promptTokens ?? u.inputTokens ?? 0
          const outputTokens = u.completionTokens ?? u.outputTokens ?? 0
          const tps = genWindowMs > 0 ? outputTokens / (genWindowMs / 1000) : 0
          this.emitEvent(requestId, {
            type: 'usage',
            usage: {
              inputTokens,
              outputTokens,
              totalTokens: u.totalTokens ?? 0,
              ...(u.reasoningTokens != null ? { reasoningTokens: u.reasoningTokens } : {}),
              ...(u.cachedInputTokens != null ? { cachedInputTokens: u.cachedInputTokens } : {}),
              durationMs,
              tps: Math.round(tps * 10) / 10
            }
          })
        }
      } catch {
        // 用量缺失时静默跳过
      }
      this.emitEvent(requestId, { type: 'finish', finishReason: 'done' })
    } catch (err) {
      this.emitEvent(requestId, { type: 'error', message: describeError(err) })
      this.emitEvent(requestId, { type: 'finish', finishReason: 'error' })
    } finally {
      this.clearPendingConfirms(requestId)
      askFollowupBroker.cancel(requestId)
      this.abortControllers.delete(requestId)
    }
  }

  private emitEvent(requestId: string, event: AgentStreamEvent): void {
    this.emit('chat-event', requestId, event)
  }

  /** 中止某次对话：释放挂起的确认并中止底层请求 */
  abort(requestId: string): void {
    this.clearPendingConfirms(requestId)
    askFollowupBroker.cancel(requestId)
    this.abortControllers.get(requestId)?.abort()
  }
}

export const agentService = new AgentService()
