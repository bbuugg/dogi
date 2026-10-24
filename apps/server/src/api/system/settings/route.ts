/**
 * 服务器性能监控偏好（总开关）：GET / POST `/api/system/settings`。
 *
 * 关掉之后要同时做两件事（缺一不可）：
 * 1. **停掉服务端采样器** —— 用户的原话是「后台不统计数据」，光藏前端徽标的话采样照旧
 *    每 ~2s 烧一次（Windows 上网络那步还要 spawn PowerShell），见
 *    `lib/server/services/system-monitor.ts` 的 `syncSystemMonitorEnabled()`；
 * 2. 前端（`SystemMonitorBadge`）据此不再渲染监控条、也不再轮询 `/api/system`。
 *
 * ⚠️ 与 `/api/system`（只读监控快照）是两个路径：那条只读数据，这条读写偏好。
 * 鉴权由根 `app.ts` 的中间件统一兜底（`/api/*` 全走 JWT），这里不重复判。
 */
import type { SystemMonitorSettings } from '@fizz/contracts'
import { domain } from '@/lib/server/state'
import { syncSystemMonitorEnabled } from '@/lib/server/services/system-monitor'
import { parseJsonBody } from '@/app/api/_lib/auth'

export async function GET(): Promise<Response> {
  return Response.json(domain.getSystemMonitorSettings())
}

export async function POST(request: Request): Promise<Response> {
  const body = await parseJsonBody<{ enabled?: boolean }>(request)
  // 只把**合法且显式给了**的字段放进 patch：缺字段 = 保留原样（与浏览器偏好同款语义）。
  const patch: Partial<SystemMonitorSettings> = {}
  if (typeof body?.enabled === 'boolean') patch.enabled = body.enabled

  const settings = domain.saveSystemMonitorSettings(patch)
  // 落盘后立刻同步采样器：关 → 停采，开 → 重新起采（两条都幂等）
  await syncSystemMonitorEnabled()
  return Response.json(settings)
}
