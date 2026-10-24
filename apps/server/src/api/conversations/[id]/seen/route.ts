/**
 * 把会话标记成「已看过」：POST /api/conversations/:id/seen（无 body）。
 *
 * 唯一的调用方是前端的 `openConversation` —— 用户点开一条**定时任务跑出来的**会话时，
 * 清掉 `unseen`（侧栏那颗红点）。应答回整份会话清单，与归档 / 重命名同一个用法
 * （前端直接 `set({ conversations })`，不必再发一次列表请求）。
 *
 * 幂等：已经看过 / 从来没有这个标记的会话直接返回当前清单，不写盘。
 */
import { domain } from '@/lib/server/state'
import { describeError, jsonError } from '@/app/api/_lib/auth'

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  try {
    domain.markConversationSeen(id)
    return Response.json(domain.listConversations())
  } catch (err) {
    const { status, message } = describeError(err)
    return jsonError(status, message)
  }
}
