import { useEffect, useState } from 'react'
import type { ColorThemeName } from '@shared/types'

const DARK_QUERY = '(prefers-color-scheme: dark)'

/** 解析 #rgb / #rrggbb（带 alpha 时忽略）为 0-1 的 sRGB 分量 */
function parseHex(hex: string): [number, number, number] | null {
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim())
  if (!match) return null
  let digits = match[1]
  if (digits.length === 3) {
    digits = digits[0] + digits[0] + digits[1] + digits[1] + digits[2] + digits[2]
  }
  const value = parseInt(digits, 16)
  return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255]
}

/**
 * sRGB 十六进制 → OKLCH 分量（Ottosson 的 Oklab 公式）。
 * 之所以转到 OKLCH：项目里所有配色都以 oklch 定义，按亮度分量夹取时
 * 感知上更均匀，也不会像 HSL 那样改变色相观感。
 */
function hexToOklch(hex: string): { l: number; c: number; h: number } | null {
  const rgb = parseHex(hex)
  if (!rgb) return null
  const [r, g, b] = rgb.map((v) =>
    v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  ) as [number, number, number]

  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)

  const okL = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s
  const okA = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s
  const okB = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s

  return {
    l: okL,
    c: Math.hypot(okA, okB),
    h: ((Math.atan2(okB, okA) * 180) / Math.PI + 360) % 360
  }
}

/** 自定义强调色写入的内联变量：浅色/深色各一套，切换明暗主题无需重算 */
const CUSTOM_ACCENT_VARS = [
  '--custom-primary-light',
  '--custom-primary-foreground-light',
  '--custom-ring-light',
  '--custom-primary-dark',
  '--custom-ring-dark'
]

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

/**
 * 由用户选定的颜色算出两套强调色变量：保留色相与彩度，只把亮度夹进该明暗主题
 * 下可用的区间——浅色主题要够深才压得住白字，深色主题要够亮才能在深背景上显眼。
 */
function customAccentVars(hex: string): Record<string, string> | null {
  const oklch = hexToOklch(hex)
  if (!oklch) return null
  const fmt = (l: number) =>
    `oklch(${l.toFixed(3)} ${oklch.c.toFixed(3)} ${oklch.h.toFixed(1)})`

  const lightPrimary = clamp(oklch.l, 0.35, 0.62)
  return {
    '--custom-primary-light': fmt(lightPrimary),
    // 偏亮的色相（黄、青、浅绿）白字压不住，改用深色文字
    '--custom-primary-foreground-light':
      lightPrimary > 0.58 ? 'oklch(0.22 0.01 0)' : 'oklch(0.985 0.005 0)',
    '--custom-ring-light': fmt(clamp(oklch.l, 0.45, 0.72)),
    '--custom-primary-dark': fmt(clamp(oklch.l, 0.62, 0.86)),
    '--custom-ring-dark': fmt(clamp(oklch.l, 0.5, 0.72))
  }
}

/**
 * 应用界面配色：写 html 的 data-color-theme 属性，CSS 里对应 `[data-color-theme='…']`。
 * 中性配色是默认值，移除属性即可。
 * 自定义配色（custom）没有固定色值，改由 customColor 算出浅色/深色两套变量内联到
 * html 上，CSS 再按当前明暗各取一套（见 index.css）。
 */
export function applyColorTheme(name: ColorThemeName, customColor?: string): void {
  const el = document.documentElement
  const isCustom = name === 'custom'
  const vars = isCustom && customColor ? customAccentVars(customColor) : null

  if (vars) {
    for (const [key, value] of Object.entries(vars)) el.style.setProperty(key, value)
  } else {
    for (const key of CUSTOM_ACCENT_VARS) el.style.removeProperty(key)
  }

  // custom 但取色失败（customColor 非法）时退回中性配色，避免留下半套变量
  if (name === 'neutral' || (isCustom && !vars)) el.removeAttribute('data-color-theme')
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
