/**
 * 上下文压缩（compaction）：对话历史过长时，把「旧的那一段」摘要成一条检查点，
 * 只保留最近约 `keepRecentTokens` 的原文。
 *
 * ## 这套机制照搬 pi（`badlogic/pi-mono` 的 `packages/coding-agent/src/core/compaction/compaction.ts`）
 *
 * 只有四件事，别再往里加第五件：
 * 1. **触发**：`contextTokens > contextWindow - reserveTokens`（默认预留 16384）；
 * 2. **切点**：从尾部向前累计 token，够 `keepRecentTokens`（默认 20000）就切；
 *    切点只能落在消息边界（fizz 的历史里 tool 结果内嵌在 assistant 消息里，天然满足）；
 * 3. **摘要**：初始 prompt / 增量 prompt（带 `<previous-summary>` 合并）；
 *    切点落在回合中间时，额外生成 turn-prefix 摘要并合并；
 * 4. **拼装**：摘要作为一条 `user` 消息置顶 + 保留的近期原文；
 *    文件清单（`<read-files>` / `<modified-files>`）由框架从工具调用补，不让模型生成。
 *
 * ## 刻意**没有**的东西（都验证过是负优化，别再捡回来）
 *
 * - 没有「清旧工具结果」这一层（microcompact）：它会改动请求前缀，而上游前缀缓存一旦
 *   断了就要按全价重读整段历史；省下的只是命中价。清一次要十几轮才回本。
 * - 没有「判断厂商缓存 TTL / 命中率」的逻辑：那等于拿上一轮的观测去猜下一轮，判错就会
 *   亲手把前缀改掉。**前缀保持一致就够了**，缓存冷不冷是上游的事。
 * - 没有「按比例提前压」（窗口 × 0.8）：pi 用固定预留量，简单且和上游报的用量对得上。
 *
 * 为什么放这里而不是塞进 route：
 * - 压缩要调模型（生成摘要），得有 model 实例 —— `resolveModel` 在本包；
 * - 输入输出都是本包 `toModelMessages` 的产物，内聚；
 * - 桌面端不走 `runAgent`（它自己调 streamText），所以这里不会误伤桌面端。
 */
import { asSchema, generateText } from 'ai'
import { DEFAULT_CONTEXT_WINDOW, compactionReserveTokens } from '@fizz/contracts/types'
import { resolveModel } from './resolve-model'
import { toModelMessages } from './model-messages'
import type { AgentChatMessage, AiModelConfig } from '@fizz/contracts/types'
import type { ModelMessage } from 'ai'

/** pi 的默认压缩参数（`DEFAULT_COMPACTION_SETTINGS`） */
export interface CompactionSettings {
  enabled: boolean
  /** 给系统提示词与模型回复预留的空间 */
  reserveTokens: number
  /** 压缩后保留的近期上下文 token 数 */
  keepRecentTokens: number
}

export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
  enabled: true,
  reserveTokens: 16384,
  keepRecentTokens: 20000
}

/**
 * pi 的触发判据：`contextTokens > contextWindow - reserveTokens`。
 *
 * fizz 支持的模型窗口跨度很大（32k~1M），16384 的固定预留放到小窗口上会占掉一半，
 * 于是按窗口封顶到 25%（**唯一的机械适配，不改机制**）。
 */
export function resolveCompactionSettings(
  contextWindow: number,
  overrides?: Partial<CompactionSettings>
): CompactionSettings {
  const merged = { ...DEFAULT_COMPACTION_SETTINGS, ...overrides }
  const reserveTokens = Math.min(merged.reserveTokens, compactionReserveTokens(contextWindow))
  // 保留区不能把整个窗口吃掉，否则永远切不出「要压缩的那段」；
  // 还要和触发线留 20% 余量 —— keep == 触发线时，压完立刻又满足触发条件，每轮重压一次
  const keepRecentTokens = Math.min(
    merged.keepRecentTokens,
    Math.max(1024, Math.floor((contextWindow - reserveTokens) * 0.8))
  )
  return { ...merged, reserveTokens, keepRecentTokens }
}

export function shouldCompact(
  contextTokens: number,
  contextWindow: number,
  settings: CompactionSettings
): boolean {
  if (!settings.enabled) return false
  return contextTokens > contextWindow - settings.reserveTokens
}

/**
 * pi 的 `calculateContextTokens`（`core/compaction/compaction.ts`）：把一条助手消息的
 * `usage` 折成「发这条请求时上下文有多大」。
 *
 * ⚠️ 字段映射别照抄 pi 的四项相加：
 * - pi 的 `Usage` 把缓存拆在 `input` **之外**：`input + cacheRead + cacheWrite + output`；
 * - fizz 拿到的 AI SDK usage 里 `inputTokens` **已经包含**缓存命中的部分，
 *   `cachedInputTokens` 只是它的子集 —— 再加一遍就是重复计数。
 *
 * 所以等价式是 `totalTokens || inputTokens + outputTokens`。
 *
 * 这正是输入框圆环显示的数：最后一次请求上游**真实上报**的输入 + 输出，
 * 而不是本地按字符估出来的量。pi 的 `estimateContextTokens` 在此基础上再加
 * 「最后一条带 usage 的消息之后那些消息」的估算；一轮结束时后者为空，所以就是本函数。
 */
