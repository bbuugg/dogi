import { BrowserWindow, shell } from 'electron'

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
}

export function createIpcContext(win: () => BrowserWindow | null): IpcContext {
  return {
    win,
    // 广播到**所有**渲染端窗口（主窗口 + 独立设置窗口），否则设置窗口收不到跨窗口同步事件
    // （如 `prefs:updated`，在设置页改了偏好、控件却不刷新）。除主窗口外本项目只有设置窗口是
    // 独立 BrowserWindow，插件视图等都在主窗口内以标签页打开，不会误伤。
    broadcast: (channel, payload) => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) window.webContents.send(channel, payload)
      }
    }
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
