/**
 * 手动触发上下文压缩：POST /api/chat/compress，body `{ conversationId }`。
 *
 * 与自动压缩（每轮发请求前、超预算才触发）共用同一套：
 * - 切点、摘要 prompt、流式 `context-compaction-*` 事件、结果拼装全部一样；
 * - 唯一区别是**不等预算**（`compactHistory({ force: true })`）—— pi 的 `/compact`
 *   也是同一个 `compact()`，只是跳过 `shouldCompact()` 那道门；
 * - 新客户端带 `Accept: text/event-stream` 时用 SSE 推过程，界面显示与自动压缩相同的
 *   折叠块（不是只转圈等结果）；不带这个头的老客户端仍拿到原来的 JSON。
 *
 * 落检查点：摘要写进会话的 `contextSummary`，之后每轮组装历史时都从这里切片
 * （摘要消息 + 检查点之后的原文，见 `chat-turn.ts` 的 `historyForTurn`）。
 * 原始消息一条不动，清除检查点即回到全文。
 *
 * 仅内置 agent（内置）会话可用：ACP 会话的历史在 agent 侧，本地摘要没有意义。
 * 摘要请求失败直接报错返回，**不落检查点** —— 落一个没有正文的检查点等于永久丢失旧上下文。
 */
import {
  compactHistory,
  defaultContextWindowFromEnv,
  rememberedBaseTokens
} from '@fizz/agent'
import type { CompactHistoryResult } from '@fizz/agent'
import { resolveContextWindow } from '@fizz/contracts/types'
import type { ChatCompressFrame } from '@fizz/contracts/agent-api'
import type { ConversationContextSummary } from '@fizz/contracts/types'
import { domain, markDirty } from '@/lib/server/state'
import { describeError, jsonError, parseJsonBody } from '@/app/api/_lib/auth'
import { createSSEStream } from '@/app/api/_lib/sse'

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

  /**
   * 与自动压缩共用「增量摘要」：已经有一层检查点时，只在它之后找切点、把新内容合并进
   * 旧摘要，而不是把整段历史重新摘要一遍（既费 token，也容易丢信息）。
   * - `autoSummary`：自动压缩的固化点（重启后内存缓存为空时靠它接上）；
   * - `contextSummary`：上一次手动压缩的检查点；它记的是「已摘要的最后一条」，所以
   *   seed 的保留起点是它的**下一条**。
   */
  const seed = (() => {
    if (conversation.autoSummary) {
      return {
        keepFromMessageId: conversation.autoSummary.keepFromMessageId,
        text: conversation.autoSummary.text,
        at: conversation.autoSummary.createdAt
      }
    }
    const checkpoint = conversation.contextSummary
    if (!checkpoint) return undefined
    const cut = conversation.messages.findIndex((m) => m.id === checkpoint.upToMessageId)
    const firstKept =
      cut >= 0
        ? conversation.messages[cut + 1]
        : conversation.messages.find((m) => m.createdAt > checkpoint.upToCreatedAt)
    return firstKept
      ? {
          keepFromMessageId: firstKept.id,
          text: checkpoint.text,
          at: checkpoint.createdAt
        }
      : undefined
  })()

  /**
   * `force: true` 跳过阈值判断（用户点了就压），切点仍然按 `keepRecentTokens` 保留近期原文。
   *
   * `baseTokens` 从 `runAgent` 记下的那份拿（这条路不建 agent，算不出来）。不补的话
   * 统计就只有「消息部分」，和圆环（含 base）差一整个 base —— 用户会看到
   * 「压完 32k，圆环还是 100k」。拿不到（进程刚重启、这个会话还没跑过）就退回 0。
   */
  const baseTokens = rememberedBaseTokens(conversation.id) ?? 0
  const runCompaction = (
    onSummaryStart?: (info: { beforeTokens: number; summarizedTurns: number; keptTurns: number }) => void,
    onSummaryDelta?: (info: { delta: string; phase: 'checkpoint' | 'turn-prefix' }) => void
  ): Promise<CompactHistoryResult> =>
    compactHistory(conversation.messages, {
      conversationId: conversation.id,
      contextWindow: resolveContextWindow(
        model.models,
        model.model,
        defaultContextWindowFromEnv()
      ),
      force: true,
      baseTokens,
      ...(seed ? { seed } : {}),
      model,
      ...(onSummaryStart ? { onSummaryStart } : {}),
      ...(onSummaryDelta ? { onSummaryDelta } : {})
    })

  /** 落盘并返回检查点；没有可摘要的部分返回 null，摘要缺失抛错 */
  const persist = (compacted: CompactHistoryResult): ConversationContextSummary | null => {
    // compressed = null：历史还在保留区内，没有可摘要的部分
    if (!compacted.compressed) return null
    if (!compacted.summary || !compacted.summarizedUpTo) {
      throw new Error('摘要生成失败，未做任何改动，请稍后重试')
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
    return summary
  }

  /**
   * 「没压成」的两种原因必须分开说 —— 原来一律回「历史还没超出保留区」，在
   * 「系统提示词 + 工具定义已经把窗口吃掉」的场景下是误导：用户看着圆环爆红，
   * 却被告知没东西可压，只能一遍遍点。
   */
  const skipReason = (compacted: CompactHistoryResult): string =>
    compacted.skipped === 'no-budget'
      ? '可用预算已经被系统提示词 / 工具定义 / 已有摘要占满，压缩压不下来 —— 要降占用请精简项目文档、关掉不用的 MCP 工具或技能'
      : '检查点之后的历史还不够一个保留区，没什么可压缩的（圆环里的占用主要来自系统提示词、工具定义与已有摘要，压缩动不了这部分）'

  const wantsStream = request.headers.get('accept')?.includes('text/event-stream') ?? false
  if (!wantsStream) {
    // 老客户端：保持原来的 JSON 应答（不发流式事件）
    try {
      const compacted = await runCompaction()
      const summary = persist(compacted)
      if (!summary) {
        return Response.json({ ok: false, reason: skipReason(compacted) })
      }
      return Response.json({ ok: true, summary })
    } catch (err) {
      console.error('[server] 手动压缩失败：', err)
      return jsonError(500, describeError(err).message)
    }
  }

  return createSSEStream(async (writer) => {
    const write = (frame: ChatCompressFrame): Promise<void> =>
      writer.write({ event: frame.type, data: JSON.stringify(frame) })

    try {
      const compacted = await runCompaction(
        (info) => {
          void write({
            type: 'event',
            event: { type: 'context-compaction-start', ...info }
          })
        },
        (info) => {
          void write({
            type: 'event',
            event: { type: 'context-compaction-delta', ...info }
          })
        }
      )
      const summary = persist(compacted)
      if (!summary) {
        await write({
          type: 'result',
          result: { ok: false, reason: skipReason(compacted) }
        })
        return
      }
      await write({
        type: 'event',
        event: {
          type: 'context-compressed',
          ...compacted.compressed!,
          summary: compacted.summary!
        }
      })
      await write({ type: 'result', result: { ok: true, summary } })
    } catch (err) {
      console.error('[server] 手动压缩失败：', err)
      await write({ type: 'error', message: describeError(err).message })
    }
  })
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
