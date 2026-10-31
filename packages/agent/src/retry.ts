/**
 * 模型请求的自动重试：可重试网络错误的判定 + 退避等待。
 *
 * 与桌面端（dogi）一致的判定口径：重试的是**失败的这一次模型请求本身**，
 * 不是工具调用 —— 已跑完的步骤（工具调用与结果）走断点续跑，不会被重跑，
 * 见 agent.ts 的调用处。
 */

/**
 * 判断一个错误是否「可重试的网络中断」——这类错误重发同一条消息通常能成功。
 *
 * 判定依据（沿 cause 链向上找，最多 6 层）：
 * - AI SDK 的 `APICallError.isRetryable === true`（网关返回 5xx / 429 时也会置位）
 * - 经典断流信号：`ECONNRESET` / `ETIMEDOUT` / `UND_ERR_BODY_TIMEOUT` / `ENOTFOUND`
 * - undici 在 TLS 连接被对端中途掐掉时报的 `TypeError: terminated`
 */
export function isRetryableNetworkError(err: unknown): boolean {
  let cur: unknown = err
  for (let i = 0; i < 6 && cur instanceof Error; i++) {
    const e = cur as Error & {
      code?: string
      isRetryable?: boolean
      statusCode?: number
    }
    if (e.isRetryable === true) return true
    if (
      e.code === 'ECONNRESET' ||
      e.code === 'ETIMEDOUT' ||
      e.code === 'UND_ERR_BODY_TIMEOUT' ||
      e.code === 'ENOTFOUND'
    ) {
      return true
    }
    if (e.message === 'terminated') return true
    cur = (e as { cause?: unknown }).cause
  }
  return false
}

/**
 * 判断错误是否是「上游这一轮返回了空响应」。
 *
 * 判据：`finishReason` 落到 `"other"`（AI SDK 对非标准 / 缺失的 finish_reason 一律归到
 * 这里）**且整轮没有任何内容**（正文 / 思考 / 工具调用都没有）。`runAgent` 在引擎收尾时
 * 按这个条件合成一条错误抛出来（见那里的注释）。它不是网络层错误，但性质一样：同一条
 * 请求重发通常就有内容了，所以并入「重发这一次请求」的重试路径。
 *
 * 用文案匹配而不是错误类型：错误是 `agent.ts` 里现造的，没有专用 class。
 */
export function isEmptyStreamOutputError(err: unknown): boolean {
  let cur: unknown = err
  for (let i = 0; i < 6 && cur instanceof Error; i++) {
    const e = cur as Error & { id?: string }
    if (e.message.includes('finishReason "other"')) return true
    cur = (e as { cause?: unknown }).cause
  }
  return false
}

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
 * 返回 true = 正常等满；false = 等待期间被中止（调用方据此按「用户停止」收场，不再重试）。
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