export function calculateContextTokens(usage: {
  totalTokens?: number
  inputTokens: number
  outputTokens: number
}): number {
  return usage.totalTokens || usage.inputTokens + usage.outputTokens
}

/** pi 的 `ContextUsageEstimate`，字段一一对应 */
export interface ContextUsageEstimate {
  tokens: number
  usageTokens: number
  trailingTokens: number
  lastUsageIndex: number | null
}

/**
 * 一条助手消息代表的上下文大小（pi 的 `getAssistantUsage` + `calculateContextTokens`）。
 *
 * 优先 `usage.contextTokens`：那是**最后一次请求**的 input+output；`TurnUsage.totalTokens`
 * 是整轮累计（多步循环里每步都加一遍），拿它当上下文会虚高。
 *
 * fizz 没有 `stopReason`，但中止 / 报错的那一轮 `usage` 本来就可能是 0，所以按
 * `> 0` 过滤 —— 与 pi 跳过 aborted / error / 全零 usage 等价。
 */
function assistantContextTokens(msg: AgentChatMessage | undefined): number {
  if (!msg || msg.role !== 'assistant' || !msg.usage) return 0
  const direct = msg.usage.contextTokens
  if (direct && direct > 0) return direct
  return calculateContextTokens(msg.usage)
}

/**
 * pi 的 `estimateContextTokens`：**最后一条带 usage 的助手消息**的 usage + 其后消息的估算。
 *
 * 这是压缩触发与圆环的共同口径。找不到 usage（老数据 / 上游没报）时退回「逐条估算」，
 * 并补上 `baseTokens`（系统提示词 + 工具 schema；pi 的消息数组里含系统提示词，fizz 不含）。
 *
 * ⚠️ fizz 的结构差异：工具结果内嵌在助手消息的 `tool-call.output` 上，不像 pi 那样是
 * 独立的后继消息。所以「usage 之后」的 trailing 里**不含**这一轮刚产出的工具结果
 * （最多几千 token，被 16k 的预留盖住）。要做到分毫不差得先把两者拆开，不值得。
 */
export async function estimateContextTokens(
  messages: AgentChatMessage[],
  opts: { baseTokens?: number } = {}
): Promise<ContextUsageEstimate> {
  let lastUsageIndex: number | null = null
  let usageTokens = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (!m || m.role !== 'assistant' || !m.usage) continue
    const tokens = assistantContextTokens(m)
    if (tokens > 0) {
      lastUsageIndex = i
      usageTokens = tokens
      break
    }
  }

  if (lastUsageIndex === null) {
    let estimated = 0
    for (const m of messages) estimated += estimateMessagesTokens(await toModelMessages([m]))
    return {
      tokens: estimated + (opts.baseTokens ?? 0),
      usageTokens: 0,
      trailingTokens: estimated,
      lastUsageIndex: null
    }
  }

  let trailingTokens = 0
  for (let i = lastUsageIndex + 1; i < messages.length; i++) {
    const m = messages[i]
    if (m) trailingTokens += estimateMessagesTokens(await toModelMessages([m]))
  }
  return {
    tokens: usageTokens + trailingTokens,
    usageTokens,
    trailingTokens,
    lastUsageIndex
  }
}

/* ---------------- 摘要提示词（pi 原文，逐字照搬） ---------------- */

const SUMMARIZATION_SYSTEM_PROMPT = [
  'You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.',
  '',
  'Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.'
].join('\n')

const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`

const UPDATE_SUMMARIZATION_INSTRUCTIONS = `Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact file paths, function names, and error messages.`

const UPDATE_SUMMARIZATION_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

${UPDATE_SUMMARIZATION_INSTRUCTIONS}`

const TURN_PREFIX_SUMMARIZATION_PROMPT = `The messages above are earlier context from an ongoing conversation. Later messages are stored separately and do not need to be reconstructed.

Create a concise checkpoint of the user's request and the progress shown above. This checkpoint will be placed before the later messages so the conversation can continue with the necessary context.

## Original Request
[What did the user ask for?]

## Progress So Far
- [Key decisions and work completed in these messages]

## Context Needed to Continue
- [Information from these messages needed to understand the later work]

Only summarize information explicitly present above. Do not infer or recreate later messages.`

