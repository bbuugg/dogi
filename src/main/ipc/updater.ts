import { ipcMain } from 'electron'
import type { AppUpdateStatus } from '@shared/types'
import { requestRendererFlush } from './system'
import {
  cancelDownload,
  checkForUpdates,
  initUpdater,
  quitAndInstall,
  startDownload,
  updaterStatus
} from '../services/updater'
import type { IpcContext } from './shared'

/**
 * 自动更新 IPC（`updater:*`）。
 *
 * 只做三件事：读状态、触发检查、装已下载的更新。
 * 状态机与事件订阅全在 `services/updater.ts`（`autoUpdater` 是全局单例，
 * 订阅只能有一份 —— 见那里的注释）。
 */
export function registerUpdaterIpc(ctx: IpcContext): void {
  // 状态变化推给渲染端（设置页的版本号、启动后的「有新版本」提示都靠它）
  initUpdater((status: AppUpdateStatus) => ctx.broadcast('updater:status', status))

  ipcMain.handle('updater:status', () => updaterStatus())

  // 手动「检查更新」（设置页左下角版本号）。静默检查由主进程自己在启动后触发。
  ipcMain.handle('updater:check', () => checkForUpdates())

  // 用户点击红徽章 / 版本号：开始后台下载已发现的新版本
  ipcMain.handle('updater:download', () => startDownload())

  // 取消正在进行的下载（下载中通知的「取消」按钮）
  ipcMain.handle('updater:cancel', () => cancelDownload())

  // 装更新 = 重启：先让渲染端把进行中的状态落盘（会话 / 会话列表增量），
  // 冲刷完再退出，顺序反了会丢最后一次产出
  ipcMain.handle('updater:install', async () => {
    const status = updaterStatus()
    if (status.state !== 'downloaded') return false
    quitAndInstall(() => requestRendererFlush(ctx.win()))
    return true
  })
}