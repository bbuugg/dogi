/**
 * 系统通知（Windows 通知中心 / macOS 通知中心 / Linux 通知守护进程）。
 *
 * 只在**应用不在前台**时发：窗口不存在、已销毁、隐藏到托盘、最小化、或者只是
 * 失了焦点 —— 都算「用户看不到」，这时通知才有意义。前台判定必须在主进程做
 * （渲染端的 `document.hasFocus()` 在窗口隐藏时的行为不够确定），
 * 渲染端只负责凑通知内容。
 */
import { BrowserWindow, Notification } from 'electron'
import { resolveIconPath } from './icon'

export interface SystemNotice {
  title: string
  body: string
}

/**
 * 应用是否在前台：窗口不存在 / 已销毁 / 不可见（隐藏到托盘）/ 最小化 /
 * 未聚焦，任一条命中都算「不在前台」。
 */
export function isAppInForeground(win: BrowserWindow | null | undefined): boolean {
  if (!win || win.isDestroyed()) return false
  if (!win.isVisible() || win.isMinimized()) return false
  return win.isFocused()
}

/**
 * 弹一条系统通知，并把已有的主窗口拉到前台（点击通知时）。
 * 返回是否真的弹了 —— 系统不支持（少数 Linux 环境）或创建失败时返回 false，
 * 调用方据此决定要不要兜底提示。
 */
export function showSystemNotice(notice: SystemNotice): boolean {
  if (!Notification.isSupported()) {
    console.warn('[notify] 当前系统不支持通知，已跳过：', notice.title)
    return false
  }
  try {
    const focusWindow = (): void => {
      const win = BrowserWindow.getAllWindows()[0]
      if (!win || win.isDestroyed()) return
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    }
    const notification = new Notification({
      title: notice.title,
      body: notice.body,
      icon: resolveIconPath()
    })
    notification.on('click', focusWindow)
    notification.show()
    return true
  } catch (err) {
    // 通知失败（权限被系统拒绝等）不该影响业务，记一笔即可
    console.warn('[notify] 发送通知失败：', err)
    return false
  }
}