/**
 * token 估算：**pi 的 `estimateTokens` 公式** —— `Math.ceil(chars / 4)`。
 *
 * pi 按消息角色分别数 char 数（正文 / 思考 / toolCall 的 name + JSON 参数 / 工具结果正文），
 * 这里在展平后的文本上用同一个除数，等价。
 *
 * ⚠️ 已知取舍（照搬 pi 带来的）：一个汉字在 JS 字符串里算 1 个 char → 0.25 token，
 * 而真实约 1~1.5 token。**纯中文会话会被低估 4~6 倍**，压缩触发因此偏晚。
 * 这是 pi 的行为，fizz 不再额外加权；真出现超窗就走 `runAgent` 的 overflow 恢复。
 */
export function estimateTokens(text: string): number {
  return text ? Math.ceil(text.length / 4) : 0
}

/** pi 的 `ESTIMATED_IMAGE_CHARS`：一张图按 4800 字符（= 1200 token）估 */
const ESTIMATED_IMAGE_CHARS = 4800

/** 工具结果的文本值（AI SDK 的 `output` 有 text / json / error-text 几种形状） */
function toolOutputText(output: unknown): string {
  if (typeof output === 'string') return output
  if (output && typeof output === 'object') {
    const o = output as { type?: string; value?: unknown }
    if ((o.type === 'text' || o.type === 'error-text') && typeof o.value === 'string') return o.value
    if (o.type === 'json') return JSON.stringify(o.value ?? null)
  }
  return output === undefined ? '' : JSON.stringify(output)
}

/**
 * 一条消息的「字符数」，口径对齐 pi 的 `estimateTokens`：
 * 正文 + 思考 + toolCall 的 `name` 与 `JSON.stringify(arguments)` + 工具结果正文；
 * 图片按 `ESTIMATED_IMAGE_CHARS` 折成字符。
 */
function estimateMessageChars(m: ModelMessage): number {
  const { content } = m
  if (typeof content === 'string') return content.length
  if (!Array.isArray(content)) return 0
  let chars = 0
  for (const part of content as Array<{ type: string } & Record<string, unknown>>) {
    switch (part.type) {
      case 'text':
      // pi 把 thinking 也算进上下文（它确实占 token）
      case 'reasoning':
        chars += String(part.text ?? '').length
        break
      case 'image':
        chars += ESTIMATED_IMAGE_CHARS
        break
      case 'tool-call':
        chars += String(part.toolName ?? '').length + JSON.stringify(part.input ?? {}).length
        break
      case 'tool-result':
        chars += toolOutputText(part.output).length
        break
      default:
        break
    }
  }
  return chars
}

/**
 * 一组消息的 token 数（导出：runAgent 要用它算「本轮实际请求的上下文」）。
 *
 * 逐条 `ceil(chars / 4)` 再求和 —— 与 pi 的 `sumTokens` 一致（不是先把总字符数加完再除）。
 */
export function estimateMessagesTokens(messages: ModelMessage[]): number {
  let sum = 0
  for (const m of messages) sum += Math.ceil(estimateMessageChars(m) / 4)
  return sum
}

/**
 * 把一条 **Mastra format-2** 消息（`MastraDBMessage`）展平成文本。
 *
 * ⚠️ 为什么不能直接把它当 `ModelMessage` 丢给 `messageToText`：两者的 content
 * 形状根本不同 —— Mastra 的是 `{ format: 2, parts: [...] }`，而 `messageToText`
 * 认的是 AI SDK 的 `string | ContentPart[]`。传错类型**不会报错**：`messageToText`
 * 走到 `Array.isArray(content)` 为 false、`typeof content === 'string'` 也为 false 的
 * 分支，返回空串 —— 整份上下文被估成 0，圆环永远显示「没用量」（与 AGENTS.md 记的
 * `reasoning-delta`、file part 形状那类「写错静默丢弃」同一个坑）。
 *
 * part 形状同样是 AI SDK v4 UIMessage 那一套（与 `onIterationComplete` 里注入插话时
 * 手写的 file part 一致）：文本在 `text`、工具调用是 `tool-invocation`。只抠对
 * **token 估算有意义**的那几类，认不出来的跳过（宁可低估，不要抛错拖垮整轮）。
 */
function mastraMessageChars(m: { content?: unknown }): number {
  const content = m?.content
  if (!content || typeof content !== 'object') return 0
  const parts = (content as { parts?: unknown }).parts
  if (!Array.isArray(parts)) return 0
  let chars = 0
  for (const part of parts as Array<Record<string, unknown>>) {
    const type = part?.type
    if (type === 'text' || type === 'reasoning') {
      // pi 把思考也算进上下文
      if (typeof part.text === 'string') chars += part.text.length
    } else if (type === 'file' || type === 'image') {
      // 图片 / 附件：pi 的 ESTIMATED_IMAGE_CHARS
      chars += ESTIMATED_IMAGE_CHARS
    } else if (type === 'tool-invocation') {
      const inv = part.toolInvocation as Record<string, unknown> | undefined
      const name = String(inv?.toolName ?? part.toolName ?? '?')
      if (inv?.args !== undefined) chars += name.length + JSON.stringify(inv.args).length
      if (inv?.result !== undefined) {
        const r = inv.result
        chars += (typeof r === 'string' ? r : JSON.stringify(r ?? null)).length
      }
    }
    // step-start / source …：不进估算
  }
  return chars
}

