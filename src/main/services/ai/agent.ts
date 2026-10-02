/**
 * AI Agent（工作区编程/运维助手）服务 —— **内置 Mastra agent 这一条路径**。
 *
 * 核心能力来自同目录下的 agent-core（工具集 / 系统提示词 / 事件适配），
 * 这里只做四件事：
 * 1. 用会话选中的 AI 模型配置把对话跑起来（Mastra Agent.stream，模型解析复用 resolve-model）；
 * 2. 绑定工作区：工具全部限定在该目录内读写与执行命令；
 * 3. 确认模式：**会改动东西的工具**（执行命令 / 写入 / 编辑 / 删除）执行前先请示用户
 *    （串行弹卡；默认不限时，中止即释放；闸门在 agent-core/tools.ts 的 guardWrite）；
 * 4. 中止：走 AbortController。
 *
 * ⚠️ 原生 AI SDK（`ai` 包的 `streamText`）路径已整体移除：现在只有两种 agent ——
 * 本文件的 Mastra agent，以及 `acp-agent.ts` 的外部 ACP agent（消息归 agent 自己管）。
 * 磁盘上 `backend: 'ai-sdk'` 的旧会话由 storage 读取时迁移为 mastra。
 */
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type { ToolSet } from 'ai'
import {
  adaptMastraPart,
  buildAgentSystemPrompt,
  buildAgentTools,
  createAgentFileState,
  toModelMessages,
  type AgentFileState
} from './agent-core'
import type {
  AgentChatRequest,
  AgentConfirmRequest,
  AgentStreamEvent,
  BrowserChannel
} from '@shared/types'
import { resolveModel } from './ai'
import { compressContext } from './context'
import { askFollowupBroker, buildAskFollowupTool } from './ask-followup'
import { armConfirmTimeout, modelRunTimeout } from './timeouts'
import { DEFAULT_MAX_STEPS, resolveMaxRetries } from '@shared/ai-timeouts'
import { describeError, isRetryableNetworkError } from './error-utils'
import { retryDelayMs, sleepWithSignal } from './retry'
import { createToolInputThrottle } from './tool-input-throttle'
import { skillsForAgent } from './skills'
import { findGitBash } from '../terminal/shells'
import { ASK_FOLLOWUP_HINT } from '@shared/ask-followup'
import { agentBrowserSessionId } from '@shared/browser'
import { buildBrowserAgentTools, BROWSER_PROMPT_SECTION } from '../browser/agent'
import { mcpManager } from './mcp'
import { storage } from '../storage'

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
  /**
   * 「先读后改」状态按会话持有（read_file 记录快照，write/edit 校验）。
   * 工具集每轮重建，状态必须活在服务里才跨得了轮；超过上限丢弃最早的会话
   * （丢了的后果只是那条会话下次要先重读一遍，无正确性风险）。
   */
  private fileStates = new Map<string, AgentFileState>()
  private static readonly MAX_FILE_STATES = 64

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

  /**
   * 内置 Mastra agent 的一条对话。
   *
   * 模型按会话独立：优先用请求里带的 `configId`，回退到设置里的默认模型；
   * 会话选的配置被删掉时也要回退，否则这个会话会直接报「未配置」。
   */
  async chat(req: AgentChatRequest): Promise<{ requestId: string }> {
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

    // 技能每次对话现扫（磁盘即真源，用户随时可以往技能目录里丢东西）：
    // 清单进系统提示词，正文由 read_skill 工具按需读取
    const skills = await skillsForAgent(workspace.path)
    const { tools: mcpTools, errors: mcpErrors } = await mcpManager.buildToolset()
    if (mcpErrors.length) console.warn('[agent] MCP 工具加载异常：', mcpErrors.join('；'))
    const tools: ToolSet = {
      ...buildAgentTools(workspace.path, {
        permissionMode: settings.permissionMode === 'confirm' ? 'confirm' : 'full',
        requestConfirm: (r) => this.requestConfirm(workspace.name, { requestId, ...r }),
        skills,
        bashPath: agentBashPath(),
        fileState: this.fileStateFor(req.conversationId)
      }),
      // 浏览器能力：默认用应用自带的（无窗口、画面在面板里）；只有内置 Playwright MCP
      // 被显式打开时才让位给它（两者同名工具互斥，见 appBrowserTools）
      ...appBrowserTools(req, workspace.path, mcpTools),
      // 其余用户在设置里添加的 MCP server 在此统一注入（见 services/ai/mcp.ts）
      ...mcpTools,
      // 提问工具不走确认流程：提问本身就是让用户在卡片上做决定
      ...buildAskFollowupTool(requestId)
    }
    const hasBrowser = Object.keys(tools).some((k) => k.startsWith('browser_'))
    // ⚠️ 必须带上 req.modelId：会话在「同一配置下切换具体模型」时，modelId 是用户选的，
    // 不传就回退到配置的默认模型 —— 表现为「切换模型不生效，请求还在用旧模型」。
    const model = resolveModel(config, req.modelId)
    const historyLimit = config.contextMessages ?? 20
    // 两道独立的闸：先按**条数**截断（contextMessages），再按**token**压缩（contextBudget）。
    // 压缩只改「这一次请求怎么带上下文」，不碰落盘的历史（屏幕上的原文始终可翻可复制）。
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
    const maxRetries = resolveMaxRetries(settings.maxRetries)
    void this.runStreamWithRetry(requestId, {
      controller,
      maxRetries,
      start: () =>
        agent.stream(modelMessages as never, {
          maxSteps: settings.maxSteps ?? DEFAULT_MAX_STEPS,
          abortSignal: controller.signal,
          modelSettings: {
            // mastra 侧同样默认不限时；只设 firstChunkMs（见 timeouts.ts）
            timeout: modelRunTimeout(settings.modelTimeoutMs),
            // 重试由 runStreamWithRetry 自己驱动，SDK 内部重试关掉（否则两套叠加、事件对不上）
            maxRetries: 0,
            ...(config.temperature !== undefined ? { temperature: config.temperature } : {}),
            ...(config.maxTokens !== undefined ? { maxOutputTokens: config.maxTokens } : {})
          }
        }) as unknown as Promise<{ fullStream: AsyncIterable<unknown>; usage?: Promise<unknown> }>
    })
    return { requestId }
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
              send({
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
