/**
 * 接口请求集合：列表 / 新建 / 更新。
 * GET  /api/api-client/requests  → `ApiRequestEntry[]`
 * POST /api/api-client/requests  body `ApiRequestEntry`（带 id 更新 / 不带新建）→ 列表
 */
import { domain } from '@/lib/server/state'
import { describeError, jsonError, parseJsonBody } from '@/app/api/_lib/auth'

export async function GET() {
  return Response.json(domain.listApiRequests())
}

export async function POST(request: Request) {
  const body = await parseJsonBody<Parameters<typeof domain.saveApiRequest>[0]>(request)
  if (!body) return jsonError(400, '请求体不是合法 JSON')
  try {
    domain.saveApiRequest(body)
  } catch (err) {
    const { status, message } = describeError(err)
    return jsonError(status, message)
  }
  return Response.json(domain.listApiRequests())
}