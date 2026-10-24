/**
 * 拖拽重排（脚本分组顺序 + 脚本归属）。
 * POST /api/scripts/arrange  body `ScriptArrangeInput` → `{ groups, scripts }`
 */
import type { ScriptArrangeInput } from '@fizz/contracts/types'
import { domain } from '@/lib/server/state'
import { describeError, jsonError, parseJsonBody } from '@/app/api/_lib/auth'

export async function POST(request: Request) {
  const body = await parseJsonBody<ScriptArrangeInput>(request)
  if (!body || !Array.isArray(body.groupIds) || !Array.isArray(body.scripts)) {
    return jsonError(400, '请求体不是合法 JSON')
  }
  try {
    return Response.json(domain.arrangeScripts(body))
  } catch (err) {
    const { status, message } = describeError(err)
    return jsonError(status, message)
  }
}