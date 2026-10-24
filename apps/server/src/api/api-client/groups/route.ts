/**
 * 请求分组：列表 / 新建 / 更新（重命名 / 改父分组）。
 * GET  /api/api-client/groups  → `ApiGroup[]`
 * POST /api/api-client/groups  body `ApiGroupInput`（带 id 更新 / 不带新建）→ 列表
 */
import { domain } from '@/lib/server/state'
import { describeError, jsonError, parseJsonBody } from '@/app/api/_lib/auth'

export async function GET() {
  return Response.json(domain.listApiGroups())
}

export async function POST(request: Request) {
  const body = await parseJsonBody<Parameters<typeof domain.saveApiGroup>[0]>(request)
  if (!body) return jsonError(400, '请求体不是合法 JSON')
  try {
    domain.saveApiGroup(body)
  } catch (err) {
    const { status, message } = describeError(err)
    return jsonError(status, message)
  }
  return Response.json(domain.listApiGroups())
}