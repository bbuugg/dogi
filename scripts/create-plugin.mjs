#!/usr/bin/env node
/**
 * 插件骨架脚手架：交互式创建一个 webview 模式插件目录。
 *
 * 用法：
 *   node scripts/create-plugin.mjs <插件id>
 *
 * 示例：
 *   node scripts/create-plugin.mjs api-client
 *   node scripts/create-plugin.mjs my-tool
 *
 * 生成的插件结构：
 *   plugins/<id>/
 *   ├── .gitignore
 *   ├── package.json
 *   ├── tsconfig.json
 *   ├── vite.config.ts
 *   ├── index.html
 *   ├── plugin.json
 *   ├── main.js
 *   ├── preload.cjs
 *   └── src/
 *       ├── main.tsx
 *       ├── App.tsx
 *       ├── index.css
 *       └── vite-env.d.ts
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

// ---- 参数解析 ----
const args = process.argv.slice(2)
if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
  console.log('用法: node scripts/create-plugin.mjs <插件id>')
  console.log('示例: node scripts/create-plugin.mjs api-client')
  process.exit(0)
}

const pluginId = args[0]

// 验证插件 id：英文小写 + 数字 + 连字符
if (!/^[a-z][a-z0-9-]*$/.test(pluginId)) {
  console.error(`错误：插件 id 必须以小写字母开头，只含小写字母、数字和连字符（如 "api-client"）`)
  process.exit(1)
}

const PLUGINS_DIR = resolve(import.meta.dirname, '..', 'plugins')
const PLUGIN_DIR = join(PLUGINS_DIR, pluginId)

// 检查是否已存在
if (existsSync(PLUGIN_DIR)) {
  console.error(`错误：插件目录已存在：${PLUGIN_DIR}`)
  process.exit(1)
}

// ---- 文件内容模板 ----
const files = {}

files['.gitignore'] = `node_modules/
dist/
`

files['package.json'] = `{
  "name": "opsdesk-plugin-${pluginId}",
  "version": "0.1.0",
  "description": "${pluginId} 插件",
  "author": "OpsDesk",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "antd": "^6.6.4",
    "lucide-react": "^1.45.0",
    "react": "^19.3.0",
    "react-dom": "^19.3.0"
  },
  "devDependencies": {
    "@tailwindcss/vite": "^4.3.3",
    "@types/react": "^19.3.0",
    "@types/react-dom": "^19.3.0",
    "@vitejs/plugin-react": "^6.1.1",
    "tailwindcss": "^4.3.3",
    "typescript": "^7.0.2",
    "vite": "^8.3.0"
  }
}
`

files['tsconfig.json'] = `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "paths": {
      "@/*": ["./src/*"]
    }
  },
  "include": ["src", "vite.config.ts"]
}
`

files['vite.config.ts'] = `import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  root: '.',
  base: './',
  resolve: {
    alias: {
      '@': resolve(import.meta.dirname, 'src')
    }
  },
  plugins: [react(), tailwindcss()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 1700,
    rolldownOptions: {
      output: {
        manualChunks(id) {
          const i = id.replace(/\\\\/g, '/')
          if (!i.includes('/node_modules/')) return undefined
          if (i.includes('/react-dom/') || i.includes('/react/')) return 'vendor-react'
          if (
            i.includes('/@ant-design/') ||
            i.includes('/@rc-component/') ||
            i.includes('/antd/') ||
            /\\/rc-[^/]+\\//.test(i)
          )
            return 'vendor-antd'
          return undefined
        }
      }
    }
  }
})
`

files['index.html'] = `<!doctype html>
<html lang="zh-CN" class="h-full">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'self'; script-src 'self'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data:"
    />
    <title>${pluginId}</title>
  </head>
  <body class="h-full">
    <div id="root" class="h-full"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`

files['plugin.json'] = `{
  "id": "${pluginId}",
  "name": "${pluginId}",
  "version": "0.1.0",
  "description": "${pluginId} 插件",
  "author": "OpsDesk",
  "icon": "🔌",
  "main": "main.js",
  "permissions": ["http", "storage"],
  "renderer": {
    "type": "webview",
    "entry": "dist/index.html",
    "preload": "preload.cjs"
  }
}
`

files['main.js'] = `/**
 * ${pluginId} 插件主进程入口。
 * HTTP 与持久化能力由宿主（主进程 PluginHost）直接提供，
 * 因此此处无需注册额外 handler，仅做加载日志。
 */
