/**
 * 客户端工具的执行结果回填（上行）：解开对应那条客户端工具调用的 await。
 * POST /api/chat/client-tool-result
 *
 * 与 confirm / followup 是同一套「服务端推一帧、客户端另开一条 HTTP 回填」的反向通道
 * （见 `lib/server/client-tool-gate.ts` 的说明）。命中就解开 await、同一个回合继续跑；
 * 没命中（已超时 / 已取消）按幂等空成功返回。
 */
import type { ClientToolResult, ClientToolResultInput } from '@fizz/contracts/agent-api'
import { pendingClientTools } from '@/lib/server/state'
import { jsonError, parseJsonBody } from '@/app/api/_lib/auth'

export async function POST(request: Request) {
  const body = await parseJsonBody<ClientToolResultInput>(request)
  if (!body) return jsonError(400, '请求体不是合法 JSON')
  if (typeof body?.callId !== 'string' || typeof body?.ok !== 'boolean') {
    return jsonError(400, '缺少 callId 或 ok')
  }
  const entry = pendingClientTools.get(body.callId)
  if (!entry) return Response.json({ resolved: false } satisfies ClientToolResult)
  pendingClientTools.delete(body.callId)
  entry.resolve({
    ok: body.ok,
    ...(body.result !== undefined ? { result: body.result } : {}),
    ...(typeof body.error === 'string' && body.error ? { error: body.error } : {})
  })
  return Response.json({ resolved: true } satisfies ClientToolResult)
}
