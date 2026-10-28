/**
 * 内置 agent 的流式引擎：**AI SDK 的 `streamText` + 多步工具循环**，把它的 part 映射成
 * fizz 自己的 `AgentStreamEvent`。
 *
 * 直接用 AI SDK 的 part 契约（`text-delta` / `tool-call` / `finish-step` …）：
 * 字段名稳定、没有额外的 `payload` 包装，所以「字段写错 → 静默失效」这类问题只可能
 * 出在本文件的一处映射里（`adaptStreamPart`），排查成本最低。
 *
 * 本文件只负责「跑一轮、吐事件」，不碰领域逻辑（压缩、插话、用量记账都在 `agent.ts`）。
 */
import {
  stepCountIs,
  streamText,
  type LanguageModel,
  type ModelMessage,
  type ToolSet
} from 'ai'
import type { AgentStreamEvent } from '@fizz/contracts/types'

/** 一个工具步结束、下一步请求之前：可以改写下一步的 messages（插话注入 / 轮中压缩） */
export interface EngineStepBoundary {
  /** 即将发出去的完整消息数组（含此前所有工具结果） */
  messages: ModelMessage[]
  /** 已经跑完的步数（0 = 第一次请求之前） */
  stepNumber: number
}

export interface AgentEngineOptions {
  model: LanguageModel
  system: string
  messages: ModelMessage[]
  tools: ToolSet
  /** 最大步数（一次请求 + 一轮工具执行 = 1 步） */
  maxSteps: number
  abortSignal?: AbortSignal
  modelSettings?: { maxOutputTokens?: number; temperature?: number }
  /**
   * 同时执行的工具调用上限。模型一批并行下发 tool-call 时，全放开会把彼此的
   * 命令 / 输出拖到超时（`execute_command` 尤其明显）。
   */
  toolCallConcurrency?: number
  onStepBoundary?: (
    ctx: EngineStepBoundary
  ) => Promise<ModelMessage[] | void> | ModelMessage[] | void
}

export interface AgentEngineResult {
  /** 'stop' | 'length' | 'tool-calls' | 'error' | 'other' | 'aborted' …（AI SDK 原值） */
  finishReason: string
  /** 整轮累计（多步相加） */
  totalUsage?: unknown
  /** **最后一步**的 usage —— 它才是「当前上下文有多大」 */
  lastStepUsage?: unknown
  error?: unknown
}

export interface AgentEngine {
  /** 内容事件流（不含 finish / error：那两个由调用方按自己的口径发） */
  events: AsyncIterable<AgentStreamEvent>
  /** 流结束（正常 / 中止 / 报错都会 resolve，不会悬挂） */
  done: Promise<AgentEngineResult>
}

/** 把 tool 的 execute 套一层信号量：并发超限就排队，不改变返回值 */
function limitToolConcurrency(tools: ToolSet, limit: number): ToolSet {
  if (!Number.isFinite(limit) || limit <= 0) return tools
  let active = 0
  const waiting: Array<() => void> = []
  const acquire = (): Promise<void> =>
    active < limit
      ? Promise.resolve().then(() => {
          active += 1
        })
      : new Promise<void>((resolve) =>
          waiting.push(() => {
            active += 1
            resolve()
          })
        )
  const release = (): void => {
    active -= 1
    const next = waiting.shift()
    if (next) next()
  }
  const out: ToolSet = {}
  for (const [name, tool] of Object.entries(tools)) {
    const execute = (tool as { execute?: (...args: unknown[]) => unknown }).execute
    if (typeof execute !== 'function') {
      out[name] = tool
      continue
    }
    out[name] = {
      ...tool,
      execute: async (...args: unknown[]) => {
        await acquire()
        try {
          return await execute(...args)
        } finally {
          release()
        }
      }
    } as ToolSet[string]
  }
  return out
}

/** 把 AI SDK 的一个 fullStream part 折成 fizz 的事件；不是内容就返回 null */
export function adaptStreamPart(part: unknown): AgentStreamEvent | null {
  if (!part || typeof part !== 'object') return null
  const p = part as Record<string, unknown>
  const type = typeof p.type === 'string' ? p.type : ''
  const text = (v: unknown): string => (typeof v === 'string' ? v : '')
  switch (type) {
    case 'text-delta':
      return { type: 'text-delta', delta: text(p.text) }
    case 'reasoning-delta':
      return { type: 'reasoning-delta', delta: text(p.text) }
    /**
     * 入参开始流式生成：只有 id + 工具名，还没有内容。转成一条空增量 ——
     * 卡片据此**先建出来**，标题马上是对的（否则要等完整 tool-call，卡片会先显示
     * 一会儿「工具调用」）。
     */
    case 'tool-input-start':
      return {
        type: 'tool-call-delta',
        toolCallId: text(p.id) || text(p.toolCallId),
        ...(text(p.toolName) ? { toolName: text(p.toolName) } : {}),
        inputTextDelta: ''
      }
    case 'tool-input-delta':
      return {
        type: 'tool-call-delta',
        toolCallId: text(p.id) || text(p.toolCallId),
        inputTextDelta: text(p.delta)
      }
    case 'tool-call':
      return {
        type: 'tool-call',
        toolCallId: text(p.toolCallId) || text(p.id),
        toolName: text(p.toolName),
        input: p.input ?? p.args ?? null
      }
    case 'tool-result':
      return {
        type: 'tool-result',
        toolCallId: text(p.toolCallId) || text(p.id),
        toolName: text(p.toolName),
        output: p.output
      }
    /** 工具自己抛错：仍然要落一条 result（带 isError），否则卡片永远转圈 */
    case 'tool-error':
      return {
        type: 'tool-result',
        toolCallId: text(p.toolCallId) || text(p.id),
        toolName: text(p.toolName),
        output: errorText(p.error),
        isError: true
      }
    case 'error':
      return { type: 'error', message: errorText(p.error) }
    default:
      return null
  }
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  try {
    return JSON.stringify(err) ?? String(err)
  } catch {
    return String(err)
  }
}