/**
 * 一组 **Mastra format-2** 消息的 token 估算。
 *
 * 给 `runAgent` 的 `onIterationComplete` 用：那里的 `ctx.messages` 是 Mastra 的
 * `MastraDBMessage[]`（format 2），不能走 `estimateMessagesTokens`（见上）。
 * 这是 pi 的**兜底估算**（`estimateContextTokens` 找不到带 usage 的助手消息时的分支）。
 * finish 时圆环会换成上游真实 usage（`calculateContextTokens`），两者会有几个百分点的
 * 跳变 —— pi 也是这个行为：流式中估、结束后按真实用量。
 */
export function estimateMastraMessagesTokens(messages: Array<{ content?: unknown }>): number {
  let sum = 0
  for (const m of messages) sum += Math.ceil(mastraMessageChars(m) / 4)
  return sum
}

/**
 * 把一条工具定义折成「模型实际看到的那部分文本」：描述 + 入参 JSON Schema。
 *
 * 拿不到 schema（不是 AI SDK 工具 / schema 是懒加载的 thenable 且 await 失败 / 转换抛错）
 * 就只算描述：宁可低估，也不要因为一个估不准的工具把整轮对话搞挂。
 */
async function toolToText(tool: unknown): Promise<string> {
  if (!tool || typeof tool !== 'object') return ''
  const t = tool as { description?: unknown; inputSchema?: unknown }
  const parts: string[] = [typeof t.description === 'string' ? t.description : '']
  if (t.inputSchema) {
    try {
      const schema = asSchema(t.inputSchema as never) as { jsonSchema?: unknown }
      const raw = schema?.jsonSchema
      const resolved =
        raw && typeof (raw as PromiseLike<unknown>).then === 'function'
          ? await (raw as PromiseLike<unknown>)
          : raw
      if (resolved) parts.push(JSON.stringify(resolved))
    } catch {
      // 认不出来的 schema：只留描述（见函数注释）
    }
  }
  return parts.filter(Boolean).join('\n')
}

/**
 * 系统提示词 + 全部工具定义的 token 估算 —— 请求里**最容易被忽略的一块**。
 *
 * 它们不在 `messages` 里，但每次请求都要发出去，而且占比不小（项目约束文档 AGENTS.md
 * 是全文注入的 + 十来个工具的 schema）。压缩判断与圆环统计都把它算上，口径才和上游
 * 真正收到的东西对得上；不算的话「估算 190k、上游说超了」这种错位会一直存在。
 */
export async function estimateBaseTokens(
  instructions: string,
  tools: Record<string, unknown>
): Promise<number> {
  let total = estimateTokens(instructions)
  for (const tool of Object.values(tools)) total += estimateTokens(await toolToText(tool))
  return total
}

/** pi 的 `TOOL_RESULT_MAX_CHARS`：摘要输入里工具结果的上限 */
const TOOL_RESULT_MAX_CHARS = 2_000

