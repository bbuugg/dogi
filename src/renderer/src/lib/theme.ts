import { useEffect, useState } from 'react'
import type { ColorThemeName } from '@shared/types'

const DARK_QUERY = '(prefers-color-scheme: dark)'

/**
 * 应用界面配色：写 html 的 data-color-theme 属性，CSS 里对应 `[data-color-theme='…']`。
 * 中性配色是默认值，移除属性即可。
 */
export function applyColorTheme(name: ColorThemeName): void {
  const el = document.documentElement
  if (name === 'neutral') el.removeAttribute('data-color-theme')
  else el.setAttribute('data-color-theme', name)
}

/**
 * 同步初始化 html 根元素的主题 class。
 * 主进程已通过 nativeTheme.themeSource 覆盖 prefers-color-scheme，
 * 因此这里只需跟随 matchMedia（同时覆盖 system / light / dark 三种模式）。
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
