/**
 * 列某一个 MCP server 自己的工具：连上 → listTools → 把进程收掉。
 * GET /api/mcp/servers/:id/tools
 */
import { probeMcpServerTools } from '@fizz/mcp'
import { domain } from '@/lib/server/state'
import { jsonError } from '@/app/api/_lib/auth'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const server = domain.listMcpServers().find((s) => s.id === id)
  if (!server) return jsonError(404, 'MCP server 不存在')
  return Response.json(await probeMcpServerTools(server))
}
