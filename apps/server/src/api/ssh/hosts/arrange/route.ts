/**
 * 主机树拖拽重排（分组层级 + 主机归属）。
 * POST /api/ssh/hosts/arrange  body `HostArrangeInput` → `{ groups, hosts }`
 *
 * 分组的新层级与每台主机的归属**一次提交**：拖拽里两者是一起变的，拆成两个接口
 * 会出现「分组挪了、主机还留在旧分组」的中间态。
 */
import type { HostArrangeInput } from '@fizz/contracts/types'
import { domain } from '@/lib/server/state'
import { describeError, jsonError, parseJsonBody } from '@/app/api/_lib/auth'

export async function POST(request: Request) {
  const body = await parseJsonBody<HostArrangeInput>(request)
  if (!body || !Array.isArray(body.groups) || !Array.isArray(body.hosts)) {
    return jsonError(400, '请求体不是合法 JSON')
  }
  try {
    return Response.json(domain.arrangeHosts(body))
  } catch (err) {
    const { status, message } = describeError(err)
    return jsonError(status, message)
  }
}
