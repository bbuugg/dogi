import { app, dialog, ipcMain, nativeTheme } from 'electron'
import { storage } from '../services/storage'
import type { Preferences, ShortcutConfig } from '@shared/types'
import { openExternalSafe, type IpcContext } from './shared'

/**
 * 应用级系统能力 IPC：偏好设置、快捷键、文件选择对话框、窗口控制、应用信息。
 *
 * 这些不属于任何业务功能，是「整个应用」的操作（见 AGENTS.md 的目录分层约定）。
 * 「用系统程序打开目录/IDE」是另一类能力，见 opener.ts。
 */
export function registerSystemIpc(ctx: IpcContext): void {
  // ---------- 偏好（主题等） ----------
  ipcMain.handle('prefs:get', () => storage.getPreferences())
  ipcMain.handle('prefs:save', (_e, patch: Partial<Preferences>) => {
    const prefs = storage.savePreferences(patch)
    // themeSource 变化会同步影响 renderer 的 prefers-color-scheme
    nativeTheme.themeSource = prefs.theme
    return prefs
  })

  // ---------- 快捷键（应用内，仅持久化） ----------
  // 匹配与触发都在渲染端（监听 window 的 keydown），主进程只负责存取配置。
  // 刻意不用 Electron 的 globalShortcut：那是系统级的，会占用全局组合键、和别的程序抢。
  ipcMain.handle('shortcuts:get', () => storage.getShortcuts())
  ipcMain.handle('shortcuts:save', (_e, shortcuts: ShortcutConfig[]) =>
    storage.saveShortcuts(shortcuts)
  )

  // ---------- 文件 / 目录选择对话框（插件安装、选工作区目录等共用） ----------
  ipcMain.handle('dialog:open', (_e, options) => {
    const browserWindow = ctx.win()
    return browserWindow
      ? dialog.showOpenDialog(browserWindow, options)
      : dialog.showOpenDialog(options)
  })

  // ---------- 窗口控制（自定义标题栏） ----------
  ipcMain.handle('window:minimize', () => ctx.win()?.minimize())
  ipcMain.handle('window:toggleMaximize', () => {
    const window = ctx.win()
    if (!window) return
    if (window.isMaximized()) window.unmaximize()
    else window.maximize()
  })
  ipcMain.handle('window:close', () => ctx.win()?.close())
  ipcMain.handle('window:isMaximized', () => ctx.win()?.isMaximized() ?? false)

  // ---------- 应用信息 ----------
  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    electron: process.versions.electron ?? '',
    node: process.versions.node ?? '',
    platform: process.platform
  }))
  // 终端中点击链接时使用：按安全协议过滤后由系统默认程序打开
  ipcMain.handle('app:openExternal', (_e, url: string) => openExternalSafe(url))

  // ---------- 首帧主题（同步取一次） ----------
  // preload 在页面脚本之前用它把明暗 class 与配色主题直接落到 html 上，
  // 否则首帧会先按 index.html 的硬编码主题渲染、再跳成用户设置的样子。
  // 同步 IPC 会阻塞渲染进程，但只在窗口加载前调一次、返回的又是几个小字符串。
  ipcMain.on('prefs:themeSync', (event) => {
    const prefs = storage.getPreferences()
    console.log('[theme] 首帧主题已交给 preload：', prefs.theme, prefs.colorTheme)
    event.returnValue = {
      theme: prefs.theme,
      colorTheme: prefs.colorTheme,
      customColor: prefs.customColor
    }
  })
}
