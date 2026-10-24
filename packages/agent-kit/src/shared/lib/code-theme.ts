/**
 * 代码高亮主题：把当前配色主题的 `--syntax-*` 编译成 **Shiki / Monaco 的主题对象**。
 *
 * ## 为什么要从 CSS 读
 *
 * 7 套内置主题的代码色写在 `themes.css` 里，自定义主题的写在注入的 `<style>` 里 ——
 * 两边都是「CSS 是唯一真源」。这里不做第二份色表：建一个 1px 探针，挂上与 `<html>`
 * 相同的 `data-theme`（暗色再加 `.dark`），`getComputedStyle` 读回 8 个语法色与
 * 前景 / 底色，再用 `toHex()` 换算（`oklch()` / 半透明都能落到同一个 hex 空间）。
 *
 * ## 什么时候重算
 *
 * `applyColorTheme()` 每次落盘都会 bump 一个 revision（`useColorTheme` 里的
 * `subscribeColorTheme` / `getColorThemeRevision`）。`useThemeRevision()` 用
 * `useSyncExternalStore` 订阅它，`useCodeTheme()` 在 revision 变化时重算两组主题 ——
 * **换主题、改自定义色、切明暗都会刷新**，已挂载的 Monaco / Shiki 不用重新打开。
 *
 * ## 为什么 Shiki 的 `pre` 背景不重要
 *
 * `code-block.tsx` 的 `<pre>` 被强制 `bg-background!`（与卡片同底），所以 Shiki 的
 * `editor.background` 只影响 Monaco；两边给同一个值是为了「切过去不闪一下」。
 */
import { useMemo, useSyncExternalStore } from 'react'
import type { editor } from 'monaco-editor'
import type { ThemeRegistrationAny, ThemeRegistrationRaw } from 'shiki'
import {
  getColorThemeRevision,
  subscribeColorTheme,
  toHex,
  type ThemeModeKey
} from '@fizz/agent-kit/shared/hooks/useColorTheme'

/** 8 个语法色（与 `tokens.css` 的 `--syntax-*` 一一对应） */
export interface SyntaxColors {
  keyword: string
  string: string
  number: string
  comment: string
  function: string
  type: string
  variable: string
  punctuation: string
}

/** 语法色 + 代码块的前景 / 底色（Shiki / Monaco 都要这两个） */
export interface CodeSurface extends SyntaxColors {
  foreground: string
  background: string
}

const SYNTAX_VARS: Record<keyof SyntaxColors, string> = {
  keyword: '--syntax-keyword',
  string: '--syntax-string',
  number: '--syntax-number',
  comment: '--syntax-comment',
  function: '--syntax-function',
  type: '--syntax-type',
  variable: '--syntax-variable',
  punctuation: '--syntax-punctuation'
}

/** 读不到 DOM（测试 / SSR）时的兜底：GitHub 亮暗，与 `tokens.css` 的默认值同源 */
const FALLBACK: Record<ThemeModeKey, CodeSurface> = {
  light: {
    keyword: '#d73a49',
    string: '#032f62',
    number: '#005cc5',
    comment: '#6a737d',
    function: '#6f42c1',
    type: '#22863a',
    variable: '#e36209',
    punctuation: '#24292e',
    foreground: '#1f2328',
    background: '#ffffff'
  },
  dark: {
    keyword: '#ff7b72',
    string: '#a5d6ff',
    number: '#79c0ff',
    comment: '#8b949e',
    function: '#d2a8ff',
    type: '#ffa657',
    variable: '#ffa657',
    punctuation: '#c9d1d9',
    foreground: '#e6edf3',
    background: '#0a0a0a'
  }
}

/**
 * 读当前主题（`<html data-theme>`）在某个明暗档的语法色与前景 / 底色。
 *
 * 探针**只读不写 `<html>`**：临时修改根节点属性会让整个界面闪一下。
 */
export function readSyntaxColors(mode: ThemeModeKey): CodeSurface {
  const fallback = FALLBACK[mode]
  if (typeof document === 'undefined' || !document.body) return fallback

  const probe = document.createElement('div')
  const themeId = document.documentElement.dataset.theme
  if (themeId) probe.setAttribute('data-theme', themeId)
  if (mode === 'dark') probe.className = 'dark'
  probe.style.cssText =
    'position:absolute;top:0;left:-9999px;width:1px;height:1px;opacity:0;pointer-events:none'
  document.body.appendChild(probe)
  const computed = getComputedStyle(probe)
  const raw: Record<keyof SyntaxColors, string> = {} as Record<keyof SyntaxColors, string>
  for (const [key, varName] of Object.entries(SYNTAX_VARS) as Array<
    [keyof SyntaxColors, string]
  >) {
    raw[key] = computed.getPropertyValue(varName).trim()
  }
  const rawForeground = computed.getPropertyValue('--foreground').trim()
  const rawBackground = computed.getPropertyValue('--background').trim()
  probe.remove()

  const colors = {} as SyntaxColors
  for (const key of Object.keys(SYNTAX_VARS) as Array<keyof SyntaxColors>) {
    colors[key] = toHex(raw[key] || fallback[key], fallback[key])
  }
  return {
    ...colors,
    // 半透明的底（配了背景图 / 视频时 `buildStyle()` 会发 rgba）先合成成不透明，
    // 否则 Monaco 会用它自己的默认底、看起来和大界面不是一块。
    background: toHex(rawBackground || fallback.background, fallback.background),
    foreground: toHex(rawForeground || fallback.foreground, fallback.foreground)
  }
}

