/**
 * 删除一个分组（含多级子树）。
 * DELETE /api/api-client/groups/:id[?deleteRequests=1] → `{ groups, requests }`
 *
 * 默认只删分组：子孙分组与组内请求整体上移一级；`deleteRequests=1` 时连同子树内请求一起删。
 */
import { domain } from '@/lib/server/state'
import { describeError, jsonError } from '@/app/api/_lib/auth'

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const deleteRequests = new URL(request.url).searchParams.get('deleteRequests') === '1'
  try {
    return Response.json(domain.deleteApiGroup(id, deleteRequests))
  } catch (err) {
    const { status, message } = describeError(err)
    return jsonError(status, message)
  }
}