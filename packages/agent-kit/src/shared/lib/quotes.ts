/**
 * 「引用消息」的前端表示：在消息里划选一段文字 → 引用 → 输入框上方挂一片引用 →
 * 随提问一起发出去。
 *
 * ⚠️ 引用**不是**独立字段：发送时直接拼成 markdown 引用块塞进正文。这个选择的收益：
 * - user 消息的 text 原样落盘、由 Streamdown 渲染 markdown → 历史重载天然带上引用；
 * - 队列消息、插话、编辑重发走的都是同一个 text → 不用给每条通道各加一份引用；
 * - 服务端与契约零改动。
 * 代价：气泡里就是一个普通 markdown 引用块（没有「引用卡」结构、也点不回原消息）。
 * 要那个得给 ChatRequest 加字段、服务端存独立 part、气泡单独渲染 —— 那是另一档改动。
 */

/** 输入框上方挂着的一片引用 */
export interface MessageQuote {
  id: string
  /** 被划走的原文。发送时逐行加 `> `；**不做截断**（摘录只在展示层截，见 QuotePreviewRow） */
  text: string
  /** 划选起点所在消息的角色：只用来在引用片上标「你的消息 / 助手消息」 */
  role: 'user' | 'assistant'
}

let quoteSeq = 0
/** 引用片 id（React key 用）；与 `nextAttachmentId` 同款的自增计数 */
export function nextQuoteId(): string {
  quoteSeq += 1
  return `quote-${Date.now()}-${quoteSeq}`
}

/**
 * 正文 + 引用片 → 真正发出去的文本。
 *
 * 每个引用片一个 markdown 引用块，块与块、块与正文之间空一行。
 * 正文为空（**只引用不提问**）时只有引用块 —— 这是合法发送，门控那边已经放行。
 */
export function buildQuotedText(quotes: MessageQuote[], body: string): string {
  if (quotes.length === 0) return body
  const head = quotes.map((q) => quoteBlock(q.text)).join('\n\n')
  return body ? `${head}\n\n${body}` : head
}

/**
 * 一段原文 → markdown 引用块。
 *
 * 空行给一个光秃秃的 `>`：不然 markdown 会把上下两段引用并成一段，模型看到的
 * 段落结构就与用户划的不一样了。
 */
function quoteBlock(text: string): string {
  return text
    .split('\n')
    .map((line) => (line.trim() ? `> ${line}` : '>'))
    .join('\n')
}
