/**
 * 模型请求自动重试的退避等待。
 *
 * 可重试网络错误的判定在 `./error-utils` 的 `isRetryableNetworkError`（沿 cause 链找
 * `isRetryable` / ECONNRESET / ETIMEDOUT / UND_ERR_BODY_TIMEOUT / ENOTFOUND / terminated）。
 * 重试次数由设置里的 `maxRetries` 决定（`0` = 不重试，见 `@shared/ai-timeouts`）。
 *
 * 重试由主进程自己驱动（见 agent.ts / ai.ts），**不再用 mastra 的 `modelSettings.maxRetries`** ——
 * 只有自己驱动才能在每次重试时发一条 `retry` 事件给界面。
 */

/** 退避上限（毫秒）：次数再多也按这个等，避免无限拉长 */
const RETRY_MAX_DELAY_MS = 15_000
/** 退避基数（毫秒）：第 1 次重试等这个，之后翻倍 */
const RETRY_BASE_DELAY_MS = 1_000

/**
 * 第 `attempt` 次重试前的等待时长（指数退避 + 上限）。`attempt` 从 1 起。
 * 1s → 2s → 4s → 8s → 15s（封顶）。
 */
export function retryDelayMs(attempt: number): number {
  return Math.min(RETRY_BASE_DELAY_MS * 2 ** (Math.max(1, attempt) - 1), RETRY_MAX_DELAY_MS)
}

/**
 * 可被 `AbortSignal` 打断的 sleep。
 *
 * 返回 true = 正常等满；false = 等待期间被中止（用户点了停止），调用方据此按中止收场。
 */
export function sleepWithSignal(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false)
  return new Promise<boolean>((resolve) => {
    let done = false
    const finish = (ok: boolean): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve(ok)
    }
    const onAbort = (): void => finish(false)
    const timer = setTimeout(() => finish(true), ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
