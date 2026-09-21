import { shell, type BrowserWindow } from 'electron'

/**
 * 各 IPC 模块共用的上下文。
 *
 * `win` 用 getter 而不是直接持有 BrowserWindow：注册 IPC 时窗口可能还没创建，
 * 运行中窗口被关闭重建也要拿到最新的那个，否则会往已销毁的对象上发消息。
 */
export interface IpcContext {
  win: () => BrowserWindow | null
  /** 向主窗口单向推送事件（窗口不存在 / 已销毁时静默丢弃） */
  broadcast: (channel: string, payload: unknown) => void
  /**
   * 渲染端首屏就绪（数据加载完 + 主题已应用）时的回调。
   * 由 main/index.ts 注入，用于撤下启动画面并显示主窗口。
   */
  onRendererReady: () => void
}

export function createIpcContext(
  win: () => BrowserWindow | null,
  onRendererReady: () => void = () => {}
): IpcContext {
  return {
    win,
    broadcast: (channel, payload) => {
      const window = win()
      if (!window || window.isDestroyed()) return
      window.webContents.send(channel, payload)
    },
    onRendererReady
  }
}

/**
 * 安全地用系统默认程序打开外部链接。仅放行常见协议（http(s)/mailto/file），
 * 其余协议（ssh://、telnet://、vscode:// 等）系统往往没有注册的处理程序，
 * 直接 shell.openExternal 会弹出"需要新应用才能打开此链接"的对话框。
 */
export function openExternalSafe(url: string): void {
  if (/^(https?:\/\/|mailto:|file:\/\/)/i.test(url)) {
    void shell.openExternal(url)
  } else {
    console.warn('[openExternal] 忽略未支持协议的链接:', url)
  }
}
