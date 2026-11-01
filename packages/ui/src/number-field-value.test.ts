/**
 * 这几条在防的回归：设置页的数字输入框「删干净之后自动回填上一次的值」。
 *
 * 根因是受控值把「正在输入」和「已保存」混成一个东西：清空 → `''` 被兜成默认值 →
 * 写回 store → 再作为 value 渲染回来。修法是把草稿与提交拆开，判定的边界就在这里：
 * 半截输入绝不提交、越界只在失焦时按 `clamp` 处理、空输入一律提交 `null`
 * （回默认值还是「不限制」由调用方决定，组件不替它猜）。
 */
import { describe, expect, it } from 'vitest'
import {
  clampNumber,
  isDraftCommittable,
  normalizeNumberDraft,
  parseNumberDraft,
  type NumberDraftRange
} from './number-field-value'

const CONCURRENCY: NumberDraftRange = { min: 1, max: 10, fallback: 5 }

describe('parseNumberDraft', () => {
  it('认十进制整数与小数，去掉首尾空白', () => {
    expect(parseNumberDraft(' 42 ')).toBe(42)
    expect(parseNumberDraft('1.5')).toBe(1.5)
    expect(parseNumberDraft('.5')).toBe(0.5)
    expect(parseNumberDraft('-3')).toBe(-3)
  })

  it('空串 / 半截输入 / 非法写法一律 null', () => {
    expect(parseNumberDraft('')).toBeNull()
    expect(parseNumberDraft('-')).toBeNull()
    expect(parseNumberDraft('.')).toBeNull()
    expect(parseNumberDraft('abc')).toBeNull()
    // 宽松解析会把这些当成数字，放进设置项只会让人意外
    expect(parseNumberDraft('0x10')).toBeNull()
    expect(parseNumberDraft('1e5')).toBeNull()
    expect(parseNumberDraft('12px')).toBeNull()
  })
})

describe('isDraftCommittable', () => {
  it('删空之后不提交 —— 这就是「不会回填」的关键', () => {
    expect(isDraftCommittable('', CONCURRENCY)).toBe(false)
    expect(isDraftCommittable('   ', CONCURRENCY)).toBe(false)
  })

  it('打字过程中的中间态不提交', () => {
    expect(isDraftCommittable('-', { min: -10, fallback: 0 })).toBe(false)
    expect(isDraftCommittable('12.', CONCURRENCY)).toBe(false)
  })

  it('完整且在区间内才提交', () => {
    expect(isDraftCommittable('1', CONCURRENCY)).toBe(true)
    expect(isDraftCommittable('10', CONCURRENCY)).toBe(true)
    expect(isDraftCommittable('11', CONCURRENCY)).toBe(false)
    expect(isDraftCommittable('0', CONCURRENCY)).toBe(false)
  })

  it('越界判定与 clamp 无关：不夹边界时也不在打字过程中提交', () => {
    expect(isDraftCommittable('11', { ...CONCURRENCY, clamp: false })).toBe(false)
  })

  it('默认只收整数，显式关掉才收小数', () => {
    expect(isDraftCommittable('2.5', CONCURRENCY)).toBe(false)
    expect(isDraftCommittable('2.5', { ...CONCURRENCY, integer: false })).toBe(true)
  })
})

describe('normalizeNumberDraft（失焦 / 卸载时唯一改写草稿的地方）', () => {
  it('空输入提交 null，由调用方决定回默认值还是不限制', () => {
    expect(normalizeNumberDraft('', CONCURRENCY)).toBeNull()
    expect(normalizeNumberDraft('   ', { min: 0, fallback: 80 })).toBeNull()
  })

  it('越界夹到最近的边界（夹完界面上看得见）', () => {
    expect(normalizeNumberDraft('1500', { min: 1, max: 1000, fallback: 80 })).toBe(1000)
    expect(normalizeNumberDraft('-4', CONCURRENCY)).toBe(1)
  })

  it('clamp=false 时原样提交越界值，交给调用方校验', () => {
    const range: NumberDraftRange = { min: 1, max: 64, clamp: false, fallback: null }
    expect(normalizeNumberDraft('200', range)).toBe(200)
    expect(normalizeNumberDraft('0', range)).toBe(0)
  })

  it('需要整数时四舍五入', () => {
    expect(normalizeNumberDraft('12.5', { min: 0, fallback: 0 })).toBe(13)
    expect(normalizeNumberDraft('12.4', { min: 0, fallback: 0 })).toBe(12)
  })

  it('整数关掉时保留小数（CPU 核数）', () => {
    expect(normalizeNumberDraft('1.5', { integer: false, fallback: null })).toBe(1.5)
  })

  it('彻底无法解析时回到 fallback，别让一个错字把配置清空', () => {
    expect(normalizeNumberDraft('abc', CONCURRENCY)).toBe(5)
    expect(normalizeNumberDraft('abc', { fallback: null })).toBeNull()
  })
})

describe('clampNumber', () => {
  it('只夹边界，不取整', () => {
    expect(clampNumber(1.7, 1, 10)).toBe(1.7)
    expect(clampNumber(99, 1, 10)).toBe(10)
    expect(clampNumber(-1, 0)).toBe(0)
  })
})
