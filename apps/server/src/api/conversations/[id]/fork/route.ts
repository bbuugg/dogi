/**
 * 会话分叉（「从此签出」）：以某条消息（含）为终点复制出新会话。
 * POST /api/conversations/:id/fork（body: ForkInput）
 *
 * 复制语义见 `domain.forkConversation`（历史截取 / 检查点处理 / forkedFrom）。
 * 运行中的会话拒绝 —— 分叉复制的是「当前已落盘的历史」，而正在跑的那轮还在往里
 * 追加（与 deleteMessagesFrom 同一道守卫，这边在服务端拦死）。
 */
import type { ForkInput } from '@fizz/contracts/agent-api'
import { domain } from '@/lib/server/state'
import { findActiveByConversation } from '@/lib/server/chat-run'
import { describeError, jsonError, parseJsonBody } from '@/app/api/_lib/auth'

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const body = await parseJsonBody<ForkInput>(request)
  if (!body?.upToMessageId) return jsonError(400, '缺少 upToMessageId')
  const run = findActiveByConversation(id)
  if (run && run.finishedAt === undefined) {
    return jsonError(409, '会话正在运行，等这一轮结束再签出')
  }
  try {
    const conversation = domain.forkConversation(id, body.upToMessageId, body.workspaceId)
    // 列表用的是 Summary 形状（不带消息体）；fork 的调用方随后自己 loadMessages
    const { messages, ...rest } = conversation
    return Response.json({ conversation: { ...rest, messageCount: messages.length } })
  } catch (err) {
    const { status, message } = describeError(err)
    return jsonError(status, message)
  }
}
