/**
 * 脚本分组：列表 / 新建 / 更新。
 * GET  /api/scripts/groups  → `ScriptGroup[]`
 * POST /api/scripts/groups  body `ScriptGroupInput`（带 id 更新 / 不带新建）→ 列表
 */
import { domain } from '@/lib/server/state'
import { describeError, jsonError, parseJsonBody } from '@/app/api/_lib/auth'

export async function GET() {
  return Response.json(domain.listScriptGroups())
}

export async function POST(request: Request) {
  const body = await parseJsonBody<Parameters<typeof domain.saveScriptGroup>[0]>(request)
  if (!body) return jsonError(400, '请求体不是合法 JSON')
  try {
    domain.saveScriptGroup(body)
  } catch (err) {
    const { status, message } = describeError(err)
    return jsonError(status, message)
  }
  return Response.json(domain.listScriptGroups())
}