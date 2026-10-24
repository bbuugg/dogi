/**
 * 拖拽重排（分组树 + 请求归属）。
 * POST /api/api-client/arrange  body `ApiArrangeInput` → `{ groups, requests }`
 */
import type { ApiArrangeInput } from '@fizz/contracts/types'
import { domain } from '@/lib/server/state'
import { describeError, jsonError, parseJsonBody } from '@/app/api/_lib/auth'

export async function POST(request: Request) {
  const body = await parseJsonBody<ApiArrangeInput>(request)
  if (!body || !Array.isArray(body.groups) || !Array.isArray(body.requests)) {
    return jsonError(400, '请求体不是合法 JSON')
  }
  try {
    return Response.json(domain.arrangeApi(body))
  } catch (err) {
    const { status, message } = describeError(err)
    return jsonError(status, message)
  }
}