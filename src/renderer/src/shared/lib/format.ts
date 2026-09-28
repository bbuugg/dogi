/** 字节数转人类可读字符串（自动选择 KB/MB/GB/TB） */
export function formatBytes(bytes: number): string {
  if (!bytes || bytes < 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  const value = bytes / Math.pow(1024, i)
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

/** 速率（字节/秒）转为带 /s 的可读字符串 */
export function formatRate(bytesPerSec: number): string {
  return `${formatBytes(bytesPerSec)}/s`
}

/** 秒数转「Xd Xh Xm Xs」运行时长 */
export function formatDuration(seconds: number): string {
  if (!seconds || seconds < 0) return '0s'
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  const parts: string[] = []
  if (d) parts.push(`${d}d`)
  if (h) parts.push(`${h}h`)
  if (m) parts.push(`${m}m`)
  if (s && !d && !h) parts.push(`${s}s`)
  return parts.join(' ') || '0s'
}

/** 两位补零（`1h2m` → `1h02m`，位数不跳才看得清） */
function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/**
 * **紧凑**耗时显示（毫秒入参）：秒 → 分 → 小时 → 天 自动升级单位。
 *
 * 一轮 Agent 对话可能跑几分钟甚至更久，全按秒写出来就是「523.4s」这种读不出量级的数字；
 * 但 1 分钟以内保留一位小数 —— `8.4s` 比 `8s` 更能说明这一轮有多快。
 * 只保留两级单位（多余的那级四舍五入太大，反而看不出量级）：
 * `8.4s` / `1m23s` / `1h02m` / `2d03h`。
 */
export function formatCompactDuration(ms: number): string {
  // 先按秒级四舍五入到 0.1s，**再**判单位：这样 59.96s 会进位成「1m00s」，
  // 而不是先按 59.96 判成「秒级」显示成「60.0s」，也不是拆成「0m59s」。
  const total = Math.round(Math.max(0, ms) / 100) / 10
  if (total < 60) return `${total.toFixed(1)}s`
  const d = Math.floor(total / 86400)
  const h = Math.floor((total % 86400) / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = Math.floor(total % 60)
  if (d) return `${d}d${pad2(h)}h`
  if (h) return `${h}h${pad2(m)}m`
  return `${m}m${pad2(s)}s`
}