function truncateForSummary(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}\n\n[... ${text.length - maxChars} more characters truncated]`
}

/**
 * 摘要用的可见正文（pi 的 `contentText`）：**只取 text 块**。
 *
 * 思考 / 图片不进摘要 —— 与 pi 的 `serializeConversation` 一致（它只读 text 与 toolCall）。
 * 工具结果消息则取 `output` 的文本值。
 */
function contentText(m: ModelMessage): string {
  const { content } = m
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  const out: string[] = []
  for (const part of content as Array<{ type: string } & Record<string, unknown>>) {
    if (part.type === 'text') out.push(String(part.text ?? ''))
    else if (part.type === 'tool-result') out.push(toolOutputText(part.output))
  }
  return out.join('\n').trim()
}

/** `[Assistant tool calls]` 那段：`name(k=v, k=v)`（pi 的拼法，v 走 JSON.stringify） */
function toolCallLines(m: ModelMessage): string[] {
  if (!Array.isArray(m.content)) return []
  const calls: string[] = []
  for (const part of m.content as Array<{ type: string } & Record<string, unknown>>) {
    if (part.type !== 'tool-call') continue
    const args = (part.input ?? {}) as Record<string, unknown>
    const argStr = Object.entries(args)
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
      .join(', ')
    calls.push(`${String(part.toolName ?? '?')}(${argStr})`)
  }
  return calls
}

/**
 * pi 的 `serializeConversation`（逐字对齐）：
 * `[User]:` / `[Assistant]:` / `[Assistant tool calls]:` / `[Tool result]:`，`\n\n` 连接。
 *
 * 纯文本序列化是刻意为之：摘要模型拿到的是「文本」，不是可继续的对话结构，
 * 否则它会接着聊下去而不是输出检查点。工具结果截断到 2000 字符（pi 的做法）。
 */
function serializeConversation(messages: ModelMessage[]): string {
  const parts: string[] = []
  for (const m of messages) {
    if (m.role === 'user') {
      const text = contentText(m)
      if (text) parts.push(`[User]: ${text}`)
    } else if (m.role === 'assistant') {
      const text = contentText(m)
      if (text) parts.push(`[Assistant]: ${text}`)
      const calls = toolCallLines(m)
      if (calls.length > 0) parts.push(`[Assistant tool calls]: ${calls.join('; ')}`)
    } else if (m.role === 'tool') {
      const text = contentText(m)
      if (text) parts.push(`[Tool result]: ${truncateForSummary(text, TOOL_RESULT_MAX_CHARS)}`)
    }
  }
  return parts.join('\n\n')
}

/**
 * 服务端生效的**兜底窗口**：环境变量 `FIZZ_CONTEXT_BUDGET` > `DEFAULT_CONTEXT_WINDOW`(200k)。
 *
 * 它只在「这个模型没有单独配上下文窗口」时生效 —— 模型自己的配置永远优先
 * （见 contracts 的 `resolveContextWindow`）。保留环境变量的意义是 dev 逃生门：
 * 接一个从没配过的本地模型时，不改代码就能把兜底值调小 / 调大。
 *
 * 导出给 `GET /api/chat/context`：前端算「兜底分母」要用同一个数，两端口径才一致。
 */
export function defaultContextWindowFromEnv(): number {
  const env = process.env.FIZZ_CONTEXT_BUDGET
  if (env) {
    const n = Number(env)
    if (Number.isFinite(n) && n > 0) return Math.floor(n)
  }
  return DEFAULT_CONTEXT_WINDOW
}

/* ---------------- 压缩（照 pi：阈值 → 切点 → 摘要 → 拼装） ---------------- */

/**
 * 检查点缓存：按会话记住「保留起点 + 摘要正文」。
 *
 * pi 把检查点写进 `session.jsonl`，下一轮重新加载；fizz 的历史是调用方每轮传进来的
 * 未压缩全量，所以这里做等价的事：记住检查点，下一轮原样拼回同一个位置。
 * 没有这份状态，每轮都会重新摘要一次 —— 摘要文本每轮都不同，前缀缓存每轮全废。
 */
interface AutoSummaryEntry {
  /** 保留起点的消息 id（找不到 = 历史被改过，重新摘要） */
  keepFromMessageId: string
  /** 完整的摘要消息正文（含文件清单）—— 原样复用，前缀才稳定 */
  text: string
  at: number
}

const AUTO_SUMMARY_CACHE_LIMIT = 128
const autoSummaryCache = new Map<string, AutoSummaryEntry>()

/** 清自动摘要缓存（会话被删 / 测试用）。不传 = 全清 */
export function clearAutoSummaryCache(conversationId?: string): void {
  if (conversationId) autoSummaryCache.delete(conversationId)
  else autoSummaryCache.clear()
}

function rememberAutoSummary(conversationId: string, entry: AutoSummaryEntry): void {
  // 先删再插：Map 的插入顺序即 LRU 顺序
  autoSummaryCache.delete(conversationId)
  autoSummaryCache.set(conversationId, entry)
  while (autoSummaryCache.size > AUTO_SUMMARY_CACHE_LIMIT) {
    const oldest = autoSummaryCache.keys().next().value
    if (oldest === undefined) break
    autoSummaryCache.delete(oldest)
  }
}

/**
 * 文件操作追踪（pi 的 `readFiles` / `modifiedFiles`）。
 *
 * 由框架从工具调用里抽，不让摘要模型自己列 —— 模型会漏、会编。
 */
interface FileOperations {
  read: Set<string>
  modified: Set<string>
}

function createFileOps(): FileOperations {
  return { read: new Set(), modified: new Set() }
}

/** fizz 的工具名：`read_file` / `write_file` / `edit_file`（入参都是 `path`） */
function extractFileOps(history: AgentChatMessage[], ops: FileOperations): void {
  for (const m of history) {
    for (const part of m.parts) {
      if (part.type !== 'tool-call') continue
      const call = part as unknown as { toolName?: string; input?: { path?: unknown } }
      const path = typeof call.input?.path === 'string' ? call.input.path : undefined
      if (!path) continue
      if (call.toolName === 'read_file') ops.read.add(path)
      else if (call.toolName === 'write_file' || call.toolName === 'edit_file') ops.modified.add(path)
    }
  }
}

/**
 * pi 的 `formatFileOperations`：`modified = written ∪ edited`、`read = read \ modified`，
 * 各排一次序保证逐字节稳定；整块以两个换行开头，段间也是两个换行。
 */
function formatFileOperations(ops: FileOperations): string {
  const modified = [...ops.modified].sort()
  const read = [...ops.read].filter((f) => !ops.modified.has(f)).sort()
  const sections: string[] = []
  if (read.length > 0) sections.push(`<read-files>\n${read.join('\n')}\n</read-files>`)
  if (modified.length > 0) {
    sections.push(`<modified-files>\n${modified.join('\n')}\n</modified-files>`)
  }
  if (sections.length === 0) return ''
  return `\n\n${sections.join('\n\n')}`
}

/** pi 的 `CutPointResult` */
interface CutPointResult {
  /** 从这个下标开始保留 */
  firstKeptIndex: number
  /** 切点所在回合的起点（-1 = 没切开回合） */
  turnStartIndex: number
  isSplitTurn: boolean
}

/**
 * pi 的 `findCutPoint`：从尾部向前累计，够 `keepRecentTokens` 就切。
 *
 * fizz 的历史里 tool 结果内嵌在 `tool-call` 的 `output` 上（没有独立的 tool-result
 * 消息），所以**每条消息都是合法切点** —— 「绝不切在 tool result 上」这条天然成立。
 */
function findCutPoint(
  history: AgentChatMessage[],
  startIndex: number,
  endIndex: number,
  keepRecentTokens: number,
  tokens: number[]
): CutPointResult {
  let accumulated = 0
  let cutIndex = startIndex
  for (let i = endIndex - 1; i >= startIndex; i--) {
    accumulated += tokens[i] ?? 0
    if (accumulated >= keepRecentTokens) {
      cutIndex = i
      break
    }
  }

  const startsTurn = history[cutIndex]?.role === 'user'
  let turnStartIndex = -1
  if (!startsTurn) {
    for (let i = cutIndex; i >= startIndex; i--) {
      if (history[i]?.role === 'user') {
        turnStartIndex = i
        break
      }
    }
  }
  return {
    firstKeptIndex: cutIndex,
    turnStartIndex,
    isSplitTurn: !startsTurn && turnStartIndex !== -1
  }
}

/** 摘要失败：pi 的 `getSummarizationFailure` —— 截断的半成品绝不能写成检查点 */
function assertSummary(text: string, finishReason: string | undefined, label: string): string {
  const trimmed = text.trim()
  if (finishReason === 'length') {
    throw new Error(`${label} failed: generation hit the token cap and the summary is incomplete`)
  }
  if (!trimmed) throw new Error(`${label} failed: empty summary`)
  return trimmed
}

/** 一次摘要调用（初始 prompt / 增量 prompt 走同一条路，pi 的 `generateSummaryWithUsage`） */
async function generateSummary(
  messages: ModelMessage[],
  model: AiModelConfig,
  previousSummary: string | undefined,
  signal: AbortSignal | undefined,
  customInstructions?: string
): Promise<string> {
  let basePrompt = previousSummary ? UPDATE_SUMMARIZATION_PROMPT : SUMMARIZATION_PROMPT
  if (customInstructions) basePrompt = `${basePrompt}\n\nAdditional focus: ${customInstructions}`

  let promptText = `<conversation>\n${serializeConversation(messages)}\n</conversation>\n\n`
  if (previousSummary) promptText += `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n`
  promptText += basePrompt

  const { text, finishReason } = await generateText({
    model: resolveModel(model),
    system: SUMMARIZATION_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: promptText }],
    ...(signal ? { abortSignal: signal } : {})
  })
  return assertSummary(text, finishReason, 'Summarization')
}

/** 切点落在回合中间时，为被切掉的那半截单独生成一份小摘要（pi 的 turn-prefix） */
async function generateTurnPrefixSummary(
  messages: ModelMessage[],
  model: AiModelConfig,
  signal: AbortSignal | undefined
): Promise<string> {
  const promptText = `# Conversation\n${serializeConversation(messages)}\n\n# Instructions\n${TURN_PREFIX_SUMMARIZATION_PROMPT}`
  const { text, finishReason } = await generateText({
    model: resolveModel(model),
    system: SUMMARIZATION_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: promptText }],
    ...(signal ? { abortSignal: signal } : {})
  })
  return assertSummary(text, finishReason, 'Turn prefix summarization')
}

