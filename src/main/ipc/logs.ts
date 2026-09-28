/**
 * 主机日志（SSH / 隧道 / SFTP 等主机相关事件，数据源在 services/log/logger.ts）。
 *
 * 只做「读取 + 订阅转发」：记录的产生在各业务服务里（connect / tunnels / sftp …），
 * 这里把 logger 的 'entry' 事件广播给渲染端，并提供全量读取 / 清空 / 打开日志目录。
 * ⚠️ 必须在 registerIpc 里**最先注册**：隧道自启等注册期就触发的日志也要能推到渲染端。
 */
import { ipcMain } from 'electron'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { hostLogger } from '../services/log/logger'
import { openFileManagerAt } from '../services/system/opener'
import type { IpcContext } from './shared'
import type { HostLogEntry, OpenResult } from '@shared/types'

export function registerLogsIpc(ctx: IpcContext): void {
  // 新记录实时推给渲染端（logger 是全局单例，只在这里订阅一次）
  hostLogger.on('entry', (entry: HostLogEntry) => ctx.broadcast('logs:entry', entry))

  ipcMain.handle('logs:list', () => hostLogger.list())

  ipcMain.handle('logs:clear', async () => {
    hostLogger.clear()
    // 终端命令的会话原始记录（logs/sessions/）也是主机日志的一部分，一并清掉；
    // 尽力而为：仍在写入的会话文件在 Windows 上可能删不掉，跳过即可（新会话会重建目录）
    const dir = hostLogger.directory()
    if (dir) {
      await rm(join(dir, 'sessions'), { recursive: true, force: true }).catch(() => {})
    }
  })

  /** 在文件管理器中打开日志目录（init 退化时没有目录可开） */
  ipcMain.handle('logs:reveal', (): OpenResult => {
    const dir = hostLogger.directory()
    if (!dir) return { ok: false, error: '日志目录不可用' }
    return openFileManagerAt(dir)
  })
}
