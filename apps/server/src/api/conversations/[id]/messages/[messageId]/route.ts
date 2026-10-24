/**
 * 删除会话里单条消息。
 * DELETE /api/conversations/:id/messages/:messageId
 *
 * `?from=1` = **这条及其后的全部消息一起删**（「从这里重新开始」/ 编辑重发）。
 *
 * ⚠️ 后者必须是一次请求：客户端早先是逐条 DELETE，N 条消息 = N 次往返 + N 次整份会话
 * 落盘，长历史下要好几秒、界面上还看不出在干什么（用户报过）。语义只有「截断」一种，
 * 所以并到这条路上，用一个查询开关区分，不必再开一条路由。
 */
import { domain } from '@/lib/server/state'
import { describeError, jsonError } from '@/app/api/_lib/auth'

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string; messageId: string }> }
) {
  const { id, messageId } = await params
  const from = new URL(request.url).searchParams.get('from') === '1'
  try {
    if (from) domain.deleteMessagesFrom(id, messageId)
    else domain.deleteMessage(id, messageId)
    return Response.json(domain.listConversations())
  } catch (err) {
    const { status, message } = describeError(err)
    return jsonError(status, message)
  }
}
