/**
 * 执行一次 HTTP 请求（由服务端发出：绕开渲染端 CORS，可达内网与自签证书服务）。
 * POST /api/api-client/send  body `ApiSendInput` → `ApiHttpResponse`
 *
 * `sendId` 由渲染端生成：登记 AbortController，供 `POST /api/api-client/send/abort` 手动取消。
 * 请求结束（无论成败）立即清理 Map，避免无限增长。
 */
import type { ApiSendInput } from '@fizz/contracts/types'
import { executeHttp, inflightHttp } from '@/lib/server/api-client/http'
import { jsonError, parseJsonBody } from '@/app/api/_lib/auth'

export async function POST(request: Request) {
  const body = await parseJsonBody<ApiSendInput>(request)
  if (!body || !body.request || typeof body.request !== 'object') {
    return jsonError(400, '请求体不是合法 JSON')
  }
  const ac = new AbortController()
  if (body.sendId) inflightHttp.set(body.sendId, ac)
  try {
    return Response.json(await executeHttp(body.request, ac.signal))
  } finally {
    if (body.sendId) inflightHttp.delete(body.sendId)
  }
}