export interface CompactHistoryResult {
  /** 发给模型的历史（未触发 = 与输入同一引用） */
  history: AgentChatMessage[]
  /**
   * 压缩统计；**只有真的重算过摘要**才非 null。
   *
   * 复用检查点时故意返回 null：那是每轮都发生的常规拼接，不该每轮都往前端推一条
   * 「上下文已压缩」—— 用户会以为系统一直在压。
   */
  compressed: {
    beforeTokens: number
    afterTokens: number
    summarizedTurns: number
    keptTurns: number
  } | null
  /** 复用了上次的检查点（本轮没有调摘要模型） */
  reused: boolean
  /** 这次生成的摘要正文（含文件清单）；复用 / 未压缩时为 null */
  summary: string | null
  /**
   * 被摘要部分的**末条消息**（手动压缩落检查点用）。
   *
   * 切片的语义是「这条**之后**的消息保持原文」，所以必须是摘要覆盖到的最后一条，
   * 记在保留区末条会让最近一轮凭空消失。
   */
  summarizedUpTo: { id: string; createdAt: number } | null
}

/**
 * 上下文压缩主入口：**pi 的 `prepareCompaction` + `compact` 合并版**。
 *
 * 决策顺序（与 pi 一致）：
 * 1. 没到 `window - reserveTokens` → 原样返回；
 * 2. 有检查点、起点还在、起点之后的原文仍在 `keepRecentTokens` 内 → 只拼接，不调模型；
 * 3. 否则：找切点 → 摘要（有旧摘要就增量合并）→ 生成新检查点。
 *
 * `force`（手动压缩 / 上游 context overflow 恢复）：跳过阈值判断，切点逻辑不变。
 */
