/**
 * MCP server 配置路由：列表 / 创建 / 删除。
 * GET    /api/mcp/servers
 * POST   /api/mcp/servers
 * DELETE /api/mcp/servers/:id
 */
import { domain } from '@/lib/server/state'
import { describeError, jsonError, parseJsonBody } from '@/app/api/_lib/auth'

export async function GET() {
  return Response.json(domain.listMcpServers())
}

export async function POST(request: Request) {
  const body = await parseJsonBody<Parameters<typeof domain.saveMcpServer>[0]>(request)
  if (!body) return jsonError(400, '请求体不是合法 JSON')
  try {
    domain.saveMcpServer(body)
  } catch (err) {
    const { status, message } = describeError(err)
    return jsonError(status, message)
  }
  return Response.json(domain.listMcpServers())
}
