import type { ITheme } from '@xterm/xterm'
import type { TerminalThemeName } from '@shared/types'

export interface TerminalThemePreset {
  id: TerminalThemeName
  label: string
  /** 预览用色块（背景 + 四个前景色） */
  swatch: [string, string, string, string, string]
  /** auto 预设无自己的配色，按应用明暗解析 */
  theme?: ITheme
}

/**
 * 每个配色必须提供完整的 16 色（8 基础 + 8 亮色）：
 * 只给 8 色时 xterm 会用内置默认值补亮色，htop / btop / vim 等 TUI 大量使用
 * 亮色（90-97、100-107），会与当前配色不搭，观感接近黑白。
 */

const DARK: ITheme = {
  background: '#0f1117',
  foreground: '#e6e6e6',
  cursor: '#4daafc',
  cursorAccent: '#0f1117',
  selectionBackground: 'rgba(77, 170, 252, 0.3)',
  black: '#1d1f21',
  red: '#cc6666',
  green: '#b5bd68',
  yellow: '#f0c674',
  blue: '#81a2be',
  magenta: '#c9c9c9',
  cyan: '#8abeb7',
  white: '#c5c8c6',
  brightBlack: '#7a8288',
  brightRed: '#e88388',
  brightGreen: '#ccd484',
  brightYellow: '#f8dc90',
  brightBlue: '#9dc0dd',
  brightMagenta: '#e6e6e6',
  brightCyan: '#a9e2db',
  brightWhite: '#ffffff'
}

const LIGHT: ITheme = {
  background: '#ffffff',
  foreground: '#24292f',
  cursor: '#0969da',
  cursorAccent: '#ffffff',
  selectionBackground: 'rgba(9, 105, 218, 0.25)',
  black: '#24292f',
  red: '#cf222e',
  green: '#116329',
  yellow: '#9a6700',
  blue: '#0969da',
  magenta: '#8250df',
  cyan: '#1b7c83',
  white: '#6e7781',
  brightBlack: '#57606a',
  brightRed: '#e5534b',
  brightGreen: '#1a7f37',
  brightYellow: '#bf8700',
  brightBlue: '#218bff',
  brightMagenta: '#a371f7',
  brightCyan: '#3192aa',
  brightWhite: '#8c959f'
}

const SOLARIZED_DARK: ITheme = {
  background: '#002b36',
  foreground: '#93a1a1',
  cursor: '#93a1a1',
  cursorAccent: '#002b36',
  selectionBackground: 'rgba(7, 54, 66, 0.9)',
  black: '#073642',
  red: '#dc322f',
  green: '#859900',
  yellow: '#b58900',
  blue: '#268bd2',
  magenta: '#d33682',
  cyan: '#2aa198',
  white: '#eee8d5',
  brightBlack: '#002b36',
  brightRed: '#cb4b16',
  brightGreen: '#586e75',
  brightYellow: '#657b83',
  brightBlue: '#839496',
  brightMagenta: '#6c71c4',
  brightCyan: '#93a1a1',
  brightWhite: '#fdf6e3'
}

const DRACULA: ITheme = {
  background: '#282a36',
  foreground: '#f8f8f2',
  cursor: '#f8f8f2',
  cursorAccent: '#282a36',
  selectionBackground: 'rgba(68, 71, 90, 0.9)',
  black: '#21222c',
  red: '#ff5555',
  green: '#50fa7b',
  yellow: '#f1fa8c',
  blue: '#bd93f9',
  magenta: '#ff79c6',
  cyan: '#8be9fd',
  white: '#f8f8f2',
  brightBlack: '#6272a4',
  brightRed: '#ff6e6e',
  brightGreen: '#69ff94',
  brightYellow: '#ffffa5',
  brightBlue: '#d6acff',
  brightMagenta: '#ff92df',
  brightCyan: '#a4ffff',
  brightWhite: '#ffffff'
}

const NORD: ITheme = {
  background: '#2e3440',
  foreground: '#d8dee9',
  cursor: '#d8dee9',
  cursorAccent: '#2e3440',
  selectionBackground: 'rgba(59, 66, 82, 0.9)',
  black: '#3b4252',
  red: '#bf616a',
  green: '#a3be8c',
  yellow: '#ebcb8b',
  blue: '#81a1c1',
  magenta: '#b48ead',
  cyan: '#88c0d0',
  white: '#e5e9f0',
  brightBlack: '#4c566a',
  brightRed: '#bf616a',
  brightGreen: '#a3be8c',
  brightYellow: '#ebcb8b',
  brightBlue: '#81a1c1',
  brightMagenta: '#b48ead',
  brightCyan: '#8fbcbb',
  brightWhite: '#eceff4'
}

export const TERMINAL_THEMES: TerminalThemePreset[] = [
  {
    id: 'auto',
    label: '跟随应用主题',
    swatch: ['#0f1117', '#cc6666', '#b5bd68', '#81a2be', '#ffffff']
  },
  {
    id: 'dark',
    label: '深色',
    swatch: [DARK.background!, '#cc6666', '#b5bd68', '#81a2be', '#c5c8c6'],
    theme: DARK
  },
  {
    id: 'light',
    label: '浅色',
    swatch: [LIGHT.background!, '#cf222e', '#116329', '#0969da', '#6e7781'],
    theme: LIGHT
  },
  {
    id: 'solarized-dark',
    label: 'Solarized Dark',
    swatch: [SOLARIZED_DARK.background!, '#dc322f', '#859900', '#268bd2', '#eee8d5'],
    theme: SOLARIZED_DARK
  },
  {
    id: 'dracula',
    label: 'Dracula',
    swatch: [DRACULA.background!, '#ff5555', '#50fa7b', '#bd93f9', '#f8f8f2'],
    theme: DRACULA
  },
  {
    id: 'nord',
    label: 'Nord',
    swatch: [NORD.background!, '#bf616a', '#a3be8c', '#81a1c1', '#e5e9f0'],
    theme: NORD
  }
]

/** 解析出实际的 xterm 配色：auto 跟随应用明暗主题 */
export function resolveTerminalTheme(name: TerminalThemeName, isDark: boolean): ITheme {
  if (name === 'auto') return isDark ? DARK : LIGHT
  const preset = TERMINAL_THEMES.find((t) => t.id === name)
  return preset?.theme ?? (isDark ? DARK : LIGHT)
}
