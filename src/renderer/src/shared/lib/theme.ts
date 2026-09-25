import { useEffect, useState } from 'react'
import { applyColorTheme as applyColorThemeTo } from '@shared/theme'
import type { ColorThemeName } from '@shared/types'

/**
 * 纯计算（自定义配色的 oklch 换算）与写 html 属性的部分在 `@shared/theme` ——
 * preload 要在首帧之前把主题落到 html 上，同样需要它们，放在渲染端就够不着。
 * 这里只保留渲染端特有的部分：作用到 documentElement 的包装、明暗 class 与 React hook。
 */
export { customAccentVars } from '@shared/theme'

/** 应用界面配色（作用于 documentElement；preload 那边要显式传元素） */
export function applyColorTheme(name: ColorThemeName, customColor?: string): void {
  applyColorThemeTo(name, customColor, document.documentElement)
}

const DARK_QUERY = '(prefers-color-scheme: dark)'

/**
 * 同步初始化 html 根元素的主题 class。
 * 主进程已通过 nativeTheme.themeSource 覆盖 prefers-color-scheme，
 * 因此这里只需跟随 matchMedia（同时覆盖 system / light / dark 三种模式）。
 *
 * preload 在页面脚本之前已经按同一份偏好设过一次，这里主要管运行中的切换。
 */
export function initThemeSync(): () => void {
  const mql = window.matchMedia(DARK_QUERY)
  const apply = () => {
    document.documentElement.classList.toggle('dark', mql.matches)
  }
  apply()
  mql.addEventListener('change', apply)
  return () => mql.removeEventListener('change', apply)
}

/** 当前是否为暗色主题（响应跟随系统与手动切换） */
export function useIsDarkTheme(): boolean {
  const [isDark, setIsDark] = useState(() => window.matchMedia(DARK_QUERY).matches)

  useEffect(() => {
    const mql = window.matchMedia(DARK_QUERY)
    const onChange = () => setIsDark(mql.matches)
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [])

  return isDark
}
