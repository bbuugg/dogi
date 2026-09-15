import { globalShortcut, type BrowserWindow } from 'electron'
import type { AppShortcutAction } from '@shared/types'

/**
 * 全局快捷键映射。主进程注册后，触发时向渲染进程广播对应动作，
 * 由渲染进程根据当前 UI 状态执行（打开设置、新建会话等）。
 * 注册为系统级快捷键：即使窗口未聚焦也能触发。
 */
const SHORTCUTS: Record<string, AppShortcutAction> = {
  'Ctrl+Alt+S': 'open-settings',
  'Ctrl+Alt+T': 'new-session',
  'CmdOrCtrl+Shift+P': 'open-script-palette'
}

export function registerShortcuts(win: () => BrowserWindow | null): void {
  for (const [accelerator, action] of Object.entries(SHORTCUTS)) {
    const registered = globalShortcut.register(accelerator, () => {
      win()?.webContents.send('app:shortcut', action)
    })
    if (!registered) {
      console.warn(`[shortcuts] 注册失败（可能被系统占用）: ${accelerator}`)
    }
  }
}

export function unregisterShortcuts(): void {
  globalShortcut.unregisterAll()
}
