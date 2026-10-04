/**
 * 手动「压缩上下文」与「清除摘要」—— 移植自 fishwork（app/api/chat/compress/route.ts +
 * packages/agent/src/context.ts），核心不变式照搬：
 *
 * > **原始消息一条都不动。** 压缩只发生在「组装发往模型的历史」那一步：
 * > 检查点（`ConversationContextSummary`）之前的消息在请求里被摘要替代，之后的保持原文。
 *
 * 因此「清除摘要」就是**完整、无损**地回到全文历史 —— 这是这套设计最大的优点，
 * 也是它比「真的去删消息」好的地方。屏幕上的历史永远是原文，可翻 / 可复制 / 可编辑重发。
 *
 * 与自动压缩（`compressContext`）的分工：
 * - 自动压缩：估算超过「上下文窗口 × `COMPRESS_TRIGGER_RATIO`」才触发，产物**只在这一次请求里
 *   用完即弃**，不落盘；
 * - 手动压缩：用户点一下就压缩，产物**落成检查点**并持久化，之后每轮都带着它。
 * 两者叠加：先按检查点切片，再对切片结果按窗口自动压缩（见 services/ai/agent.ts）。
 *
 * ⚠️ 这里的 `stats` **不含 baseTokens**（系统提示词 + 工具 schema）：这条路径不建 agent，
 * 拿不到它们。于是手动压缩报出的 token 会比圆环显示的请求侧总量小一截 —— 圆环那张卡对
 * 这类值标了「压缩后估算」，如实呈现，不要拿它去和自动压缩的数字直接比大小。
 */
import type {
  AgentChatMessage,
  ChatCompressResult,
  ContextCompression,
  ConversationContextSummary
} from '@shared/types'
import { storage } from '../storage'
import { toModelMessages } from './agent-core'
import { countTokens, splitTurns, summarizeHistory, withSummaryPrefix } from './context'

/** 摘要参与再摘要时的固定包装（与请求侧注入的那句保持同样的口气） */
const RESUMMARY_PREFIX = '（以下是对先前对话的摘要）\n\n'

export interface CheckpointSlice {
  /** 检查点之后的原文 */
  messages: AgentChatMessage[]
  /**
   * 切掉了东西时才非空 —— 调用方据此决定要不要注入摘要消息。
   *
   * 一条都没切掉就不注入：否则会平白多出一段与原文重复的摘要，白占预算还干扰模型。
   */
  summaryText: string | null
}

/**
 * 按检查点把历史切成「检查点之后的原文」。
 *
 * 切片优先按 id、兜底按时间（id 会因编辑重发 / 删除而消失，见 `ConversationContextSummary`）。
 *
 * ⚠️ 切点落在历史之外时**原样返回、不注入摘要**：宁可什么都不做，也不能把上下文清空 ——
 * 摘要是省 token 的手段，不该反过来变成丢上下文的途径。
 */
export function sliceByCheckpoint(
  history: AgentChatMessage[],
  checkpoint?: ConversationContextSummary
): CheckpointSlice {
  if (!checkpoint) return { messages: history, summaryText: null }
  const cut = history.findIndex((m) => m.id === checkpoint.upToMessageId)
  const rest =
    cut >= 0
      ? history.slice(cut + 1)
      : history.filter((m) => m.createdAt > checkpoint.upToCreatedAt)
  // rest 为空 = 切点比整段历史还新（异常）；长度没变 = 一条都没切掉。两种都不动。
  if (rest.length === 0 || rest.length === history.length) {
    return { messages: history, summaryText: null }
  }
  return { messages: rest, summaryText: checkpoint.text }
}

/**
 * 手动压缩当前会话：把「最后一轮之外」的旧轮摘要成一段，落成新的检查点。
 *
 * 固定「只保留最后一轮」而不是按预算保留近期若干轮 —— 用户点这个按钮就是
 * 「立刻给我腾出空间」，不是「差不多就行了」。连续点两次也成立：上一次的摘要会作为
 * 一段普通文本参与这次再摘要（见 RESUMMARY_PREFIX），成果不会被丢掉。
 *
 * 任何一步不满足条件都返回 `ok: false` 且**不改动任何数据**，reason 可直接展示给用户。
 */
