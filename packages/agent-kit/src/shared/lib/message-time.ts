/**
 * 消息时刻的显示格式（**纯函数**，零依赖 —— 与 `duration.ts` 同一套路，能单测）。
 *
 * 用途只有一个：消息底部 hover 才露出来的那排操作里、最前面那一格时刻 ——
 * 用户消息是**发送时间**，助手消息是那一轮的**结束时间**。
 *
 * ## 为什么要按「离现在多远」分三段
 *
 * 只给 `HH:mm` 在同一个会话里够看（几乎都在同一天）。但翻历史会话时，「14:03」到底是
 * 今天还是上周就分不清了，于是：
 *
 * | 何时 | 显示 | 例 |
 * |---|---|---|
 * | 今天 | `HH:mm` | `14:03` |
 * | 今年的其他日子 | `MM-DD HH:mm` | `10-28 09:07` |
 * | 更早 | `YYYY-MM-DD HH:mm` | `2025-12-31 23:58` |
 *
 * ⚠️ **不做相对时间**（「3 分钟前」）：那得定时重渲染才有意义，而消息列表是按条记忆化的，
 * 为一个 hover 才看见的标签让整列每秒重排不值当。
 *
 * ⚠️ 用本地时区 + 手写补零，**不用 `toLocaleString`**：后者的分隔符、是否 12 小时制都跟
 * 系统区域走，同一条消息在别人机器上会变成 `2:03 PM` 甚至 `30.10.2026`。
 */

const pad2 = (n: number): string => String(n).padStart(2, '0')

/** 时:分（本地时区，补零） */
const clockPart = (date: Date): string => `${pad2(date.getHours())}:${pad2(date.getMinutes())}`

/** 日期部分：同年只给 `MM-DD`，跨年才带上年份 */
const datePart = (date: Date, now: Date): string => {
  const md = `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
  return date.getFullYear() === now.getFullYear() ? md : `${date.getFullYear()}-${md}`
}

/**
 * 操作行里那格时刻（紧凑写法，只有 hover 才看见）。
 *
 * @example formatMessageTime(ts) // 今天            → '14:03'
 * @example formatMessageTime(ts) // 今年早些时候    → '10-28 09:07'
 * @example formatMessageTime(ts) // 去年            → '2025-12-31 23:58'
 * @returns 时间戳无效时给空串（调用方据此不渲染这一格）
 */
export function formatMessageTime(createdAt: number, now: number = Date.now()): string {
  if (!Number.isFinite(createdAt) || createdAt <= 0) return ''
  const date = new Date(createdAt)
  const today = new Date(now)
  const sameDay =
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate()
  return sameDay ? clockPart(date) : `${datePart(date, today)} ${clockPart(date)}`
}

/**
 * `title` tooltip 用的完整时刻（到秒、永远带年份、跨天也说得清）。
 *
 * 紧凑写法被压缩掉的精度在这里还回来：同一分钟内两条消息、或者想确认「这一轮到底几点
 * 收的尾」，靠这行字。
 */
export function formatMessageTimeExact(createdAt: number): string {
  if (!Number.isFinite(createdAt) || createdAt <= 0) return ''
  const date = new Date(createdAt)
  // 这里**不**复用 `datePart`：它会把同年折成 `MM-DD`，而 tooltip 要的是完整日期
  const ymd = `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
  return `${ymd} ${clockPart(date)}:${pad2(date.getSeconds())}`
}
