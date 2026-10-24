/**
 * 取消进行中的请求：中断 fetch，`send` 路由照常回包（`status: 0 + error`）。
 * POST /api/api-client/send/abort  body `{ sendId }` → `{ ok: true }`
 */
import { inflightHttp } from '@/lib/server/api-client/http'
import { jsonError, parseJsonBody } from '@/app/api/_lib/auth'

export async function POST(request: Request) {
  const body = await parseJsonBody<{ sendId?: string }>(request)
  if (!body?.sendId) return jsonError(400, '缺少 sendId')
  inflightHttp.get(body.sendId)?.abort()
  inflightHttp.delete(body.sendId)
  return Response.json({ ok: true })
}