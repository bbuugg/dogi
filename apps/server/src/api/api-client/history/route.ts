/**
 * 请求历史：列表（最新在前）/ 覆盖写入 / 清空。
 * GET    /api/api-client/history → `ApiHistoryEntry[]`
 * POST   /api/api-client/history body `ApiHistoryEntry[]`（渲染端裁剪后的完整窗口）→ 列表
 * DELETE /api/api-client/history → `[]`（清空）
 *
 * 为什么 POST 是**覆盖整段**而不是逐条增删：历史是「最近 N 条」的滑动窗口，逐条维护
 * 更容易和界面状态不一致（同 dogi 的 `saveApiHistory`）。
 */
import type { ApiHistoryEntry } from '@fizz/contracts/types'
import { domain } from '@/lib/server/state'
import { describeError, jsonError, parseJsonBody } from '@/app/api/_lib/auth'

export async function GET() {
  return Response.json(domain.listApiHistory())
}

export async function POST(request: Request) {
  const body = await parseJsonBody<ApiHistoryEntry[]>(request)
  if (!Array.isArray(body)) return jsonError(400, '请求体不是合法 JSON')
  try {
    return Response.json(domain.saveApiHistory(body))
  } catch (err) {
    const { status, message } = describeError(err)
    return jsonError(status, message)
  }
}

export async function DELETE() {
  return Response.json(domain.clearApiHistory())
}