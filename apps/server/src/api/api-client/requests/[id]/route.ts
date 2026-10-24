/**
 * 删除一条接口请求。
 * DELETE /api/api-client/requests/:id → 列表
 */
import { domain } from '@/lib/server/state'
import { describeError, jsonError } from '@/app/api/_lib/auth'

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  try {
    return Response.json(domain.deleteApiRequest(id))
  } catch (err) {
    const { status, message } = describeError(err)
    return jsonError(status, message)
  }
}