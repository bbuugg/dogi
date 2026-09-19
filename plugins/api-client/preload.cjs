/**
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
  /** 自定义强调色用的内联 CSS 变量名（与宿主 theme.ts 保持一致） */
  const CUSTOM_ACCENT_VARS = [
    '--custom-primary-light',
    '--custom-primary-foreground-light',
    '--custom-ring-light',
    '--custom-primary-dark',
    '--custom-ring-dark'
  ]

  /**
   * 应用主题到 <html>：
   * - isDark: 切换 .dark class
   * - colorTheme: 设置 data-color-theme 属性（neutral 时移除）
   * - customVars: 自定义强调色变量（colorTheme === 'custom' 时有值）
   */
  function applyTheme(data) {
    const el = document.documentElement
    if (!el) return
    // 亮暗
    el.classList.toggle('dark', !!data.isDark)
    // 主题色
    if (!data.colorTheme || data.colorTheme === 'neutral') {
      el.removeAttribute('data-color-theme')
    } else {
      el.setAttribute('data-color-theme', data.colorTheme)
    }
    // 自定义强调色内联变量
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
    /** 订阅主题变更（供插件 React 端响应主题切换） */
    onThemeChange: (cb) => {
      const handler = (_e, data) => cb(data)
      ipcRenderer.on('plugin:theme', handler)
      return () => ipcRenderer.removeListener('plugin:theme', handler)
    }
  })
})()
