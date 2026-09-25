import { app, dialog, ipcMain } from 'electron'
import { isTransferCancelled, sftpService, type SftpProgressPayload } from '../services/sftp/sftp'
import type { SftpTransferResult } from '@shared/types'
import type { IpcContext } from './shared'

/**
 * SFTP IPC：远程文件浏览 / 上传 / 下载 / 管理。
 *
 * 连接由渲染端生成 connId（一个「文件管理」标签一个连接），凭据复用 SSH 主机配置，
 * 渲染端不接触密码。另存为 / 选择文件的系统对话框在这里触发（需要窗口引用），
 * 服务层只负责传输本身；进度与断开事件经 ctx.broadcast 推给渲染端。
 */
export function registerSftpIpc(ctx: IpcContext): void {
  ipcMain.handle('sftp:open', (_e, connId: string, profileId: string) =>
    sftpService.open(connId, profileId)
  )
  ipcMain.handle('sftp:list', (_e, connId: string, path: string) => sftpService.list(connId, path))
  ipcMain.handle('sftp:mkdir', (_e, connId: string, path: string) => sftpService.mkdir(connId, path))
  ipcMain.handle('sftp:rename', (_e, connId: string, from: string, to: string) =>
    sftpService.rename(connId, from, to)
  )
  ipcMain.handle('sftp:remove', (_e, connId: string, path: string) => sftpService.remove(connId, path))

  // 下载：另存为对话框选本地路径 → 服务层流式下载（进度走 'progress' 事件）
  ipcMain.handle(
    'sftp:download',
    async (_e, connId: string, remotePath: string, defaultName: string): Promise<SftpTransferResult> => {
      const window = ctx.win()
      if (!window || window.isDestroyed()) return { ok: false, error: '窗口不可用' }
      const result = await dialog.showSaveDialog(window, { defaultPath: defaultName })
      if (result.canceled || !result.filePath) return { ok: false, canceled: true }
      try {
        await sftpService.downloadTo(connId, remotePath, result.filePath)
        return { ok: true, savedPath: result.filePath }
      } catch (e) {
        if (isTransferCancelled(e)) return { ok: false, canceled: true }
        return { ok: false, error: e instanceof Error ? e.message : String(e) }
      }
    }
  )

  // 上传：选择文件（可多选）→ 并发传到远端目录（多笔传输同时在状态栏任务面板显示）。
  // 单个文件被用户取消（进度条上的取消按钮 → sftp:abortTransfer）时该笔停止，
  // 其余继续；只要有任意一笔被取消就整体按「已取消」回包（count = 已成功数）。
  ipcMain.handle(
    'sftp:upload',
    async (_e, connId: string, remoteDir: string): Promise<SftpTransferResult> => {
      const window = ctx.win()
      if (!window || window.isDestroyed()) return { ok: false, error: '窗口不可用' }
      const result = await dialog.showOpenDialog(window, {
        title: '选择要上传的文件',
        properties: ['openFile', 'multiSelections']
      })
      if (result.canceled || !result.filePaths.length) return { ok: false, canceled: true }
      const settled = await Promise.allSettled(
        result.filePaths.map((localPath) => sftpService.uploadFrom(connId, localPath, remoteDir))
      )
      const done = settled.filter((s) => s.status === 'fulfilled').length
      const rejected = settled.filter(
        (s): s is PromiseRejectedResult => s.status === 'rejected'
      )
      if (rejected.length === 0) return { ok: true, count: done }
      if (rejected.some((s) => isTransferCancelled(s.reason))) {
        return { ok: false, canceled: true, count: done }
      }
      const reason = rejected[0].reason
      return {
        ok: false,
        error: reason instanceof Error ? reason.message : String(reason),
        count: done
      }
    }
  )

  // 下载文件夹：选择本地目录 → 递归下载整个远端目录（目录内每个文件一笔独立传输）。
  ipcMain.handle(
    'sftp:downloadDir',
    async (_e, connId: string, remoteDir: string, defaultName: string): Promise<SftpTransferResult> => {
      const window = ctx.win()
      if (!window || window.isDestroyed()) return { ok: false, error: '窗口不可用' }
      const result = await dialog.showOpenDialog(window, {
        title: `下载文件夹到…（${defaultName}）`,
        properties: ['openDirectory', 'createDirectory']
      })
      if (result.canceled || !result.filePaths.length) return { ok: false, canceled: true }
      try {
        await sftpService.downloadDir(connId, remoteDir, result.filePaths[0])
        return { ok: true }
      } catch (e) {
        if (isTransferCancelled(e)) return { ok: false, canceled: true }
        return { ok: false, error: e instanceof Error ? e.message : String(e) }
      }
    }
  )

  // 远端复制（文件或目录，递归）：to 为完整目标路径（含新名称）。
  ipcMain.handle(
    'sftp:copy',
    async (_e, connId: string, from: string, to: string): Promise<SftpTransferResult> => {
      try {
        await sftpService.copyEntry(connId, from, to)
        return { ok: true }
      } catch (e) {
        if (isTransferCancelled(e)) return { ok: false, canceled: true }
        return { ok: false, error: e instanceof Error ? e.message : String(e) }
      }
    }
  )

  // 远端移动（跨目录）：优先原子 rename，跨文件系统回退为复制 + 删源。
  ipcMain.handle(
    'sftp:move',
    async (_e, connId: string, from: string, to: string): Promise<SftpTransferResult> => {
      try {
        await sftpService.moveEntry(connId, from, to)
        return { ok: true }
      } catch (e) {
        if (isTransferCancelled(e)) return { ok: false, canceled: true }
        return { ok: false, error: e instanceof Error ? e.message : String(e) }
      }
    }
  )

  // 取消一笔进行中的传输（进度条上的取消按钮）
  ipcMain.handle('sftp:abortTransfer', (_e, transferId: string) =>
    sftpService.abortTransfer(transferId)
  )

  ipcMain.handle('sftp:close', (_e, connId: string) => sftpService.close(connId))

  sftpService.on('progress', (payload: SftpProgressPayload) => ctx.broadcast('sftp:progress', payload))
  sftpService.on('closed', (payload: { connId: string }) => ctx.broadcast('sftp:closed', payload))
  // 退出前关掉所有 SFTP 连接，避免进程退出时残留
  app.on('before-quit', () => sftpService.closeAll())
}
