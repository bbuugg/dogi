/**
 * 时长的显示格式（**纯函数**，零依赖，jiti 可直跑 —— 所以能单测）。
 *
 * ## 为什么改
 *
 * Agent 消息下方的用量统计里，整轮耗时一直是 `(durationMs / 1000).toFixed(1)}s`。
 * 短轮次没问题，长轮次（大重构、跑测试、等外部 agent）会变成 `742.5s` 这种 —— 又长
 * 又难读：得自己在脑子里除一下才知道是 12 分钟。用户要求「支持分钟」。
 *
 * ## 格式
 *
 * | 范围 | 显示 | 例 |
 * |---|---|---|
 * | < 60s | 一位小数 + `s`（保持原样，秒级精度有用） | `12.3s` |
 * | 1h 以内 | `Xm Ys`（秒为 0 时省略） | `3m 45s`、`4m` |
 * | ≥ 1h | `Xh Ym Zs`（同理省略 0 段） | `1h 5m 2s`、`1h 2m` |
 *
 * 阈值是 **60 秒**而不是「超过两位就折」：那之下精确到 0.1s 有实际意义（比较两轮快慢），
 * 那之上再给小数只是噪音。
 *
 * ## 进位
 *
 * 分档与拆段都基于 **`Math.round(ms / 1000)` 之后**的数，而不是拿小数秒直接比 ——
 * 否则 `59.96s` 会被显示成 `1m 0s` 这类中间态，而 60 这个边界还会因为 float 漂移
 * 在 `0.9m` / `1m` 之间反复横跳。
 *
 * 副作用是 `59.96s` 会被显示成 `1m`（半分不舍）而不是 `60.0s` —— 这是刻意的：`60.0s`
 * 是个更难读的中间形态，而且真实耗时本身没精确到 0.1s。同理 `599.4s` 是 `9m 59s`
 * 而不是 `10m`（round 只进 ≥0.5s 的那一半）。
 */

/** 秒档与分钟档的分界（秒）。到它为止给小数秒，过它换 `Xm` */
const MINUTE_S = 60

/** 一小时是多少秒 */
const HOUR_S = 3600

/** 无效/未记录的耗时（NaN、负数）。给破折号而不是 0：0 会是「确实没花时间」的假事实 */
export const DURATION_NA = '—'

/**
 * 把毫秒格式化成人类可读的时长。
 *
 * @example formatDuration(12_340)   → '12.3s'
 * @example formatDuration(59_960)   → '1m'      // round(59.96)=60，不是 60.0s
 * @example formatDuration(225_000)  → '3m 45s'
 * @example formatDuration(240_000)  → '4m'
 * @example formatDuration(599_400)  → '9m 59s'  // round 只进 ≥0.5s 的那一半
 * @example formatDuration(3_662_000) → '1h 1m 2s'
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return DURATION_NA

  // 先取整到秒，**分档也用这个数** —— 见文件头「进位」。
  // ⚠️ 拿 59960ms 直接跟 60000 比会落进秒档、显示成 `60.0s`，而 60000ms 又显示 `1m`，
  // 同一个门的门口两端长得不一样。
  const total = Math.round(ms / 1000)
  if (total < MINUTE_S) return `${(ms / 1000).toFixed(1)}s`

  const hours = Math.floor(total / HOUR_S)
  const minutes = Math.floor((total % HOUR_S) / MINUTE_S)
  const seconds = total % MINUTE_S
  // 只出现非 0 的段；走到这里 total ≥ 60，所以小时与分钟至少有一段在
  const segs = [
    hours ? `${hours}h` : '',
    minutes ? `${minutes}m` : '',
    // 小时存在时秒仍有意义（哪怕为 0）—— `1h 2m` 与 `1h 2m 5s` 是不同的事
    seconds ? `${seconds}s` : ''
  ]
  return segs.filter(Boolean).join(' ') || '1m'
}

/**
 * 给 `title` tooltip 用的完整时长（保留毫秒）。
 *
 * 显示上为了避免噪音折成了 `3m 45s`，但精确值仍然想知道 —— 比较两轮快慢时差 300ms
 * 算不算数只有毫秒答得上来。
 */
export function formatDurationExact(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return DURATION_NA
  return `${ms.toLocaleString()}ms`
}
