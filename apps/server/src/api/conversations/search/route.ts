/**
 * 搜会话：标题 + 消息正文。
 * GET /api/conversations/search?q=关键词&limit=N
 *
 * 为什么有它：会话是产品里最核心的资产，攒到几十条之后就只能靠滚动去找，等于没有历史。
 *
 * ⚠️ 这个文件必须存在：同级的 `[id]/route.ts` 会把 `/search` 也当成一个 id 捕获掉
 * （动态段 `[id]` 匹配任何一段）。Next 优先匹配**静态段**，所以只要有
 * `conversations/search/route.ts`，它就会先于 `[id]` 命中。
 */
import { domain } from '@/lib/server/state'
import { jsonError } from '@/app/api/_lib/auth'
import { fail } from '@/app/api/_lib/http'

/** 结果条数上限；不传用 20。前端只需要「够用户认出来」的数量，再多只是刷屏 */
const DEFAULT_LIMIT = 20
const MAX_LIMIT = 50

export async function GET(request: Request) {
  const url = new URL(request.url)
  const keyword = url.searchParams.get('q') ?? ''
  if (!keyword.trim()) return jsonError(400, '请输入搜索关键词')

  // ⚠️ 别写成 `Number(get('limit'))`：参数缺省时 get 返回 null，而 Number(null) === 0 是
  // finite，会被当成「用户要了 0 条」而 clamp 成 1，结果永远只出一条。
  const raw = url.searchParams.get('limit')
  const rawLimit = raw === null ? Number.NaN : Number(raw)
  const limit = Number.isFinite(rawLimit)
    ? Math.min(Math.max(Math.floor(rawLimit), 1), MAX_LIMIT)
    : DEFAULT_LIMIT

  try {
    return Response.json(domain.searchConversations(keyword, limit))
  } catch (err) {
    return fail(err)
  }
}