/**
 * 起一轮。调用方 `for await` 消费 `events`，结束后 `await done` 拿收尾信息。
 *
 * 时序要点：
 * - `prepareStep` 在**每次请求之前**调用（含第一次，stepNumber=0），返回值里的 `messages`
 *   就是下一步真正发出去的内容 —— 插话注入和轮中压缩都挂在这里；
 * - `prepareStep` **只在「还有下一步」时才会被调**，所以它天然不会出现
 *   「最后一步之后再压一次」的情形，不需要额外的 `isFinal` 判断；
 * - `finish` / `finish-step` part 带 usage：前者是整轮累计，后者是单步 —— 别混用。
 */
export function runEngine(opts: AgentEngineOptions): AgentEngine {
  const tools = limitToolConcurrency(opts.tools, opts.toolCallConcurrency ?? 0)

  const result = streamText({
    model: opts.model,
    system: opts.system,
    messages: opts.messages,
    tools,
    stopWhen: stepCountIs(Math.max(1, opts.maxSteps)),
    ...(opts.abortSignal ? { abortSignal: opts.abortSignal } : {}),
    ...(opts.modelSettings
      ? {
          ...(opts.modelSettings.maxOutputTokens !== undefined
            ? { maxOutputTokens: opts.modelSettings.maxOutputTokens }
            : {}),
          ...(opts.modelSettings.temperature !== undefined
            ? { temperature: opts.modelSettings.temperature }
            : {})
        }
      : {}),
    prepareStep: async ({ messages, stepNumber }) => {
      const next = await opts.onStepBoundary?.({ messages, stepNumber })
      return next ? { messages: next } : undefined
    }
  })

  let finishReason = 'other'
  let totalUsage: unknown
  let lastStepUsage: unknown
  let error: unknown
  let settle!: (result: AgentEngineResult) => void
  const done = new Promise<AgentEngineResult>((resolve) => {
    settle = resolve
  })

  /**
   * `done` 在生成器的 `finally` 里收尾：调用方可能中途 `break`（用户停止 / 看门狗），
   * 那时生成器会被 `return()`，finally 照常执行。
   *
   * ⚠️ 不能让 `done` 自己再 `for await` 一遍同一个流 —— 两个消费者会把事件对半分。
   * 也不能 `await result.finishReason`：流没跑完时它可能永远不 resolve。
   */
  /**
   * `FIZZ_DEBUG_CHUNKS=1`：把**本次出现过的 part 类型**逐个打一次（附原始片段）。
   *
   * 排障用。认不出来的类型在这里会露出来 —— 否则某个内容没渲染时，只能靠猜是「上游没发」
   * 还是「我们没认出来」。只在首次出现时打，避免流式期间刷屏。
   */
  const debugParts = process.env.FIZZ_DEBUG_CHUNKS === '1'
  const seenPartTypes = new Set<string>()

  async function* generate(): AsyncGenerator<AgentStreamEvent> {
    try {
      for await (const part of result.fullStream) {
        const p = part as Record<string, unknown>
        if (debugParts && typeof p.type === 'string' && !seenPartTypes.has(p.type)) {
          seenPartTypes.add(p.type)
          console.log(
            '[chunk] 首次出现的 part 类型：' + p.type + ' ' + JSON.stringify(part).slice(0, 300)
          )
        }
        if (p.type === 'finish-step') {
          // 单步 usage：最后一次请求的那个才是「当前上下文有多大」
          if (p.usage) lastStepUsage = p.usage
          if (typeof p.finishReason === 'string') finishReason = p.finishReason
          continue
        }
        if (p.type === 'finish') {
          if (p.totalUsage) totalUsage = p.totalUsage
          if (typeof p.finishReason === 'string') finishReason = p.finishReason
          continue
        }
        if (p.type === 'abort') {
          finishReason = 'aborted'
          continue
        }
        const event = adaptStreamPart(part)
        if (!event) continue
        if (event.type === 'error') error = p.error ?? event.message
        yield event
      }
    } catch (err) {
      error = err
      throw err
    } finally {
      if (opts.abortSignal?.aborted && finishReason === 'other') finishReason = 'aborted'
      settle({ finishReason, totalUsage, lastStepUsage, error })
    }
  }

  return { events: generate(), done }
}
