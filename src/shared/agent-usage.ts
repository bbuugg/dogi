/**
 * 会话累计用量的纯计算（渲染端要用，所以放 shared 而不是主进程的 ai/ 下）。
 *
 * 为什么**现算**而不是在会话上另存一个累计字段：
 * - 压缩上下文**不改历史**（见 main/services/ai/context.ts），屏幕上的消息数组永远是原文，
 *   累计值随时能从它重新算出来；
 * - 另存累计值就多出一个可能与消息对不上的副本（漏算一轮、删消息后忘了同步），
 *   而「累计 token」本身没有不可重算的状态。
 */
import type { ConversationUsage } from '@shared/types'

/**
 * 把各轮的 `TurnUsage` 累加成会话累计。
 *
 * 与单轮 `TurnUsage` 的差别：**没有耗时 / TPS** —— 那两个是单轮指标，跨轮累计没有意义
 * （总耗时 ≠ 各轮耗时之和，各轮之间还有等审批的间隙）。
 *
 * `totalTokens` 按各轮**直接相加**，不拿 `input + output` 反推：部分 provider 上报的
 * totalTokens 含缓存命中等额外项，反推会与账单对不上。
 */
export function sumUsage(
  messages: ReadonlyArray<{ usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number; reasoningTokens?: number; cachedInputTokens?: number } | undefined }>
): ConversationUsage {
  let inputTokens = 0
  let outputTokens = 0
  let totalTokens = 0
  let reasoningTokens = 0
  let cachedInputTokens = 0
  for (const m of messages) {
    const u = m.usage
    if (!u) continue
    inputTokens += u.inputTokens ?? 0
    outputTokens += u.outputTokens ?? 0
    totalTokens += u.totalTokens ?? 0
    reasoningTokens += u.reasoningTokens ?? 0
    cachedInputTokens += u.cachedInputTokens ?? 0
  }
  return { inputTokens, outputTokens, totalTokens, reasoningTokens, cachedInputTokens }
}