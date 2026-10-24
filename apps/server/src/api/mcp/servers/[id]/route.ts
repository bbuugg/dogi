/**
 * 删除 MCP server。
 * DELETE /api/mcp/servers/:id
 *
 * 工具清单走另一个路由（`/api/mcp/servers/:id/tools`），这里只管删除。
 */
import { domain } from '@/lib/server/state'
import { describeError, jsonError } from '@/app/api/_lib/auth'

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  try {
    return Response.json(domain.deleteMcpServer(id))
  } catch (err) {
    const { status, message } = describeError(err)
    return jsonError(status, message)
  }
}