export async function compactHistory(
  history: AgentChatMessage[],
  opts: {
    /** 会话 id：检查点缓存的键。缺失 = 不固化（每轮重算，行为退回加这个能力之前） */
    conversationId?: string
    /** 落盘的检查点（进程重启后内存缓存是空的，用它接上）；`at` 用于判断 usage 是否陈旧 */
    seed?: { keepFromMessageId: string; text: string; at?: number }
    /** 摘要**真的重算**时回调（供 server 落盘） */
    onAutoSummary?: (entry: { keepFromMessageId: string; text: string }) => void
    contextWindow: number
    baseTokens?: number
    /** 覆盖 pi 的默认参数（reserveTokens / keepRecentTokens） */
    settings?: Partial<CompactionSettings>
    /** 跳过阈值判断（手动压缩 / overflow 恢复） */
    force?: boolean
    /** 手动压缩时的额外关注点（pi 的 `customInstructions`） */
    customInstructions?: string
    model: AiModelConfig
    signal?: AbortSignal
  }
): Promise<CompactHistoryResult> {
  const unchanged: CompactHistoryResult = {
    history,
    compressed: null,
    reused: false,
    summary: null,
    summarizedUpTo: null
  }
  if (history.length === 0) return unchanged

  const settings = resolveCompactionSettings(opts.contextWindow, opts.settings)
  const baseTokens = Math.max(0, opts.baseTokens ?? 0)

  /** 逐条估算：历史是调用方传进来的全量，逐条转一次比整份转再猜要准 */
  const tokens: number[] = []
  for (const m of history) tokens.push(estimateMessagesTokens(await toModelMessages([m])))

  // ① 先找检查点，拼出「当前真正会发出去的上下文」—— 阈值判的是**它**，不是原始历史。
  //    反过来的话，压缩完之后原始历史仍然巨大，下一轮又判超阈值 → 每轮重压一次。
  const cached =
    (opts.conversationId ? autoSummaryCache.get(opts.conversationId) : undefined) ?? opts.seed
  const cachedIndex = cached ? history.findIndex((m) => m.id === cached.keepFromMessageId) : -1
  const hasCheckpoint = cachedIndex > 0 && cached !== undefined
  const checkpointIndex = hasCheckpoint ? cachedIndex : 0
  const assembled = hasCheckpoint ? withSummary(history, cachedIndex, cached!.text) : history

  /**
   * pi 的 `_checkCompaction`：
   * 1. 触发量 = **最后一条助手消息的 usage**（真实值），拿不到才退回逐条估算；
   * 2. 「压缩点之前产生的助手消息」不参与判定 —— 否则压完的下一轮会拿着压缩前的
   *    大 usage 立刻再压一次（这正是 pi 用 compaction entry 的时间戳挡掉的东西）。
   */
  const lastAssistant = [...history].reverse().find((m) => m.role === 'assistant')
  const checkpointAt = cached?.at ?? 0
  const staleUsage = hasCheckpoint && (!lastAssistant || lastAssistant.createdAt <= checkpointAt)
  const directTokens = staleUsage ? 0 : assistantContextTokens(lastAssistant)
  const beforeTokens =
    directTokens > 0
      ? directTokens
      : (await estimateContextTokens(assembled, { baseTokens })).tokens
  const overBudget = !staleUsage && shouldCompact(beforeTokens, opts.contextWindow, settings)

  if (!opts.force && !overBudget) {
    if (!hasCheckpoint) {
      // 低于阈值 = 不需要压（例如用户删过消息）→ 顺手清缓存，别留一段没用的摘要
      if (opts.conversationId) clearAutoSummaryCache(opts.conversationId)
      return unchanged
    }
    // 有检查点且总量没超 → **原样复用**（不调模型、前缀逐字节不变）
    if (opts.conversationId && !autoSummaryCache.has(opts.conversationId)) {
      rememberAutoSummary(opts.conversationId, {
        keepFromMessageId: cached!.keepFromMessageId,
        text: cached!.text,
        at: Date.now()
      })
    }
    return { history: assembled, compressed: null, reused: true, summary: null, summarizedUpTo: null }
  }

  // ② 切点：只在上次检查点之后找（之前的内容已经在摘要里了）
  const cut = findCutPoint(
    history,
    checkpointIndex,
    history.length,
    settings.keepRecentTokens,
    tokens
  )
  const historyEnd = cut.isSplitTurn ? cut.turnStartIndex : cut.firstKeptIndex
  // 没有可摘要的（切点落在起点上）：不压，有检查点就继续用
  if (historyEnd <= checkpointIndex) {
    return hasCheckpoint
      ? { history: assembled, compressed: null, reused: true, summary: null, summarizedUpTo: null }
      : unchanged
  }

  const summarizeSlice = history.slice(checkpointIndex, historyEnd)
  const turnPrefixSlice = cut.isSplitTurn
    ? history.slice(cut.turnStartIndex, cut.firstKeptIndex)
    : []

  const fileOps = createFileOps()
  extractFileOps(summarizeSlice, fileOps)
  extractFileOps(turnPrefixSlice, fileOps)
  // 上一次检查点的文件清单继续向前继承（pi 的 `extractFileOperations`）
  if (cachedIndex > 0 && cached) extractFileOps(history.slice(0, cachedIndex), fileOps)

  // ③ 摘要：有旧摘要就增量合并，否则生成初始检查点
  let summary: string
  if (cut.isSplitTurn && turnPrefixSlice.length > 0) {
    const historyText =
      summarizeSlice.length > 0
        ? await generateSummary(
            await toModelMessages(summarizeSlice),
            opts.model,
            cached?.text,
            opts.signal,
            opts.customInstructions
          )
        : (cached?.text ?? 'No prior history.')
    const prefixText = await generateTurnPrefixSummary(
      await toModelMessages(turnPrefixSlice),
      opts.model,
      opts.signal
    )
    summary = `${historyText}\n\n---\n\n**Turn Context (split turn):**\n\n${prefixText}`
  } else {
    summary = await generateSummary(
      await toModelMessages(summarizeSlice),
      opts.model,
      cached?.text,
      opts.signal,
      opts.customInstructions
    )
  }

  const text = `${summary}${formatFileOperations(fileOps)}`
  const firstKept = history[cut.firstKeptIndex]

  const result = withSummary(history, cut.firstKeptIndex, text)
  const afterTokens = baseTokens + estimateMessagesTokens(await toModelMessages(result))

  // 落点：内存 + 调用方（server 落盘）。起点只会往后移，天然单调
  if (firstKept) {
    if (opts.conversationId) {
      rememberAutoSummary(opts.conversationId, {
        keepFromMessageId: firstKept.id,
        text,
        at: Date.now()
      })
    }
    opts.onAutoSummary?.({ keepFromMessageId: firstKept.id, text })
  }

  const lastSummarized = history[historyEnd - 1]
  return {
    history: result,
    compressed: {
      beforeTokens,
      afterTokens,
      summarizedTurns: historyEnd - checkpointIndex,
      keptTurns: history.length - cut.firstKeptIndex
    },
    reused: false,
    summary: text,
    summarizedUpTo: lastSummarized
      ? { id: lastSummarized.id, createdAt: lastSummarized.createdAt }
      : null
  }
}

