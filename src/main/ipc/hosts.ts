import { dialog, ipcMain } from 'electron'
import { readFile } from 'node:fs/promises'
import { connectWithJumps } from '../services/ssh/connect'
import { tunnelManager } from '../services/ssh/tunnels'
import { hostLogger } from '../services/log/logger'
import { storage } from '../services/storage'
import type { SshProfile } from '@shared/types'

/** 私钥文件大小上限（远超这个体积多半是选错了文件） */
const MAX_KEY_FILE_BYTES = 512 * 1024

/**
 * 「测试连接」用：编辑旧配置且密钥/密码留空时，用已存配置里解密后的凭据补全，
 * 与「保存时不填则保留原值」的行为一致，避免不重贴密钥就没法测试。
 */
function withEffectiveSecrets(draft: SshProfile): SshProfile {
  if (!draft.id) return draft
  const stored = storage.getSshProfile(draft.id)
  if (!stored) return draft
  const merged = { ...draft }
  if (!merged.password) merged.password = stored.password
  if (!merged.privateKey) merged.privateKey = stored.privateKey
  if (!merged.passphrase) merged.passphrase = stored.passphrase
  return merged
}

/**
 * 主机（SSH / 本地终端配置）IPC：连接配置与分组的 CRUD 与排序。
 *
 * 纯粹是 storage 的转发层 —— 会话创建见 terminal.ts，这里只管"配置长什么样"；
 * 「测试连接」/私钥导入/主机指纹是配置编辑期的辅助能力，也放在这里。
 */
export function registerHostsIpc(): void {
  ipcMain.handle('ssh:list', () => storage.listSshProfiles())
  ipcMain.handle('ssh:save', (_e, profile: SshProfile) => storage.saveSshProfile(profile))
  ipcMain.handle('ssh:delete', (_e, id: string) => {
    // 联动：引用该主机的隧道先停掉（否则运行中的隧道悬在已删除的配置上）
    tunnelManager.stopByProfile(id)
    return storage.deleteSshProfile(id)
  })
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
  // 测试连接：连上即断（TOFU 记录照常生效），返回耗时供界面展示
  ipcMain.handle('ssh:test', async (_e, draft: SshProfile) => {
    if (draft.kind === 'local') throw new Error('本地终端无需测试连接')
    if (draft.useMosh && draft.jumpProfileId) {
      throw new Error('Mosh 与跳板机不能同时使用，请先调整配置再测试')
    }
    const started = Date.now()
    const connected = await connectWithJumps(withEffectiveSecrets(draft), { purpose: 'test' })
    connected.dispose()
    return { ms: Date.now() - started }
  })
  // 私钥导入：用户取消返回 null（渲染端静默处理）
  ipcMain.handle('ssh:readKeyFile', async () => {
    const result = await dialog.showOpenDialog({
      title: '选择私钥文件',
      properties: ['openFile'],
      filters: [
        { name: '私钥文件', extensions: ['pem', 'key', 'ppk'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    })
    const filePath = result.filePaths[0]
    if (result.canceled || !filePath) return null
    const content = await readFile(filePath)
    if (content.length > MAX_KEY_FILE_BYTES) {
      throw new Error('私钥文件超过 512KB，似乎选错了文件')
    }
    return { path: filePath, content: content.toString('utf8') }
  })
  ipcMain.handle('ssh:knownHosts:list', () => storage.listSshKnownHosts())
  ipcMain.handle('ssh:knownHosts:reset', (_e, host: string, port: number) => {
    hostLogger.info('ssh', `已重置主机指纹：${host}:${port}（下次连接重新记录）`)
    return storage.deleteSshKnownHost(host, port)
  })
}
