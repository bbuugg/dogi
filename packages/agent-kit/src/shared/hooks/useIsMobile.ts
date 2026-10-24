/**
 * 当前视口是否是手机宽度（<768px）。
 *
 * 用 CSS 的 md 断点同款数值，保证 JS 判定与 Tailwind 的 max-md: 类名行为一致：
 * 手机上侧栏变成覆盖抽屉、抽拽条隐藏，都靠这个开关。
 */
import { useEffect, useState } from 'react'

/**
 * 手机断点。**导出**是为了让非 React 的模块也能拿到同一个判据 —— 两处各写一份
 * 字面量迟早漂开。
 */
export const MOBILE_QUERY = '(max-width: 767px)'

export function useIsMobile(): boolean {
  const [mobile, setMobile] = useState(() => window.matchMedia(MOBILE_QUERY).matches)

  useEffect(() => {
    const mql = window.matchMedia(MOBILE_QUERY)
    const onChange = (e: MediaQueryListEvent): void => setMobile(e.matches)
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [])

  return mobile
}
