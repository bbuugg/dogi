import { app, BrowserWindow, dialog, ipcMain, nativeTheme } from 'electron'
import { storage } from '../services/storage'
import { BUILTIN_PLAYWRIGHT_ID, mcpManager } from '../services/ai/mcp'
import { isAppInForeground, showSystemNotice, type SystemNotice } from '../services/system/notify'
import type { Preferences, ShortcutConfig } from '@shared/types'
import { openExternalSafe, type IpcContext } from './shared'

/** 等待「渲染端已落盘」应答的回调集合（见 requestRendererFlush） */
const flushWaiters = new Set<() => void>()

/**
 * 退出前请求渲染端把「进行中的状态」立刻落盘。
 *
 * 为什么需要：Agent 一轮对话可能跑几十步、持续很久，而落盘是节流的（见渲染端的
 * persistConversationThrottled）—— 直接退出会丢掉最后几秒的产出。
 * 渲染端应答 `app:flushDone` 或超时后 resolve：**绝不阻塞退出**。
 */
export function requestRendererFlush(win: BrowserWindow | null, timeoutMs = 1200): Promise<void> {
  if (!win || win.isDestroyed()) return Promise.resolve()
  return new Promise((resolve) => {
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      flushWaiters.delete(finish)
      resolve()
    }
    flushWaiters.add(finish)
    win.webContents.send('app:flush')
    setTimeout(finish, timeoutMs)
  })
}

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
    const before = storage.getPreferences()
    const prefs = storage.savePreferences(patch)
    // themeSource 变化会同步影响 renderer 的 prefers-color-scheme
    nativeTheme.themeSource = prefs.theme
    // 浏览器来源决定内置 Playwright MCP 的启动参数（--browser / --executable-path）：
    // 变了就断开重连，否则缓存里的旧参数会一直用到下次重启
    if (patch.browserChannel !== undefined && patch.browserChannel !== before.browserChannel) {
      mcpManager.invalidate(BUILTIN_PLAYWRIGHT_ID)
    }
    // 浏览器工具换成 / 换离「系统浏览器」：内置 Playwright MCP 的启停跟着变。
    // 离开时断开（别把独立进程留在后台跑），改成 system 时下一轮对话自然会新连。
    if (
      patch.browserToolMode !== undefined &&
      patch.browserToolMode !== before.browserToolMode
    ) {
      mcpManager.invalidate(BUILTIN_PLAYWRIGHT_ID)
    }
    // 广播给所有渲染端窗口（含设置窗口自身），让偏好跨窗口即时生效
    ctx.broadcast('prefs:updated', prefs)
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
    platform: process.platform,
    // 用户主目录：新建工作区 / 克隆仓库的默认落点（「选目录」对话框的初值）
    homeDir: app.getPath('home')
  }))
  // 终端中点击链接时使用：按安全协议过滤后由系统默认程序打开
  ipcMain.handle('app:openExternal', (_e, url: string) => openExternalSafe(url))

  // ---------- 系统通知 ----------
  // 渲染端负责凑内容（它才知道会话标题与回复正文），**是否真弹由主进程决定**：
  // 应用在前台时用户自己看得到，不打扰；通知开关也读偏好（渲染端不必关心）。
  ipcMain.handle('app:notify', (_e, notice: SystemNotice) => {
    // 打日志（而不是静默 return）：「通知怎么没弹」只能从主进程这两行看出来
    if (!storage.getPreferences().notifyOnAgentFinish) {
      return false
    }
    if (isAppInForeground(ctx.win())) {
      return false
    }
    const shown = showSystemNotice(notice)
    return shown
  })

  // 渲染端应答「进行中的状态已落盘」（见 requestRendererFlush）
  ipcMain.handle('app:flushDone', () => {
    for (const finish of [...flushWaiters]) finish()
  })

  // ---------- 首帧主题（同步取一次） ----------
  // preload 在页面脚本之前用它把明暗 class 与配色主题直接落到 html 上，
  // 否则首帧会先按 index.html 的硬编码主题渲染、再跳成用户设置的样子。
  // 同步 IPC 会阻塞渲染进程，但只在窗口加载前调一次、返回的又是几个小字符串。
  ipcMain.on('prefs:themeSync', (event) => {
    const prefs = storage.getPreferences()
    event.returnValue = {
      theme: prefs.theme,
      colorTheme: prefs.colorTheme,
      customColor: prefs.customColor
    }
  })
}
