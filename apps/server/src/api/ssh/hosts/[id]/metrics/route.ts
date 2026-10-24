/**
 * 某台 SSH 主机的性能监控：`GET /api/ssh/hosts/:id/metrics[?interval=2000]`
 *
 * 返回当前快照 + 近期历史（画曲线用）。采集逻辑全在 `lib/server/ssh/monitor.ts` 的
 * 按主机采集器里 —— 这里**不自己连 SSH、也不自己解析**，只负责「把 interval 参数
 * 交给它、把结果返回」。本路由是**纯读**的，但会顺带充当心跳：每来一次请求就等于说
 * 一句「我还在看这台机器」，采集器据此决定要不要继续采（空闲 30s 回收，见
 * `IDLE_TIMEOUT_MS`）。
 *
 * ⚠️ 不进全局状态推送（与 `/api/system` 同一条理由）：性能数据每 2s 就变，走 WS 会让
 * 每个前端都跟着收一份；而且**没人看的时候不该采**，推送模型反而做不到这一点。
 *
 * 鉴权由根 `proxy.ts` 中间件统一兜底（`/api/*` 全走 JWT），这里不重复判。
 */
import { getHostMetrics } from '@/lib/server/ssh/monitor'
import { describeError, jsonError } from '@/app/api/_lib/auth'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  /**
   * `interval` 交给采集器归一化（非法值回落缺省、越界收敛到边界）——
   * 这里不重复夹取，免得两处阈值各写一份、改一处漏一处。
   */
  const raw = new URL(request.url).searchParams.get('interval')
  const interval = raw === null ? undefined : Number(raw)
  try {
    return Response.json(getHostMetrics(id, interval))
  } catch (err) {
    const { status, message } = describeError(err)
    return jsonError(status, message)
  }
}
