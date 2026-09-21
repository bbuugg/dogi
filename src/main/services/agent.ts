/**
 * AI Agent（工作区编程/运维助手）服务。
 *
 * 核心能力来自 npm workspace 包 @opsdesk/ai-agent（工具集 / 系统提示词 / 事件适配），
 * 这里只做三件事：
 * 1. 用当前激活的 AI 模型配置把对话跑起来（streamText，复用 ai.ts 的 resolveModel）；
 * 2. 绑定工作区：工具全部限定在该目录内读写与执行命令；
 * 3. 确认模式：execute_command 执行前先请示用户（串行弹卡，超时按取消）。
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
} from '@opsdesk/ai-agent'
import type {
  AgentChatRequest,
  AgentConfirmRequest,
  AgentStreamEvent
} from '@shared/types'
import { resolveModel } from './ai'
import { storage } from './storage'

/** 确认模式下等待用户响应的最长时间，超时按「取消」处理 */
const CONFIRM_TIMEOUT_MS = 10 * 60 * 1000

/** 由 ipc 层注入：把确认请求与其最终结果广播给渲染进程 */
export interface AgentConfirmSink {
  request(req: AgentConfirmRequest): void
  resolved(id: string): void
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

interface PendingConfirm {
  requestId: string
  resolve: (approved: boolean) => void
  timer: ReturnType<typeof setTimeout>
}

/**
 * Agent 服务：一次对话绑定一个工作区，工具作用于该目录。
 * 确认请求串行弹出（同一时刻只等一张卡）；中止时释放挂起的确认与请求。
 */
class AgentService extends EventEmitter {
  private confirmSink: AgentConfirmSink | null = null
  private abortControllers = new Map<string, AbortController>()
  private pendingConfirms = new Map<string, PendingConfirm>()
  /** 确认请求串行链：前一个确认被应答（或超时）后才弹下一个 */
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

  /** 渲染进程回复确认结果 */
  resolveConfirm(id: string, approved: boolean): void {
    const pending = this.pendingConfirms.get(id)
    if (!pending) return
    clearTimeout(pending.timer)
    pending.resolve(approved)
  }

  /** 结束挂起的确认（中止对话 / 流结束兜底），按「取消」处理 */
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
    const config = settings.activeConfigId
      ? storage.getAiConfig(settings.activeConfigId)
      : undefined

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

    const tools: ToolSet = buildAgentTools(workspace.path, {
      permissionMode: settings.permissionMode === 'confirm' ? 'confirm' : 'full',
      requestConfirm: (r) =>
        this.requestConfirm(workspace.name, { requestId, ...r })
    })

    const model = resolveModel(config)
    const historyLimit = config.contextMessages ?? 20
    const modelMessages = toModelMessages(req.history).slice(-historyLimit)

    const result = streamText({
      model,
      system: buildAgentSystemPrompt(workspace.path, workspace.name),
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
        const event = adaptAgentPart(part)
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

  private emitEvent(requestId: string, event: AgentStreamEvent): void {
    this.emit('chat-event', requestId, event)
  }

  /** 中止某次对话：释放挂起的确认并中止底层请求 */
  abort(requestId: string): void {
    this.clearPendingConfirms(requestId)
    this.abortControllers.get(requestId)?.abort()
  }
}

export const agentService = new AgentService()