export function activate(api) {
  api.log('${pluginId} 主进程已加载')
  return { name: '${pluginId}' }
}
`

files['preload.cjs'] = `/**
 * 插件 webview preload 脚本（CJS）。
 *
 * 由宿主主进程在创建 webview 时通过 webPreferences.preload 指定。
 * pluginId 通过 webview src URL 的查询参数 ?pluginId=xxx 传递。
 *
 * 职责：
 * 1. 同步初始化 <html> 的亮暗 class（从 prefers-color-scheme 推断，避免首屏闪烁）
 * 2. 监听宿主推送的主题信息（亮暗 + 主题色 + 自定义色），实时同步到 <html>
 * 3. 通过 contextBridge 向 webview 的 window 注入 window.api（http/storage/invoke）
 */
;(() => {
  const { contextBridge, ipcRenderer } = require('electron')

  // 从 URL 查询参数中解析 pluginId
  const params = new URLSearchParams(location.search)
  const pluginId = params.get('pluginId') || ''

  if (!pluginId) {
    console.error('[plugin-preload] 未收到 pluginId')
    return
  }

  // ---- 主题同步 ----
  const CUSTOM_ACCENT_VARS = [
    '--custom-primary-light',
    '--custom-primary-foreground-light',
    '--custom-ring-light',
    '--custom-primary-dark',
    '--custom-ring-dark'
  ]

  function applyTheme(data) {
    const el = document.documentElement
    if (!el) return
    el.classList.toggle('dark', !!data.isDark)
    if (!data.colorTheme || data.colorTheme === 'neutral') {
      el.removeAttribute('data-color-theme')
    } else {
      el.setAttribute('data-color-theme', data.colorTheme)
    }
    if (data.customVars) {
      for (const [key, value] of Object.entries(data.customVars)) {
        el.style.setProperty(key, value)
      }
    } else {
      for (const key of CUSTOM_ACCENT_VARS) {
        el.style.removeProperty(key)
      }
    }
  }

  // 首屏同步初始化亮暗主题（从 prefers-color-scheme 推断，
  // 宿主主进程的 nativeTheme.themeSource 会影响 webview 的 prefers-color-scheme）。
  // 这一步在 DOM 解析阶段就完成，避免 React 首屏渲染时 CSS 变量不对。
  // 之后宿主通过 IPC 推送精确主题（含主题色/自定义色）会覆盖此初始值。
  // preload 执行时 <html> 可能尚未解析（document.documentElement 为 null），
  // 用 DOMContentLoaded 或 readystatechange 确保 DOM 就绪后再操作。
  function initTheme() {
    const mql = window.matchMedia('(prefers-color-scheme: dark)')
    applyTheme({ isDark: mql.matches, colorTheme: 'neutral' })
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initTheme, { once: true })
  } else {
    initTheme()
  }

  // 接收宿主推送的主题信息（首次加载 + 变更时都会发送）
  ipcRenderer.on('plugin:theme', (_e, data) => {
    applyTheme(data)
  })

  // ---- 暴露宿主 API ----
  contextBridge.exposeInMainWorld('api', {
    id: pluginId,
    http: (req) => ipcRenderer.invoke('plugin:http', pluginId, req),
    storage: {
      get: (key) => ipcRenderer.invoke('plugin:storageGet', pluginId, key),
      set: (key, value) => ipcRenderer.invoke('plugin:storageSet', pluginId, key, value)
    },
    invoke: (name, ...args) => ipcRenderer.invoke('plugin:invoke', pluginId, name, args),
    onThemeChange: (cb) => {
      const handler = (_e, data) => cb(data)
      ipcRenderer.on('plugin:theme', handler)
      return () => ipcRenderer.removeListener('plugin:theme', handler)
    }
  })
})()
`

files['src/vite-env.d.ts'] = `/// <reference types="vite/client" />

/** 宿主通过 webview preload 注入到 window 的 API（由 contextBridge.exposeInMainWorld 暴露） */
interface PluginHostApi {
  /** 当前插件 id（由宿主在加载 webview 时注入） */
  id: string
  /** 发起 HTTP 请求（需插件声明 http 权限） */
  http: (req: {
    method: string
    url: string
    headers?: Record<string, string>
    body?: string
    rejectUnauthorized?: boolean
    proxy?: string
    timeoutMs?: number
  }) => Promise<{
    ok: boolean
    status: number
    statusText: string
    headers: Record<string, string>
    body: string
    timeMs: number
    error?: string
  }>
  storage: {
    get: (key: string) => Promise<unknown>
    set: (key: string, value: unknown) => Promise<void>
  }
  /** 调用插件自有主进程 handler */
  invoke: (name: string, ...args: unknown[]) => Promise<unknown>
  /** 订阅主题变更（宿主推送亮暗 + 主题色变更时回调） */
  onThemeChange?: (cb: () => void) => (() => void) | void
}

