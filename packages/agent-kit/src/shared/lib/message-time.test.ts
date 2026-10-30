/**
 * 消息时刻的显示口径（`message-time.ts`）。
 *
 * 防的回归：
 * ① 昨天 / 去年的消息只显示 `14:03` —— 翻历史时根本分不清是哪天；
 * ② 补零丢了，`2026-1-9 8:05` 这种参差写法；
 * ③ 跟着系统区域变成 `2:03 PM` / `30.10.2026`（手写格式化就是为了避开这个）；
 * ④ 时间戳无效（0 / NaN）时渲染出一个 `Invalid Date`。
 */
import { describe, expect, it } from 'vitest'
import { formatMessageTime, formatMessageTimeExact } from './message-time'

/** 本地时区造时刻（测试与实现都用本地时区，跨时区跑也自洽） */
const at = (y: number, m: number, d: number, h = 0, min = 0, s = 0): number =>
  new Date(y, m - 1, d, h, min, s).getTime()

const NOW = at(2026, 10, 30, 18, 0)

describe('formatMessageTime', () => {
  it('今天只给时:分', () => {
    expect(formatMessageTime(at(2026, 10, 30, 14, 3), NOW)).toBe('14:03')
    expect(formatMessageTime(at(2026, 10, 30, 0, 5), NOW)).toBe('00:05')
  })

  it('今年的其他日子带上月-日', () => {
    expect(formatMessageTime(at(2026, 10, 28, 9, 7), NOW)).toBe('10-28 09:07')
    // 跨月的昨天也一样：不同天就补日期，不做「昨天」这种相对词
    expect(formatMessageTime(at(2026, 9, 30, 23, 59), NOW)).toBe('09-30 23:59')
  })

  it('去年及更早带上年份', () => {
    expect(formatMessageTime(at(2025, 12, 31, 23, 58), NOW)).toBe('2025-12-31 23:58')
  })

  it('同一时刻但跨年，按跨年档显示', () => {
    // 12-31 23:59 在 1-1 看来是「去年的今天」，必须带年份
    expect(formatMessageTime(at(2025, 12, 31, 23, 59), at(2026, 1, 1, 0, 10))).toBe(
      '2025-12-31 23:59'
    )
  })

  it('月 / 日 / 时 / 分都补零', () => {
    expect(formatMessageTime(at(2026, 1, 9, 8, 5), at(2026, 3, 1))).toBe('01-09 08:05')
  })

  it('无效时间戳给空串（调用方据此不渲染）', () => {
    expect(formatMessageTime(0, NOW)).toBe('')
    expect(formatMessageTime(-1, NOW)).toBe('')
    expect(formatMessageTime(Number.NaN, NOW)).toBe('')
  })
})

describe('formatMessageTimeExact', () => {
  it('tooltip 用完整日期 + 到秒', () => {
    expect(formatMessageTimeExact(at(2026, 10, 30, 14, 3, 21))).toBe('2026-10-30 14:03:21')
    expect(formatMessageTimeExact(at(2026, 1, 9, 8, 5, 4))).toBe('2026-01-09 08:05:04')
  })

  it('同年也带年份（和紧凑写法不同）', () => {
    expect(formatMessageTimeExact(at(2026, 10, 30, 14, 3, 21))).toContain('2026-')
  })

  it('无效时间戳给空串', () => {
    expect(formatMessageTimeExact(0)).toBe('')
    expect(formatMessageTimeExact(Number.NaN)).toBe('')
  })
})