/**
 * 把摘要并到「保留起点」那一条上（pi 是单独插一条 user；这里并进去）。
 *
 * 唯一的理由：fizz 支持的一批 provider 会拒连续两条 user 消息。顺序与内容与 pi 一致，
 * 只是省掉了那条独立的摘要消息 —— 这不属于压缩机制。
 */
function withSummary(
  history: AgentChatMessage[],
  firstKeptIndex: number,
  text: string
): AgentChatMessage[] {
  const rest = history.slice(firstKeptIndex)
  const first = rest[0]
  if (!first) {
    return [{ id: `compaction-${Date.now()}`, role: 'user', parts: [{ type: 'text', text }], createdAt: Date.now() }]
  }
  if (first.role === 'user') {
    return [{ ...first, parts: [{ type: 'text', text }, ...first.parts] }, ...rest.slice(1)]
  }
  // 兜底：起点不是 user（历史从中途开始）—— 单独插一条
  return [
    { id: `compaction-${first.id}`, role: 'user', parts: [{ type: 'text', text }], createdAt: first.createdAt },
    ...rest
  ]
}

/**
 * 上游报「上下文超窗」了吗（pi 的 overflow 恢复判据）。
 *
 * 各家文案不一，这里只认最常见的几种；宁可漏判（走正常报错），不要误判
 * （误判会白白多压一次上下文）。
 */
export function isContextOverflowError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return /context[ _-]?length|context[ _-]?window|maximum context|prompt is too long|too many tokens|exceeds the maximum/i.test(
    message
  )
}
