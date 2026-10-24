import { describe, expect, it } from 'vitest'
import { generateSlug, uniqueSlug } from './slug'

describe('generateSlug —— 合法子域标签 + 定长', () => {
  it('生成的 slug 只含 [a-z0-9] 且长度 12、不以数字开头', () => {
    for (let i = 0; i < 200; i++) {
      const s = generateSlug()
      expect(s).toMatch(/^[a-z][a-z0-9]{11}$/)
    }
  })
})

describe('uniqueSlug —— 避开已占用值', () => {
  it('uniqueSlug 避开已占用值', () => {
    const taken = new Set<string>()
    // 先塞进去 1000 个已生成值，再要求 200 个新的都不在 taken 里
    for (let i = 0; i < 1000; i++) taken.add(generateSlug())
    for (let i = 0; i < 200; i++) {
      const s = uniqueSlug(taken)
      expect(taken.has(s)).toBe(false)
      taken.add(s)
    }
  })
})
