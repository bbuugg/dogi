/// <reference types="vite/client" />

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
