/**
 * 系统栏安全区 → Radix Popper 的 `collisionPadding`。
 *
 * 手机壳（`apps/mobile`）是全屏 edge-to-edge 的：Capacitor 的 `SystemBars` 把窗口切到
 * edge-to-edge 后，往 `<html>` 注入 `--safe-area-inset-*`，页面自己用这些变量给常驻
 * chrome 让位（见 `apps/mobile/src/app/app-shell.tsx` 的根容器）。
 *
 * 但 Radix 的弹层是 **portal 到 `document.body`** 的，它只认识「视口边界」——默认
 * `collisionPadding = 0`。于是靠近顶部的触发器一弹菜单（内容比下方空间高 → 翻到上方），
 * 菜单就会顶到 y=0，也就是**戳进状态栏**。这里把安全区读出来交给 Radix 参与避让计算，
 * 它就会把 `top` 边界收在状态栏下沿。
 *
 * ⚠️ 必须读 `--safe-area-inset-*`，不读 `env(safe-area-inset-*)`：安卓 WebView 的 `env()`
 * 只有刘海，系统栏恒为 0（同 `app-shell.tsx` 那段注释）。web / desktop 没注入这些变量
 * → 全 0 → 返回 `undefined`，Radix 保持默认行为，与改动前逐像素一致。
 */
type Side = 'top' | 'right' | 'bottom' | 'left'

const SIDES: readonly Side[] = ['top', 'right', 'bottom', 'left']

function readInset(style: CSSStyleDeclaration, side: Side): number {
  const value = Number.parseFloat(style.getPropertyValue(`--safe-area-inset-${side}`))
  return Number.isFinite(value) && value > 0 ? value : 0
}

/** 当前页面的系统栏安全区（px）；无注入时全 0 */
export function safeAreaInsets(): Record<Side, number> {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return { top: 0, right: 0, bottom: 0, left: 0 }
  }
  const style = window.getComputedStyle(document.documentElement)
  return {
    top: readInset(style, 'top'),
    right: readInset(style, 'right'),
    bottom: readInset(style, 'bottom'),
    left: readInset(style, 'left')
  }
}

/**
 * 合并调用方给的 `collisionPadding` 与系统栏安全区，**取每边较大者**：
 * 调用方的值表达「离边缘至少留这么多」，安全区表达「别进系统栏」，两者都得满足。
 *
 * 返回 `undefined` 表示两边都没要求 → 不传，让 Radix 用默认值。
 */
export function resolveCollisionPadding(
  padding?: number | Partial<Record<Side, number>>
): Record<Side, number> | undefined {
  const safe = safeAreaInsets()
  const hasSafe = SIDES.some((side) => safe[side] > 0)
  if (padding === undefined) return hasSafe ? safe : undefined
  const merged = {} as Record<Side, number>
  for (const side of SIDES) {
    const own = typeof padding === 'number' ? padding : (padding[side] ?? 0)
    merged[side] = Math.max(own, safe[side])
  }
  return merged
}
