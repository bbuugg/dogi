import { describe, expect, it } from 'vitest'
import { isValidPreviewPort } from './preview-port'

describe('isValidPreviewPort —— 预览端口校验', () => {
  it('不填端口 = 合法（该项目不支持预览）', () => {
    expect(isValidPreviewPort(undefined)).toBe(true)
  })

  it('8080 被拒（撞容器内 agent 控制面）', () => {
    expect(isValidPreviewPort(8080)).toBe(false)
  })

  it('0 / 负数 / 65536 / 非整数 被拒', () => {
    expect(isValidPreviewPort(0)).toBe(false)
    expect(isValidPreviewPort(-1)).toBe(false)
    expect(isValidPreviewPort(65536)).toBe(false)
    expect(isValidPreviewPort(3000.5)).toBe(false)
  })

  it('常规端口通过', () => {
    expect(isValidPreviewPort(3000)).toBe(true)
    expect(isValidPreviewPort(8081)).toBe(true)
  })
})