/**
 * 主题名后缀：`@streamdown/code` 的高亮器 / token 缓存都以**主题名**为 key，
 * 名字不变的话第二次高亮直接返回旧 token —— 换主题后聊天里的代码块永远停在首次配色。
 * 用颜色指纹而不是递增序号：序号会让模块级缓存按调用次数无限增长。
 */
function colorTag(parts: string[]): string {
  let hash = 0
  for (const part of parts) {
    for (let i = 0; i < part.length; i++) hash = (hash * 31 + part.charCodeAt(i)) | 0
  }
  return (hash >>> 0).toString(36)
}

/**
 * Shiki 主题（Streamdown 按元组顺序取亮暗；名字带颜色指纹，见 `colorTag()`）。
 *
 * `settings` 的顺序有意义 —— 后面的规则覆盖前面的：先给一个兜底前景（保证任何
 * 没命中的 token 也是主题前景色），再逐个 scope 覆盖。
 */
export function buildShikiTheme(
  mode: ThemeModeKey,
  colors: SyntaxColors,
  background: string,
  foreground: string
): ThemeRegistrationRaw {
  return {
    name: `fizz-${mode}-${colorTag([...Object.values(colors), background, foreground])}`,
    type: mode,
    colors: {
      'editor.foreground': foreground,
      'editor.background': background
    },
    settings: [
      { settings: { foreground } },
      {
        scope: ['comment', 'punctuation.definition.comment'],
        settings: { foreground: colors.comment }
      },
      {
        scope: ['string', 'string.quoted', 'string.template'],
        settings: { foreground: colors.string }
      },
      {
        scope: ['constant.numeric', 'constant.language', 'constant.character'],
        settings: { foreground: colors.number }
      },
      {
        scope: ['keyword', 'keyword.control', 'storage', 'storage.type'],
        settings: { foreground: colors.keyword }
      },
      {
        scope: ['entity.name.type', 'support.type', 'entity.name.class'],
        settings: { foreground: colors.type }
      },
      {
        scope: ['entity.name.function', 'support.function', 'meta.function-call'],
        settings: { foreground: colors.function }
      },
      {
        scope: ['variable', 'variable.other', 'meta.object-literal.key', 'support.variable'],
        settings: { foreground: colors.variable }
      },
      {
        scope: ['punctuation', 'meta.brace'],
        settings: { foreground: colors.punctuation }
      }
    ]
  }
}

/** Monaco 的规则只要 `#rrggbb` 去掉 `#` 的六位值 */
const bare = (hex: string): string => hex.replace('#', '')

/**
 * Monaco 主题。
 *
 * `base` 决定内置规则（`vs` / `vs-dark`）+ `inherit: true`，我们只覆盖 8 类 token；
 * 完全不写 `rules` 的话 Monaco 会退回内置色板，主题的代码色就白配了。
 */
export function buildMonacoTheme(
  mode: ThemeModeKey,
  colors: SyntaxColors,
  background: string,
  foreground: string
): editor.IStandaloneThemeData {
  return {
    base: mode === 'dark' ? 'vs-dark' : 'vs',
    inherit: true,
    rules: [
      { token: 'comment', foreground: bare(colors.comment) },
      { token: 'string', foreground: bare(colors.string) },
      { token: 'number', foreground: bare(colors.number) },
      { token: 'keyword', foreground: bare(colors.keyword) },
      { token: 'type', foreground: bare(colors.type) },
      { token: 'function', foreground: bare(colors.function) },
      { token: 'variable', foreground: bare(colors.variable) },
      { token: 'delimiter', foreground: bare(colors.punctuation) }
    ],
    colors: {
      'editor.background': background,
      'editor.foreground': foreground
    }
  }
}

/** 订阅「配色主题变了」的 revision（`applyColorTheme()` 每次落盘都会 bump） */
export function useThemeRevision(): number {
  return useSyncExternalStore(subscribeColorTheme, getColorThemeRevision, getColorThemeRevision)
}

export interface CodeTheme {
  /** [亮, 暗]：Streamdown 的 `shikiTheme` 与 `@streamdown/code` 的 `themes` 都要这对元组 */
  shiki: [ThemeRegistrationAny, ThemeRegistrationAny]
  monaco: {
    light: editor.IStandaloneThemeData
    dark: editor.IStandaloneThemeData
  }
}

/** 当前主题编译出的两套代码高亮主题；主题 / 明暗 / 自定义色变化时自动重算 */
export function useCodeTheme(): CodeTheme {
  const revision = useThemeRevision()
  return useMemo(() => {
    const light = readSyntaxColors('light')
    const dark = readSyntaxColors('dark')
    return {
      shiki: [
        buildShikiTheme('light', light, light.background, light.foreground),
        buildShikiTheme('dark', dark, dark.background, dark.foreground)
      ],
      monaco: {
        light: buildMonacoTheme('light', light, light.background, light.foreground),
        dark: buildMonacoTheme('dark', dark, dark.background, dark.foreground)
      }
    }
    // revision 参与依赖：主题变更没有别的信号，靠它触发重算
  }, [revision])
}
