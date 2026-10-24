/**
 * 用量汇总：GET /api/usage?days=30&limit=20
 *
 * 为什么要有它：会话头部那个累计条数只告诉你「这一个会话烧了多少」，而真正的问题
 * 是「这个月一共烧了多少、哪天最费、哪个会话是大户」。要敢把 agent 放开后台跑，
 * 就得先看得见总量。
 *
 * ⚠️ **只返回 token，不返回金额** —— 原因见 `UsageSummary` 的注释（没有单价表，
 * 硬折算出来的钱会骗人）。
 *
 * 纯读、无副作用，所以不进全局状态推送：用量变化是每轮都发生的，走 WS 推送等于
 * 让每个前端都跟着刷一遍统计。前端按需拉取即可。
 */
import { domain } from '@/lib/server/state'
import { fail } from '@/app/api/_lib/http'

/** 默认统计窗口（天）。一个月是「够看清趋势」的最小单位 */
const DEFAULT_DAYS = 30
const MAX_DAYS = 365
/** 默认返回的最费会话条数 */
const DEFAULT_LIMIT = 20
const MAX_LIMIT = 100

/**
 * 解析正整数查询参数。
 *
 * `Number('')` 是 0、`Number('abc')` 是 NaN，所以不能只判 isFinite —— 那样
 * `?days=` 会变成 0 天（窗口退化成「今天」）。空值一律走缺省。
 */
function positiveInt(raw: string | null, fallback: number, max: number): number {
  if (raw === null || raw.trim() === '') return fallback
  const value = Number(raw)
  if (!Number.isFinite(value)) return fallback
  return Math.min(Math.max(Math.floor(value), 1), max)
}

export async function GET(request: Request) {
  const url = new URL(request.url)
  const days = positiveInt(url.searchParams.get('days'), DEFAULT_DAYS, MAX_DAYS)
  const limit = positiveInt(url.searchParams.get('limit'), DEFAULT_LIMIT, MAX_LIMIT)
  try {
    return Response.json(domain.aggregateUsage(days, limit))
  } catch (err) {
    return fail(err)
  }
}