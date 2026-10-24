/**
 * 应用日志：增量推送（SSE）。
 *
 * GET /api/app-log/stream?since=<seq> → AppLogFrame
 *
 * `since` 是客户端**已经拿到的最大 seq**（来自 `AppLogResult.maxSeq`），
 * 服务端只推它之后的条目 —— 重连时不会整段回放，切换命名空间 Tab 也不用重连
 * （过滤在前端做，日志总量有上限，不值得为每个 Tab 建一条连接）。
 */
import { createSSEStream } from '@/app/api/_lib/sse'
import { subscribeAppLog } from '@/lib/server/app-log/service'

export async function GET(request: Request) {
  const url = new URL(request.url)
  const raw = Number(url.searchParams.get('since') ?? 0)
  const since = Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 0

  return createSSEStream(async (writer, clientGone) => {
    let done: (() => void) | null = null
    const finished = new Promise<void>((resolve) => {
      done = resolve
    })
    let settled = false
    const settle = (): void => {
      if (settled) return
      settled = true
      done?.()
    }

    /**
     * ⚠️ 这条 `clientGone` 监听**不能省**：这是条永续流，没有 `end` 帧兜底，漏了必然泄漏。
     *
     * 客户端静默断开（关标签页 / 网络断 / 桌面端 `closeSse`）时不会走到 `send` 失败，
     * `finished` 就永远不 resolve，`stop()` 永不执行 —— 订阅者一直留在 `appLog` 的
     * 监听器里，日志每写一条还要往一条没人读的连接上扇出一次。桌面端是长驻进程、
     * 日志面板会反复开关，这就是只增不减的慢性泄漏。
     */
    if (clientGone.aborted) settle()
    else clientGone.addEventListener('abort', settle, { once: true })

    const stop = subscribeAppLog(since, {
      send: async (frame) => {
        try {
          await writer.write({ event: frame.type, data: JSON.stringify(frame) })
        } catch {
          // 客户端已经走了
          settle()
        }
      },
      close: settle
    })

    await finished
    stop()
  })
}
