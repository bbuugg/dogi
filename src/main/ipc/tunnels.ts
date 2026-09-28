import { ipcMain } from 'electron'
import { tunnelManager } from '../services/ssh/tunnels'
import { storage } from '../services/storage'
import type { IpcContext } from './shared'
import type { SshTunnel, SshTunnelRuntime } from '@shared/types'

/**
 * SSH 隧道 IPC：配置 CRUD + 启停；运行态经 ctx.broadcast('tunnels:status') 单向推送。
 */
export function registerTunnelsIpc(ctx: IpcContext): void {
  // 状态变化（启动 / 运行 / 出错 / 停止、连接数变化）统一广播全量运行态
  tunnelManager.on('status', (runtime: SshTunnelRuntime[]) =>
    ctx.broadcast('tunnels:status', runtime)
  )
  // 应用启动后自动拉起 autoStart 隧道（错开启动，失败落在各自状态里）
  void tunnelManager.autoStart()

  ipcMain.handle('tunnels:list', () => ({
    tunnels: storage.listSshTunnels(),
    runtime: tunnelManager.list()
  }))
  ipcMain.handle('tunnels:save', (_e, input: SshTunnel) => {
    const wasRunning = input.id ? tunnelManager.isRunning(input.id) : false
    const tunnels = storage.saveSshTunnel(input)
    // 运行中的隧道被编辑：先停后起，应用新配置
    if (wasRunning && input.id) {
      tunnelManager.stop(input.id, { reason: '配置变更，正在重启' })
      void tunnelManager.start(input.id)
    }
    return { tunnels, runtime: tunnelManager.list() }
  })
  ipcMain.handle('tunnels:delete', (_e, id: string) => {
    tunnelManager.stop(id, { reason: '配置已删除' })
    return { tunnels: storage.deleteSshTunnel(id), runtime: tunnelManager.list() }
  })
  ipcMain.handle('tunnels:start', (_e, id: string) => tunnelManager.start(id))
  ipcMain.handle('tunnels:stop', (_e, id: string) => tunnelManager.stop(id))
}
