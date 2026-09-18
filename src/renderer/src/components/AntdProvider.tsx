import { useMemo } from 'react'
import type { ReactNode } from 'react'
import { ConfigProvider, theme as antdTheme } from 'antd'
import type { ThemeConfig } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import { useAppStore } from '@/stores/app-store'
import { useIsDarkTheme } from '@/lib/theme'

/**
 * antd 的色板生成器只认 sRGB，而应用的主题变量是 oklch()，
 * 这里借用 canvas 让浏览器把任意 CSS 颜色归一化回 rgba。
 */
function cssColorToRgba(value: string): string | null {
  if (!value) return null
  const canvas = document.createElement('canvas')
  canvas.width = 1
  canvas.height = 1
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.fillStyle = '#000'
  ctx.fillStyle = value
  ctx.fillRect(0, 0, 1, 1)
  const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data
  return a === 255 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${(a / 255).toFixed(3)})`
}

/** 读取应用当前的 CSS 变量，映射成 antd token —— 让 antd 组件跟随界面配色 */
function readAppTokens(): ThemeConfig['token'] {
  const style = getComputedStyle(document.documentElement)
  const read = (name: string) => cssColorToRgba(style.getPropertyValue(name).trim())

  const radius = parseFloat(style.getPropertyValue('--radius')) || 0.625
  const tokens: ThemeConfig['token'] = {
    fontFamily: 'inherit',
    borderRadius: Math.round(radius * 16)
  }

  const map: Record<string, string> = {
    colorPrimary: '--primary',
    colorText: '--foreground',
    colorTextSecondary: '--muted-foreground',
    colorBgElevated: '--popover',
    colorBgContainer: '--background',
    colorBorder: '--border',
    colorBorderSecondary: '--border',
    colorError: '--destructive'
  }
  for (const [token, cssVar] of Object.entries(map)) {
    const value = read(cssVar)
    if (value) (tokens as Record<string, string>)[token] = value
  }

  return tokens
}

/**
 * antd 弹窗面板（.ant-modal-container）的默认内边距是 `20px 24px`（上下 20 / 左右 24），
 * 这里统一成四边一致。contentPadding 属于 antd 的内部组件 token（未收进 Modal 的公开
 * token 类型），但运行时会与默认值合并生效，所以下面做一次断言把它传进去。
 */
const MODAL_PADDING = '20px'

/**
 * antd 全局配置：
 * - 跟随应用明暗主题（themeSource 决定 prefers-color-scheme）与「主题色」偏好；
 * - 弹窗内边距统一；
 * - 通过 holderRender 让 message / notification / Modal.confirm 这类
 *   渲染在独立 root 里的静态方法也能拿到同一套主题与中文语言包。
 */
export function AntdProvider({ children }: { children: ReactNode }) {
  const isDark = useIsDarkTheme()
  const colorTheme = useAppStore((s) => s.preferences.colorTheme)

  const themeConfig = useMemo<ThemeConfig>(
    () => ({
      algorithm: isDark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
      token: readAppTokens(),
      components: {
        Modal: { contentPadding: MODAL_PADDING }
      } as ThemeConfig['components']
    }),
    // colorTheme 变化会改写 html 的 data-color-theme（同步生效），据此重新取值
    [isDark, colorTheme]
  )

  // 静态方法挂在独立的 React root 上，拿不到 ConfigProvider 上下文，这里统一注入
  ConfigProvider.config({
    holderRender: (nodes) => (
      <ConfigProvider locale={zhCN} theme={themeConfig}>
        {nodes}
      </ConfigProvider>
    )
  })

  return (
    <ConfigProvider locale={zhCN} theme={themeConfig}>
      {children}
    </ConfigProvider>
  )
}