/**
 * 当前视口是否**比手机宽**（`min-width: 768px`，就是 Tailwind 的 `md`）。
 *
 * 本工程是手机壳，这个判断只服务一件事：**面板的横滑转场只在窄屏生效**
 * （设置页 ↔ 列表、设置菜单 ↔ 二级页）。平板横屏 / 桌面浏览器调试时更宽，两块
 * 能并排放下，再让它们互相横着滑就没道理 —— 那时退回原来的「直接显示 / 隐藏」。
 *
 * 与 `useIsMobile`（`@fizz/agent-kit`）**正好相反**，但刻意各写一份：那个是共享组件
 * 判「侧栏走抽屉还是占位」的语义，语义跟「这块面板要不要横滑」不是一回事，别顺手复用。
 *
 * 首帧就读到真实值（`useState` 惰性初值），不会先按移动端画一帧再翻 —— 那一下就是
 * 一次多余的动画。web / 调试环境里 `window` 恒在，不需要 SSR 兜底。
 */
import { useEffect, useState } from 'react'

export const WIDE_QUERY = '(min-width: 768px)'

export function useIsWide(): boolean {
  const [wide, setWide] = useState(() => window.matchMedia(WIDE_QUERY).matches)

  useEffect(() => {
    const mql = window.matchMedia(WIDE_QUERY)
    const onChange = (e: MediaQueryListEvent): void => setWide(e.matches)
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [])

  return wide
}
