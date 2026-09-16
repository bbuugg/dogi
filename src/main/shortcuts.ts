import { globalShortcut, type BrowserWindow } from 'electron'
import type { AppShortcutAction, ShortcutConfig } from '@shared/types'

/**
 * 把主窗口带到前台并聚焦：
 * 即使窗口已最小化或隐藏到系统托盘（关闭窗口 = 隐藏），也立即恢复显示并置顶。
 * setAlwaysOnTop 短暂置顶再取消，确保 Windows 上能抢在其它窗口之前浮现。
 */
export function focusWindow(win: () => BrowserWindow | null): void {
  const w = win()
  if (!w || w.isDestroyed()) return
  if (w.isMinimized()) w.restore()
  w.show()
  w.setAlwaysOnTop(true)
  w.focus()
  setTimeout(() => {
    if (!w.isDestroyed()) w.setAlwaysOnTop(false)
  }, 200)
}

/**
 * 注册全局快捷键（系统级：窗口未聚焦 / 最小化 / 托盘隐藏时也能触发）。
 * shortcuts 从存储读取（动作 -> accelerator），空 accelerator 表示禁用该动作。
 * 触发时先聚焦窗口，再向渲染进程广播动作，由渲染端按当前 UI 状态执行。
 */
export function registerShortcuts(
  win: () => BrowserWindow | null,
  getShortcuts: () => ShortcutConfig[]
): void {
  globalShortcut.unregisterAll()
  for (const { action, accelerator } of getShortcuts()) {
    if (!accelerator) continue
    try {
      const registered = globalShortcut.register(accelerator, () => {
        focusWindow(win)
        win()?.webContents.send('app:shortcut', action as AppShortcutAction)
      })
      if (!registered) {
        console.warn(`[shortcuts] 注册失败（可能被系统/其它程序占用）: ${accelerator} -> ${action}`)
      }
    } catch (e) {
      console.warn(`[shortcuts] 注册出错: ${accelerator} -> ${action}`, e)
    }
  }
}

export function unregisterShortcuts(): void {
  globalShortcut.unregisterAll()
}
