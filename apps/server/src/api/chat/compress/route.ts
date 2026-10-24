/**
 * 手动触发上下文压缩：POST /api/chat/compress，body `{ conversationId }`。
 *
 * 与自动压缩（每轮发请求前、超预算才触发）的区别只有一点：**不等预算**
 * （`compactHistory({ force: true })`）。切点、摘要 prompt、结果拼装与自动压缩完全同一套 ——
 * pi 的 `/compact` 也是这样：同一个 `compact()`，只是跳过 `shouldCompact()` 那道门。
 *
 * 落检查点：摘要写进会话的 `contextSummary`，之后每轮组装历史时都从这里切片
 * （摘要消息 + 检查点之后的原文，见 `chat-turn.ts` 的 `historyForTurn`）。
 * 原始消息一条不动，清除检查点即回到全文。
 *
 * 仅内置 agent（mastra）会话可用：ACP 会话的历史在 agent 侧，本地摘要没有意义。
 * 摘要请求失败直接报错返回，**不落检查点** —— 落一个没有正文的检查点等于永久丢失旧上下文。
 */
import { compactHistory, defaultContextWindowFromEnv } from '@fizz/agent'
import { resolveContextWindow } from '@fizz/contracts/types'
import type { ConversationContextSummary } from '@fizz/contracts/types'
import { domain, markDirty } from '@/lib/server/state'
import { describeError, jsonError, parseJsonBody } from '@/app/api/_lib/auth'

export async function POST(request: Request) {
  const body = await parseJsonBody<{ conversationId?: string }>(request)
  if (!body?.conversationId) return jsonError(400, '缺少 conversationId')

  const conversation = domain.getConversation(body.conversationId)
  if (!conversation) return jsonError(404, '会话不存在')
  if (conversation.backend === 'acp') {
    return jsonError(400, 'ACP 会话的上下文在 agent 侧，不支持本地压缩')
  }
  // 摘要用「这个会话正绑定的模型」：与对话同一配置，摘要口径和对话一致
  if (!conversation.configId || !conversation.modelId) {
    return jsonError(400, '会话还没有选择模型，无法压缩')
  }
  let model
  try {
    model = domain.resolveModelConfig(conversation.configId, conversation.modelId)
  } catch (err) {
    return jsonError(400, describeError(err).message)
  }
  if (conversation.messages.length === 0) return jsonError(400, '会话还没有历史，没什么可压缩的')

  try {
    /**
     * `force: true` 跳过阈值判断（用户点了就压），切点仍然按 `keepRecentTokens` 保留近期原文。
     * 不传 `baseTokens`（系统提示词 + 工具 schema 的估算）—— 这条路不建 agent，拿不到它们；
     * 于是统计里的 token 是「消息部分」，会比圆环显示的请求侧总量小一截
     *（圆环那张卡对这类值标了「压缩后估算」）。
     */
    const compacted = await compactHistory(conversation.messages, {
      conversationId: conversation.id,
      contextWindow: resolveContextWindow(
        model.models,
        model.model,
        defaultContextWindowFromEnv()
      ),
      force: true,
      model
    })

    // compressed = null：历史还在保留区内，没有可摘要的部分
    if (!compacted.compressed) {
      return Response.json({ ok: false, reason: '历史还没超出保留区，没什么可压缩的' })
    }
    if (!compacted.summary || !compacted.summarizedUpTo) {
      return jsonError(502, '摘要生成失败，未做任何改动，请稍后重试')
    }

    /**
     * 检查点截止在**被摘要部分的末条**（`summarizedUpTo`），不是「保留区末条」。
     *
     * 切片语义是「这条**之后**的消息保持原文」。记在保留区末条的话，保留区那几条既没以
     * 原文发出去、又没被摘要覆盖 —— 等于最近那一轮从上下文里凭空消失（用户刚说的话
     * 模型看不见）。记在被摘要部分的末条，切片后保留区原样是原文，首尾正好接上。
     */
    const summary: ConversationContextSummary = {
      text: compacted.summary,
      upToMessageId: compacted.summarizedUpTo.id,
      upToCreatedAt: compacted.summarizedUpTo.createdAt,
      createdAt: Date.now(),
      stats: compacted.compressed
    }
    domain.setContextSummary(conversation.id, summary)
    markDirty(['conversations'])
    return Response.json({ ok: true, summary })
  } catch (err) {
    console.error('[server] 手动压缩失败：', err)
    return jsonError(500, describeError(err).message)
  }
}

/**
 * 清除摘要检查点：DELETE /api/chat/compress，body `{ conversationId }`。
 * 原始消息一直都在，删掉的只是「替代关系」—— 之后每轮回到全文历史。
 */
export async function DELETE(request: Request) {
  const body = await parseJsonBody<{ conversationId?: string }>(request)
  if (!body?.conversationId) return jsonError(400, '缺少 conversationId')
  const conversation = domain.getConversation(body.conversationId)
  if (!conversation) return jsonError(404, '会话不存在')
  domain.setContextSummary(conversation.id, null)
  markDirty(['conversations'])
  return Response.json({ ok: true })
}
