import { ipcMain } from 'electron'
import { storage } from '../services/storage'
import type { SshProfile } from '@shared/types'

/**
 * 主机（SSH / 本地终端配置）IPC：连接配置与分组的 CRUD 与排序。
 *
 * 纯粹是 storage 的转发层 —— 会话创建见 terminal.ts，这里只管"配置长什么样"。
 */
export function registerHostsIpc(): void {
  ipcMain.handle('ssh:list', () => storage.listSshProfiles())
  ipcMain.handle('ssh:save', (_e, profile: SshProfile) => storage.saveSshProfile(profile))
  ipcMain.handle('ssh:delete', (_e, id: string) => storage.deleteSshProfile(id))
  ipcMain.handle(
    'ssh:arrange',
    (
      _e,
      payload: { groupIds: string[]; profiles: Array<{ id: string; groupId?: string }> }
    ) => storage.arrangeSsh(payload)
  )
  ipcMain.handle('ssh:groups:list', () => storage.listSshGroups())
  ipcMain.handle('ssh:groups:save', (_e, input: { id?: string; name: string; color?: string | null }) =>
    storage.saveSshGroup(input)
  )
  ipcMain.handle('ssh:groups:delete', (_e, id: string, deleteProfiles?: boolean) =>
    storage.deleteSshGroup(id, deleteProfiles)
  )
}
