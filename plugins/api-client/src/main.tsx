import type { ThemeConfig } from 'antd'
import { App as AntdApp, ConfigProvider, theme as antdTheme } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './index.css'

/** oklch() 等 CSS 颜色 → rgba（antd 的色板生成器只认 sRGB） */
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

/**
 * 读取当前 <html> 上的 CSS 变量，映射成 antd token。
 * 与宿主 AntdProvider 的 readAppTokens() 保持一致的映射关系。
 */
function readThemeConfig(): ThemeConfig {
    const isDark = document.documentElement.classList.contains('dark')
    const style = getComputedStyle(document.documentElement)
    const read = (name: string) => cssColorToRgba(style.getPropertyValue(name).trim())

    const radius = parseFloat(style.getPropertyValue('--radius')) || 0.625
    const tokens: ThemeConfig['token'] = {
        fontFamily: 'inherit',
        borderRadius: Math.round(radius * 16)
    }

    // 与宿主 AntdProvider 完全一致的 token 映射
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

    const config: ThemeConfig = {
        algorithm: isDark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
        token: tokens,
        components: {
            // 与宿主一致：弹窗内边距统一
            Modal: { contentPadding: '20px' }
        } as ThemeConfig['components']
    }

    return config
}

let root: ReturnType<typeof createRoot> | null = null

function renderApp() {
    const container = document.getElementById('root')!
    const config = readThemeConfig()
    if (!root) {
        root = createRoot(container)
    }
    root.render(
        <React.StrictMode>
            <ConfigProvider locale={zhCN} theme={config}>
                <AntdApp className='h-full'>
                    <App />
                </AntdApp>
            </ConfigProvider>
        </React.StrictMode>
    )
}

renderApp()

// 宿主主题变更时重新渲染（preload 通过 window.api.onThemeChange 通知）
// CSS 变量已由 preload 同步到 <html>，这里用 requestAnimationFrame 确保浏览器
// 已经完成样式重计算后再读取 getComputedStyle（避免竞态）
window.api?.onThemeChange?.(() => {
    requestAnimationFrame(() => {
        renderApp()
    })
})
