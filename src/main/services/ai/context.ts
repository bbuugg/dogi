/**
 * 上下文压缩：对话历史过长时，把「旧的若干轮」摘要成一段，只保留「近期原文」。
 *
 * 移植自 fishwork（packages/agent/src/context.ts），口径与取舍照搬：
 * - **按轮摘要**而不是按 token 滑窗 —— 滑窗从中间切断 tool-call / tool-result 会破坏协议
 *   （tool 消息必须紧跟它的 assistant），按轮切天然保持结构合法；
 * - 摘要请求失败 → 回退成「砍掉旧轮」（截断），保证请求还能发出去。
 *
 * 与 fishwork 的差异（都是 dogi 特有的约束）：
 * - **输入不是 ModelMessage[] 而是 AgentChatMessage[]**（parts 结构）。dogi 的历史存在
 *   renderer 的会话记录里，结构是 `parts`；先转 `ModelMessage[]` 再压缩，压缩结果直接喂
 *   `agent.stream()`，不落盘、不改会话记录 —— 压缩只是「这一次请求怎么带上下文」的策略，
 *   屏幕上的历史始终是原文（用户能翻、能复制、能编辑重发）。
 * - 预算来自 `AiModelConfig.contextBudget`（设置页可配），不是环境变量。
 */
import { generateText } from 'ai'
import type { ModelMessage } from 'ai'
import type { AiModelConfig, ContextCompression } from '@shared/types'
import { DEFAULT_CONTEXT_BUDGET, resolveContextBudget } from '@shared/context-budget'
import { resolveModel } from './resolve-model'

/** 默认上下文预算：真源在 shared（渲染端的用量圆环用同一个值算分母） */
export { DEFAULT_CONTEXT_BUDGET, resolveContextBudget }
/** 触发压缩后，保留的「近期原文」占预算的比例（其余的旧轮摘要掉） */
export const KEEP_RECENT_RATIO = 0.5
/** 摘要请求的最大输出 token */
export const SUMMARY_MAX_TOKENS = 2000

/** 摘要用的系统提示词：写清「保留什么 / 丢弃什么」，摘要质量好坏全看它 */
const SUMMARY_SYSTEM = [
  '你是对话摘要助手。下面是用中文写的一段对话历史的文本转写（每段开头标注了角色：用户 / 助手 / 工具）。',
  '请把它压缩成一段简洁的中文摘要，只保留对后续对话有用的信息。必须保留：',
  '  1. 用户的核心诉求 / 他想完成什么；',
  '  2. 已经得出的关键结论、已经做出的决定、已经改了什么（具体到文件 / 函数 / 配置项）；',
  '  3. 正在进行中、还没完的事：未完成的工具调用、待用户确认的操作、报错但还没解决的问题；',
  '  4. 后续轮次会用到的「事实」：路径、函数名、配置项名、报错原文、用户明确说过的约束。',
  '可以丢弃：客套话、重复的解释、中间过程的试错（除非报错本身是要点）、已经被后来的结论推翻的旧想法。',
  '不要在摘要里评价自己，也不要加「摘要如下：」这类前缀 —— 直接给摘要正文。'
].join('\n')

/**
 * 粗略 token 估算。
 *
 * 不用 tiktoken：它要 native deps、升级即失效，而这里只用来判「够不够」而不是精确数 ——
 * 差 20% 不影响是否触发压缩，所以取保守值，宁可早触发也不要漏触发。
 * 中文 1 字 ≈ 1.5 token，其余（英文 / 代码 / 符号）4 字符 ≈ 1 token。
 */
export function estimateTokens(text: string): number {
  if (!text) return 0
  let cjk = 0
  let other = 0
  for (const ch of text) {
    const code = ch.codePointAt(0)!
    if (code >= 0x4e00 && code <= 0x9fff) cjk++
    else other++
  }
  return Math.ceil(cjk * 1.5 + other * 0.25)
}

/**
 * 把一条 ModelMessage 的 content 展平成文本（供 token 估算与摘要输入用）。
 *
 * reasoning 等不回传给模型的内容也不进摘要 —— 节省预算，且对摘要无价值。
 */
