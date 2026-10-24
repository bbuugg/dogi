/**
 * 单个会话（含完整消息历史）。
 * GET    /api/conversations/:id/messages
 * DELETE /api/conversations/:id/messages  —— 清空会话（删掉全部消息，保留会话本身）
 */
import { domain } from '@/lib/server/state'
import { describeError, jsonError } from '@/app/api/_lib/auth'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const conversation = domain.getConversation(id)
  if (!conversation) return jsonError(404, '会话不存在')
  return Response.json(conversation)
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  try {
    domain.clearConversation(id)
    return Response.json(domain.listConversations())
  } catch (err) {
    const { status, message } = describeError(err)
    return jsonError(status, message)
  }
}