interface Window {
  api: PluginHostApi
}
`

files['src/main.tsx'] = `import React from 'react'
import { createRoot } from 'react-dom/client'
import { ConfigProvider, theme as antdTheme, App as AntdApp } from 'antd'
import type { ThemeConfig } from 'antd'
import zhCN from 'antd/locale/zh_CN'
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
  return a === 255 ? \`rgb(\${r}, \${g}, \${b})\` : \`rgba(\${r}, \${g}, \${b}, \${(a / 255).toFixed(3)})\`
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

  return {
    algorithm: isDark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
    token: tokens,
    components: {
      Modal: { contentPadding: '20px' }
    } as ThemeConfig['components']
  }
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
        <AntdApp className="h-full">
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
`

files['src/App.tsx'] = `import { useState } from 'react'
import { Button, Input, Space, Typography } from 'antd'
import { Send } from 'lucide-react'

const { Title, Text } = Typography

export default function App() {
  const api = window.api
  const [url, setUrl] = useState('https://httpbin.org/get')
  const [response, setResponse] = useState('')
  const [loading, setLoading] = useState(false)

  const send = async () => {
    setLoading(true)
    setResponse('')
    try {
      const res = await api.http({
        method: 'GET',
        url,
        timeoutMs: 15000
      })
      if (res.error) {
        setResponse('错误：' + res.error)
      } else {
        try {
          setResponse(JSON.stringify(JSON.parse(res.body), null, 2))
        } catch {
          setResponse(res.body)
        }
      }
    } catch (e) {
      setResponse('请求失败：' + (e instanceof Error ? e.message : String(e)))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex h-full flex-col bg-background p-6 text-foreground">
      <Title level={4} className="!mb-4">
        🔌 ${pluginId} 插件
      </Title>

      <Space.Compact className="mb-4 w-full">
        <Input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="请求地址"
          className="flex-1 font-mono text-xs"
        />
        <Button
          type="primary"
          loading={loading}
          onClick={send}
          icon={<Send className="size-3.5" />}
        >
          发送
        </Button>
      </Space.Compact>

      <div className="min-h-0 flex-1 overflow-auto rounded-md border border-border bg-muted/30 p-4">
        {response ? (
          <pre className="whitespace-pre-wrap break-all font-mono text-xs text-foreground">
            {response}
          </pre>
        ) : (
          <Text type="secondary" className="text-xs">
            点击「发送」测试请求。宿主 API 通过 window.api 暴露：http / storage / invoke。
          </Text>
        )}
      </div>
    </div>
  )
}
`