function messageToText(m: ModelMessage): string {
  const { content } = m
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const out: string[] = []
  for (const part of content as Array<{ type: string } & Record<string, unknown>>) {
    if (part.type === 'text') {
      out.push(String(part.text ?? ''))
    } else if (part.type === 'tool-call') {
      out.push(`[调用工具 ${part.toolName ?? '?'}] ${JSON.stringify(part.input ?? {})}`)
    } else if (part.type === 'tool-result') {
      const o = part.output
      out.push(`[工具 ${part.toolName ?? '?'} 返回] ${typeof o === 'string' ? o : JSON.stringify(o ?? null)}`)
    }
    // reasoning / step-start / ...：不回传也不进摘要
  }
  return out.join('\n')
}

/** 一组消息的 token 数（手动压缩落检查点时要统计压缩前后，也是导出给外部用的） */
export function countTokens(messages: ModelMessage[]): number {
  let sum = 0
  for (const m of messages) sum += estimateTokens(messageToText(m))
  return sum
}

/** 把对话文本转写成「角色标注」的纯文本，喂给摘要模型 */
function modelMessagesToText(messages: ModelMessage[]): string {
  const parts: string[] = []
  for (const m of messages) {
    const role = m.role === 'user' ? '用户' : m.role === 'assistant' ? '助手' : '工具'
    const text = messageToText(m)
    if (text.trim()) parts.push(`【${role}】\n${text}`)
  }
  return parts.join('\n\n')
}

/**
 * 只做「把这一段历史摘要成一段中文」这一件事 —— **自动压缩与手动检查点共用**。
 *
 * 失败返回 `null` 而不抛：调用方据此决定回退策略（自动压缩回退成截断继续发；
 * 手动压缩则整个操作失败、不落一个没有正文的检查点）。
 */
export async function summarizeHistory(
  messages: ModelMessage[],
  opts: {
    model: AiModelConfig
    modelId?: string
    maxTokens?: number
    signal?: AbortSignal
  }
): Promise<string | null> {
  try {
    const transcript = modelMessagesToText(messages)
    if (!transcript.trim()) return null
    const { text } = await generateText({
      model: resolveModel(opts.model, opts.modelId) as never,
      system: SUMMARY_SYSTEM,
      messages: [{ role: 'user', content: transcript }],
      maxOutputTokens: opts.maxTokens ?? SUMMARY_MAX_TOKENS,
      ...(opts.signal ? { abortSignal: opts.signal } : {})
    })
    return text?.trim() || null
  } catch (err) {
    console.warn('[context] 上下文摘要失败：', err)
    return null
  }
}

/**
 * 把消息切成「轮」：每个 user 消息开始新的一轮，tool 消息归到前一个 assistant 那轮。
 * 第一个消息如果不是 user（历史从 assistant / tool 中途开始），它独自成一轮（前导轮）。
 *
 * 泛型：自动压缩切 `ModelMessage[]`，手动压缩落检查点时切的是 `AgentChatMessage[]`
 * （要靠轮边界找到「最后一条保留的消息 id」）—— 两边规则必须一致，所以共用这一个函数。
 */
export function splitTurns<T extends { role: string }>(messages: T[]): T[][] {
  const turns: T[][] = []
  let current: T[] = []
  for (const m of messages) {
    if (m.role === 'user' && current.length > 0) {
      turns.push(current)
      current = [m]
    } else {
      current.push(m)
    }
  }
  if (current.length) turns.push(current)
  return turns
}

/** 压缩统计；不超预算 / 无法压缩时为 null */
export type { ContextCompression }

export interface CompressResult {
  /** 压缩后的消息（不超预算时与输入同一引用，零拷贝） */
  messages: ModelMessage[]
  compressed: ContextCompression | null
}

/**
 * 合并相邻的同角色**纯文本**消息（摘要可能与紧随的 user 消息撞角色）。
 * 只合并 content 都是字符串的情况 —— assistant 的 content 是数组，不参与合并。
 */