export async function compressConversationNow(
  conversationId: string
): Promise<ChatCompressResult> {
  const conversation = storage.getAgentConversation(conversationId)
  if (!conversation) return { ok: false, reason: '会话不存在' }
  // ACP 会话的上下文由 agent 自己管理：本地既没有消息可摘要，也没有模型配置可用
  if (conversation.kind === 'acp') {
    return { ok: false, reason: '外部 Agent 会话的上下文在 agent 侧管理，这里不提供压缩' }
  }
  // 摘要用「这个会话正绑定的模型」：与对话同一配置，摘要口径和对话一致
  const settings = storage.getAiSettings()
  const config =
    (conversation.configId ? storage.getAiConfig(conversation.configId) : undefined) ??
    (settings.activeConfigId ? storage.getAiConfig(settings.activeConfigId) : undefined)
  if (!config) return { ok: false, reason: '尚未配置 AI 模型，无法压缩' }

  // 已有检查点时：只把「上次压缩之后新增的旧轮」拿去再摘要，上次的摘要作为底稿
  const previous = conversation.contextSummary
  const pending = previous ? sliceByCheckpoint(conversation.messages, previous).messages : conversation.messages

  const turns = splitTurns(pending)
  if (turns.length <= 1) {
    return {
      ok: false,
      reason: previous ? '上一次压缩之后没有新的对话可压缩' : '对话不足两轮，没什么可压缩的'
    }
  }

  const oldTurns = turns.slice(0, -1).flat()
  const keptTurn = turns[turns.length - 1]
  /**
   * 检查点截止在**被摘要那部分的最后一条**（不是保留区的最后一条）。
   *
   * ⚠️ 这里差一轮就是「丢上下文」和「省 token」的区别：
   * 切片语义是「`upToMessageId` **之后**的消息保持原文」（见 `sliceByCheckpoint`）。
   * 若把边界记在保留区末条，最近这一轮就落在边界之前 —— 它既没以原文发出去，
   * 又已经被摘要替代，模型会丢掉**最新、最相关**的那一轮。fishwork 就是这么错的，别照抄。
   *
   * 另外注意：这里的切点与下面的 `stats.summarizedTurns` **同出于这一次 `splitTurns(pending)`**，
   * 所以两者不可能对不上。fishwork 那边需要额外加「轮数一致性校验」，是因为它的切点要跨层去
   * 引用 `compressContext` 内部算出的轮数 —— 别把这里改成那种写法。
   */
  const boundary = oldTurns[oldTurns.length - 1]
  if (!boundary) return { ok: false, reason: '压缩结果异常：没有可摘要的消息' }

  // ⚠️ 摘要失败就整个失败、不落检查点：绝不能落一个「只有替代关系、没有正文」的检查点，
  // 那等于「旧轮既没原文也没摘要」，上下文直接断档，而且用户没有察觉。
  const summary = await summarizeHistory(
    [
      ...(previous ? [{ role: 'user' as const, content: RESUMMARY_PREFIX + previous.text }] : []),
      ...toModelMessages(oldTurns)
    ],
    { model: config, modelId: conversation.modelId }
  )
  if (!summary) return { ok: false, reason: '摘要生成失败，未做任何改动，请稍后重试' }

  const keptModelMessages = toModelMessages(keptTurn)
  const stats: ContextCompression = {
    beforeTokens: countTokens(toModelMessages(pending)),
    afterTokens: countTokens(withSummaryPrefix(keptModelMessages, summary)),
    summarizedTurns: turns.length - 1,
    keptTurns: 1,
    truncated: false
  }
  const checkpoint: ConversationContextSummary = {
    text: summary,
    upToMessageId: boundary.id,
    upToCreatedAt: boundary.createdAt,
    createdAt: Date.now(),
    stats
  }
  const saved = storage.setAgentContextSummary(conversationId, checkpoint)
  if (!saved) return { ok: false, reason: '会话不存在' }
  return { ok: true, summary: saved.contextSummary }
}

/**
 * 清除摘要检查点：之后每轮回到全文历史。
 *
 * 原始消息一直都在，删掉的只是「替代关系」—— 所以这个操作完全可逆且无损。
 */
export function clearConversationSummary(conversationId: string): ChatCompressResult {
  const conversation = storage.getAgentConversation(conversationId)
  if (!conversation) return { ok: false, reason: '会话不存在' }
  if (!conversation.contextSummary) return { ok: false, reason: '当前没有摘要，无需清除' }
  const saved = storage.setAgentContextSummary(conversationId, null)
  if (!saved) return { ok: false, reason: '会话不存在' }
  return { ok: true }
}