files['src/index.css'] = `@import 'tailwindcss';

@custom-variant dark (&:is(.dark *));

@layer base {
  * {
    @apply border-border outline-ring/50;
  }

  body {
    @apply bg-background text-foreground;
    font-family: 'Segoe UI', 'Microsoft YaHei', system-ui, -apple-system, sans-serif;
    overflow: hidden;
  }

  button {
    @apply cursor-pointer;
  }

  html {
    @apply font-sans;
    user-select: none;
    -webkit-user-select: none;
  }

  input,
  textarea,
  [contenteditable='true'] {
    user-select: text;
    -webkit-user-select: text;
  }
}

@utility no-scrollbar {
  scrollbar-width: none !important;
  -ms-overflow-style: none !important;
  &::-webkit-scrollbar {
    display: none !important;
  }
}

* {
  scrollbar-width: thin;
  scrollbar-color: rgba(0, 0, 0, 0.2) transparent;
}

::-webkit-scrollbar {
  width: 0.5rem;
  height: 0.5rem;
}

::-webkit-scrollbar-thumb {
  background: rgba(0, 0, 0, 0.2);
  border-radius: 3px;

  &:hover {
    background: rgba(0, 0, 0, 0.3);
  }
}

::-webkit-scrollbar-track {
  background: transparent;
}

@theme inline {
  --font-heading: var(--font-sans);
  --font-sans: 'Segoe UI', 'Microsoft YaHei', system-ui, sans-serif;
  --color-sidebar-ring: var(--sidebar-ring);
  --color-sidebar-border: var(--sidebar-border);
  --color-sidebar-accent-foreground: var(--sidebar-accent-foreground);
  --color-sidebar-accent: var(--sidebar-accent);
  --color-sidebar-primary-foreground: var(--sidebar-primary-foreground);
  --color-sidebar-primary: var(--sidebar-primary);
  --color-sidebar-foreground: var(--sidebar-foreground);
  --color-sidebar: var(--sidebar);
  --color-chart-5: var(--chart-5);
  --color-chart-4: var(--chart-4);
  --color-chart-3: var(--chart-3);
  --color-chart-2: var(--chart-2);
  --color-chart-1: var(--chart-1);
  --color-ring: var(--ring);
  --color-input: var(--input);
  --color-border: var(--border);
  --color-destructive: var(--destructive);
  --color-accent-foreground: var(--accent-foreground);
  --color-accent: var(--accent);
  --color-muted-foreground: var(--muted-foreground);
  --color-muted: var(--muted);
  --color-secondary-foreground: var(--secondary-foreground);
  --color-secondary: var(--secondary);
  --color-primary-foreground: var(--primary-foreground);
  --color-primary: var(--primary);
  --color-popover-foreground: var(--popover-foreground);
  --color-popover: var(--popover);
  --color-card-foreground: var(--card-foreground);
  --color-card: var(--card);
  --color-foreground: var(--foreground);
  --color-background: var(--background);
  --radius-sm: calc(var(--radius) * 0.6);
  --radius-md: calc(var(--radius) * 0.8);
  --radius-lg: var(--radius);
  --radius-xl: calc(var(--radius) * 1.4);
  --radius-2xl: calc(var(--radius) * 1.8);
  --radius-3xl: calc(var(--radius) * 2.2);
  --radius-4xl: calc(var(--radius) * 2.6);
}

:root {
  color-scheme: light dark;
  --background: oklch(1 0 0);
  --foreground: oklch(0.145 0 0);
  --card: oklch(1 0 0);
  --card-foreground: oklch(0.145 0 0);
  --popover: oklch(1 0 0);
  --popover-foreground: oklch(0.145 0 0);
  --primary: oklch(0.205 0 0);
  --primary-foreground: oklch(0.985 0 0);
  --secondary: oklch(0.97 0 0);
  --secondary-foreground: oklch(0.205 0 0);
  --muted: oklch(0.97 0 0);
  --muted-foreground: oklch(0.556 0 0);
  --accent: oklch(0.97 0 0);
  --accent-foreground: oklch(0.205 0 0);
  --destructive: oklch(0.577 0.245 27.325);
  --border: oklch(0.922 0 0);
  --input: oklch(0.922 0 0);
  --ring: oklch(0.708 0 0);
  --chart-1: oklch(0.87 0 0);
  --chart-2: oklch(0.556 0 0);
  --chart-3: oklch(0.439 0 0);
  --chart-4: oklch(0.371 0 0);
  --chart-5: oklch(0.269 0 0);
  --radius: 0.625rem;
  --sidebar: oklch(0.985 0 0);
  --sidebar-foreground: oklch(0.145 0 0);
  --sidebar-primary: oklch(0.205 0 0);
  --sidebar-primary-foreground: oklch(0.985 0 0);
  --sidebar-accent: oklch(0.97 0 0);
  --sidebar-accent-foreground: oklch(0.205 0 0);
  --sidebar-border: oklch(0.922 0 0);
  --sidebar-ring: oklch(0.708 0 0);
}

.dark {
  --background: oklch(0.145 0 0);
  --foreground: oklch(0.985 0 0);
  --card: oklch(0.205 0 0);
  --card-foreground: oklch(0.985 0 0);
  --popover: oklch(0.205 0 0);
  --popover-foreground: oklch(0.985 0 0);
  --primary: oklch(0.922 0 0);
  --primary-foreground: oklch(0.205 0 0);
  --secondary: oklch(0.269 0 0);
  --secondary-foreground: oklch(0.985 0 0);
  --muted: oklch(0.269 0 0);
  --muted-foreground: oklch(0.708 0 0);
  --accent: oklch(0.269 0 0);
  --accent-foreground: oklch(0.985 0 0);
  --destructive: oklch(0.704 0.191 22.216);
  --border: oklch(1 0 0 / 10%);
  --input: oklch(1 0 0 / 15%);
  --ring: oklch(0.556 0 0);
  --chart-1: oklch(0.87 0 0);
  --chart-2: oklch(0.556 0 0);
  --chart-3: oklch(0.439 0 0);
  --chart-4: oklch(0.371 0 0);
  --chart-5: oklch(0.269 0 0);
  --sidebar: oklch(0.205 0 0);
  --sidebar-foreground: oklch(0.985 0 0);
  --sidebar-primary: oklch(0.488 0.243 264.376);
  --sidebar-primary-foreground: oklch(0.985 0 0);
  --sidebar-accent: oklch(0.269 0 0);
  --sidebar-accent-foreground: oklch(0.985 0 0);
  --sidebar-border: oklch(1 0 0 / 10%);
  --sidebar-ring: oklch(0.556 0 0);
}

:root[data-color-theme='blue'] {
  --primary: oklch(0.52 0.19 258);
  --primary-foreground: oklch(0.985 0.01 258);
  --ring: oklch(0.63 0.16 258);
}

.dark[data-color-theme='blue'] {
  --primary: oklch(0.74 0.13 258);
  --primary-foreground: oklch(0.2 0.04 258);
  --ring: oklch(0.58 0.12 258);
}

:root[data-color-theme='cyan'] {
  --primary: oklch(0.55 0.11 195);
  --primary-foreground: oklch(0.985 0.01 195);
  --ring: oklch(0.66 0.1 195);
}

.dark[data-color-theme='cyan'] {
  --primary: oklch(0.78 0.09 195);
  --primary-foreground: oklch(0.21 0.03 195);
  --ring: oklch(0.6 0.08 195);
}

:root[data-color-theme='green'] {
  --primary: oklch(0.53 0.13 152);
  --primary-foreground: oklch(0.985 0.01 152);
  --ring: oklch(0.64 0.11 152);
}

.dark[data-color-theme='green'] {
  --primary: oklch(0.76 0.11 152);
  --primary-foreground: oklch(0.2 0.03 152);
  --ring: oklch(0.58 0.09 152);
}

:root[data-color-theme='violet'] {
  --primary: oklch(0.51 0.2 293);
  --primary-foreground: oklch(0.985 0.01 293);
  --ring: oklch(0.62 0.17 293);
}

.dark[data-color-theme='violet'] {
  --primary: oklch(0.74 0.14 293);
  --primary-foreground: oklch(0.21 0.04 293);
  --ring: oklch(0.58 0.12 293);
}

:root[data-color-theme='rose'] {
  --primary: oklch(0.55 0.2 12);
  --primary-foreground: oklch(0.985 0.01 12);
  --ring: oklch(0.65 0.17 12);
}

.dark[data-color-theme='rose'] {
  --primary: oklch(0.76 0.14 12);
  --primary-foreground: oklch(0.21 0.04 12);
  --ring: oklch(0.6 0.12 12);
}

:root[data-color-theme='orange'] {
  --primary: oklch(0.6 0.16 48);
  --primary-foreground: oklch(0.985 0.01 48);
  --ring: oklch(0.7 0.13 48);
}

.dark[data-color-theme='orange'] {
  --primary: oklch(0.79 0.13 55);
  --primary-foreground: oklch(0.23 0.04 48);
  --ring: oklch(0.62 0.11 48);
}

:root[data-color-theme='amber'] {
  --primary: oklch(0.64 0.14 85);
  --primary-foreground: oklch(0.22 0.03 85);
  --ring: oklch(0.72 0.12 85);
}

.dark[data-color-theme='amber'] {
  --primary: oklch(0.8 0.12 85);
  --primary-foreground: oklch(0.24 0.03 85);
  --ring: oklch(0.64 0.1 85);
}

:root[data-color-theme='custom'] {
  --primary: var(--custom-primary-light);
  --primary-foreground: var(--custom-primary-foreground-light);
  --ring: var(--custom-ring-light);
}

.dark[data-color-theme='custom'] {
  --primary: var(--custom-primary-dark);
  --primary-foreground: oklch(0.2 0.01 0);
  --ring: var(--custom-ring-dark);
}
`

// ---- 写入文件 ----
async function createPlugin() {
  console.log(`\n创建插件骨架：${pluginId}`)
  console.log(`目录：${PLUGIN_DIR}\n`)

  for (const [relPath, content] of Object.entries(files)) {
    const fullPath = join(PLUGIN_DIR, relPath)
    const dir = join(fullPath, '..')
    await mkdir(dir, { recursive: true })
    await writeFile(fullPath, content, 'utf-8')
    console.log(`  ✓ ${relPath}`)
  }

  console.log(`\n插件骨架已创建！接下来：`)
  console.log(`  1. cd plugins/${pluginId}`)
  console.log(`  2. npm install`)
  console.log(`  3. npm run build`)
  console.log(`  4. 重启宿主应用（npm run dev）即可在活动栏看到插件\n`)
}

await createPlugin()