function mergeAdjacentText(messages: ModelMessage[]): ModelMessage[] {
  const out: ModelMessage[] = []
  for (const m of messages) {
    const last = out[out.length - 1]
    if (
      last &&
      last.role === m.role &&
      typeof last.content === 'string' &&
      typeof m.content === 'string'
    ) {
      // ⚠️ 不能直接 spread 后改 content：TypeScript 会把 last 重新展开成 ModelMessage 联合，
      // 而 tool 角色的 content 必须是 ToolContent（不能是 string），于是报错。
      // 这里只合并「content 都是字符串」的变体（user/assistant/system 的纯文本），
      // tool 消息走不到这个分支，所以断言成 ModelMessage 是安全的。
      out[out.length - 1] = {
        ...last,
        content: `${last.content}\n\n${m.content}`
      } as ModelMessage
    } else {
      out.push(m)
    }
  }
  return out
}

/**
 * 在历史最前面注入一条「摘要」消息 —— **手动压缩检查点**用（自动压缩自己拼摘要，见 compressContext）。
 *
 * 摘要以 user 角色插入：它后面紧跟的第一条保留消息通常也是 user（那一轮的开头），
 * 连续同角色会被部分 provider 拒，所以过一遍 mergeAdjacentText。
 */
export function withSummaryPrefix(messages: ModelMessage[], text: string): ModelMessage[] {
  return mergeAdjacentText([
    { role: 'user', content: `（以下是对先前对话的摘要，替代原始历史）\n\n${text}` },
    ...messages
  ])
}

/**
 * 按预算压缩上下文。
 *
 * - 不超预算 → 原样返回（`compressed = null`，调用方零感知）；
 * - 超预算 → 旧轮摘要成一段，保留近期原文；
 * - 摘要请求失败 → 回退成「砍掉旧轮」（截断），保证请求还能发出去，
 *   不会因为一次摘要失败把整轮搞挂。
 *
 * 压缩后会做一次「相邻同角色文本合并」，避免摘要消息与保留下来的第一条消息撞角色
 * （部分 provider 对连续同角色消息会拒）。
 */
export async function compressContext(
  messages: ModelMessage[],
  opts: {
    budget?: number
    keepRecentRatio?: number
    summaryMaxTokens?: number
    model: AiModelConfig
    modelId?: string
    signal?: AbortSignal
  }
): Promise<CompressResult> {
  const budget = resolveContextBudget(opts.budget)
  const keepRatio = opts.keepRecentRatio ?? KEEP_RECENT_RATIO
  const summaryMaxTokens = opts.summaryMaxTokens ?? SUMMARY_MAX_TOKENS

  const beforeTokens = countTokens(messages)
  const noop: CompressResult = { messages, compressed: null }
  // 空历史 / 未超预算：不动
  if (messages.length === 0 || beforeTokens <= budget) return noop

  const turns = splitTurns(messages)
  // 至少保留最后一轮（它含本轮用户输入，绝不能摘要掉）
  if (turns.length <= 1) return noop

  const keepBudget = Math.floor(budget * keepRatio)
  // 从最后一轮往前累加，塞满 keepBudget 就停
  let keptTurns = 0
  let keptTokens = 0
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = countTokens(turns[i])
    if (keptTurns > 0 && keptTokens + t > keepBudget) break
    keptTurns++
    keptTokens += t
    if (i === 0) break // 全保留了，无需压缩
  }
  const summarizedTurns = turns.length - keptTurns
  if (summarizedTurns <= 0) return noop

  const oldTurns = turns.slice(0, summarizedTurns).flat()
  const recent = turns.slice(summarizedTurns).flat()

  // 摘要：失败就回退成截断（见 summarizeHistory 的注释）
  const summary = await summarizeHistory(oldTurns, {
    model: opts.model,
    modelId: opts.modelId,
    maxTokens: summaryMaxTokens,
    signal: opts.signal
  })

  const summaryText = summary
    ? `（以下为先前 ${summarizedTurns} 轮对话的摘要，已压缩替代原文）\n\n${summary}`
    : `（先前 ${summarizedTurns} 轮对话已超出上下文预算，摘要失败，已截断丢弃）`

  // 摘要作为 user 角色消息：后面紧跟保留下来的第一轮（也是 user 开头）时，
  // mergeAdjacentText 会把它们并成一条，避免连续 user 被部分 provider 拒。
  const result = mergeAdjacentText([
    { role: 'user', content: summaryText },
    ...recent
  ])

  const afterTokens = countTokens(result)
  return {
    messages: result,
    compressed: { beforeTokens, afterTokens, summarizedTurns, keptTurns, truncated: !summary }
  }
}