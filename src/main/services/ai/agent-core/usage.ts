/**
 * token 用量的归一化（工作区 Agent 与终端 AI 助手**共用一份**）。
 *
 * 移植自 fishwork 的 `packages/agent/src/agent.ts`（`RawUsage` / `normalizeUsage` /
 * `readChunkUsage`），补上 dogi 之前缺的两件事：
 *
 * 1. **多级兜底取「思考 / 缓存命中」**。AI SDK v6/v7 把这两项从顶层字段挪进了
 *    `outputTokenDetails.reasoningTokens` / `inputTokenDetails.cacheReadTokens`，顶层只留
 *    inputTokens / outputTokens / totalTokens。只读顶层的话这两项**恒为 0 / 恒缺**
 *    （界面表现就是「思考」「缓存命中」永远是 0，见 6.6 的思考内容条目）。
 * 2. **优先从 `finish` chunk 取 usage**。Mastra 的 `stream.usage` 是它自己归一化过的
 *    形状，明细字段不一定保留；`finish` chunk 里那份是 AI SDK 原样透出的，字段最全。
 *
 * 归一化只保证「拿得到就拿、拿不到就不带这个字段」—— 调用方据此决定显不显示，
 * 而不是拿 0 冒充「上游真的报了 0」。
 */

/** 模型上报的原始 token 用量（各家字段名不同，统一到这里） */
export type RawUsage = {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  reasoningTokens?: number
  cachedInputTokens?: number
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : undefined
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

/**
 * 把各家形状的 usage 归一化。
 *
 * 字段名按版本 / 供应商做了防御式兼容：
 * - 输入输出：v4 的 `promptTokens` / `completionTokens`、v5+ 的 `inputTokens` / `outputTokens`；
 * - 思考：v5 顶层的 `reasoningTokens`、v6+ 的 `outputTokenDetails.reasoningTokens`，
 *   OpenAI 原始形状的 `completionTokensDetails.reasoningTokens`；
 * - 缓存命中：v5 顶层的 `cachedInputTokens`、v6+ 的 `inputTokenDetails.cacheReadTokens`，
 *   OpenAI 原始形状的 `promptTokensDetails.cachedTokens`。
 *
 * 全是 `0` 也照带 —— 「上游确实报了 0」和「上游没报」是两回事，别在这里合并。
 */
export function normalizeUsage(usage: unknown): RawUsage | null {
  const u = asRecord(usage)
  if (!u) return null
  const inputTokens = num(u.inputTokens ?? u.promptTokens) ?? 0
  const outputTokens = num(u.outputTokens ?? u.completionTokens) ?? 0
  const totalTokens = num(u.totalTokens) ?? inputTokens + outputTokens
  const reasoningTokens =
    num(u.reasoningTokens) ??
    num(asRecord(u.outputTokenDetails)?.reasoningTokens) ??
    num(asRecord(u.completionTokensDetails)?.reasoningTokens)
  const cachedInputTokens =
    num(u.cachedInputTokens) ??
    num(asRecord(u.inputTokenDetails)?.cacheReadTokens) ??
    num(asRecord(u.promptTokensDetails)?.cachedTokens)
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {})
  }
}

/**
 * 从 Mastra / AI SDK 的 `finish` chunk 里抠出 usage。
 *
 * 不是 finish chunk、或没带 usage —— 返回 null。
 * Mastra v1 的 fullStream 把数据放在 `payload` 里（`{ type:'finish', payload:{ usage } }`），
 * 顶层兜底是为了兼容它内部对旧 AI SDK 版本的归一化（同 `adaptMastraPart` 的取值口径）。
 *
 * 多步（工具调用）时每个 step 都会有 usage，**只认最后的 `finish`** —— 它才是整轮的累计值，
 * 拿中间的 step 值会少算。调用方按「后写覆盖先写」保留最后一条即可。
 */
export function readChunkUsage(raw: unknown): RawUsage | null {
  const part = asRecord(raw)
  if (!part) return null
  if (part.type !== 'finish') return null
  const body = asRecord(part.payload) ?? part
  return normalizeUsage(body.totalUsage ?? body.usage)
}
