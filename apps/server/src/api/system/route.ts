/**
 * 服务器性能监控：GET /api/system（可选 `?detail=1`）
 *
 * 返回当前快照 + 近期历史（画曲线用）。采集逻辑全在 `lib/server/services/system-monitor.ts`
 * 的常驻采样器里 —— 这里**不自己采**（CPU 占用是两次采样的 delta，自己采会跟采样器抢节奏，
 * 详见那个文件的顶部说明）。本路由只负责「取快照 + 按需展开磁盘」。
 *
 * 鉴权由根 `proxy.ts` 中间件统一兜底（`/api/*` 全走 JWT），这里不重复判。
 *
 * ⚠️ 纯读、无副作用，所以不进全局状态推送：性能数据每 2s 就变，走 WS 会让每个前端都跟着
 * 收一份。前端按需轮询即可（侧栏常驻卡片约 2s 一次，与采样节奏对齐）。
 */
import { getSystemMetrics } from '@/lib/server/services/system-monitor'
import { fail } from '@/app/api/_lib/http'

export async function GET(request: Request) {
  const detail = new URL(request.url).searchParams.get('detail') === '1'
  try {
    return Response.json(await getSystemMetrics(detail))
  } catch (err) {
    return fail(err)
  }
}
