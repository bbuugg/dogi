import type { ColorThemeName } from '@shared/types'

export interface ColorThemePreset {
  id: ColorThemeName
  label: string
  /** 预览色块：取暗色主题下的强调色，明暗背景下都清晰 */
  swatch: string
}

/**
 * 界面配色预设。实际的 CSS 变量定义在 index.css 的 `[data-color-theme='…']` 里，
 * 这里只放选择界面需要的元数据；新增配色时两边都要加一项。
 */
export const COLOR_THEMES: ColorThemePreset[] = [
  { id: 'neutral', label: '中性', swatch: 'oklch(0.55 0 0)' },
  { id: 'blue', label: '蓝', swatch: 'oklch(0.74 0.13 258)' },
  { id: 'cyan', label: '青', swatch: 'oklch(0.78 0.09 195)' },
  { id: 'green', label: '绿', swatch: 'oklch(0.76 0.11 152)' },
  { id: 'violet', label: '紫', swatch: 'oklch(0.74 0.14 293)' },
  { id: 'rose', label: '玫红', swatch: 'oklch(0.76 0.14 12)' },
  { id: 'orange', label: '橙', swatch: 'oklch(0.79 0.13 55)' },
  { id: 'amber', label: '金', swatch: 'oklch(0.8 0.12 85)' }
]
