/**
 * 构建 MCP 工具集，返回工具信息与连接错误（MCP 设置页预览）。
 * GET /api/mcp/tools
 */
import { buildMcpToolset } from '@fizz/mcp'
import { domain } from '@/lib/server/state'

export async function GET() {
  const { infos, errors } = await buildMcpToolset(domain.listMcpServers())
  return Response.json({ infos, errors })
}
