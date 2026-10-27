/**
 * 虚拟键条的**裁决**：宿主显式开关 > 输入能力判据。
 *
 * 只测纯函数部分 —— 媒体查询与 `useSyncExternalStore` 的接线在浏览器里才成立，
 * 这里固定的是最容易回归的那三条规则。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { resolveVirtualKeyBar, setVirtualKeyBar, virtualKeyBarOverride } from './useVirtualKeyBar'

afterEach(() => setVirtualKeyBar(null))

describe('resolveVirtualKeyBar', () => {
  it('宿主没意见时按能力判据：只有手指可用才显示', () => {
    expect(virtualKeyBarOverride()).toBeNull()
    expect(resolveVirtualKeyBar(true)).toBe(true)
    expect(resolveVirtualKeyBar(false)).toBe(false)
  })

  it('宿主显式关闭后，即使设备是纯触屏也不显示（扩展跑在触屏笔记本上）', () => {
    setVirtualKeyBar(false)
    expect(resolveVirtualKeyBar(true)).toBe(false)
    expect(resolveVirtualKeyBar(false)).toBe(false)
  })

  it('宿主显式打开后，即使设备有精确指针也显示（调试用）', () => {
    setVirtualKeyBar(true)
    expect(resolveVirtualKeyBar(false)).toBe(true)
  })
})
