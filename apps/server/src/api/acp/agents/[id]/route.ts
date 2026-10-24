/**
 * 删除 ACP agent 配置。
 * DELETE /api/acp/agents/:id
 *
 * 路由路径与 API_ROUTES 契约中的 `/api/acp/agents/:id/default` 同前缀，
 * DELETE 方法的 [id] 段在这里处理。
 */
import { domain } from '@/lib/server/state'
import { describeError, jsonError } from '@/app/api/_lib/auth'

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  try {
    return Response.json(domain.deleteAcpAgent(id))
  } catch (err) {
    const { status, message } = describeError(err)
    return jsonError(status, message)
  }
}
