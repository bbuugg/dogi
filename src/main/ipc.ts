import { ipcMain, nativeTheme, dialog, type BrowserWindow } from 'electron'
import { promises as fs } from 'node:fs'
import { sessionManager } from './services/sessions'
import { storage } from './services/storage'
import { aiService } from './services/ai'
import { mcpManager } from './services/mcp'
import { app } from 'electron'
import type {
  AiChatMessage,
  AiModelConfig,
  AiStreamEvent,
  McpServerConfig,
  Preferences,
  SshProfile
} from '@shared/types'

function broadcast(win: () => BrowserWindow | null, channel: string, payload: unknown): void {
  const window = win()
  if (!window || window.isDestroyed()) return
  window.webContents.send(channel, payload)
}

export function registerIpc(win: () => BrowserWindow | null): void {
  // ---------- 终端事件转发 ----------
  sessionManager.on('data', (payload: { sessionId: string; data: string }) =>
    broadcast(win, 'terminal:data', payload)
  )
  sessionManager.on('exit', (payload: { sessionId: string; exitCode: number }) =>
    broadcast(win, 'terminal:exit', payload)
  )
  sessionManager.on('created', (info) => broadcast(win, 'terminal:created', info))
  sessionManager.on('closed', (payload: { sessionId: string }) =>
    broadcast(win, 'terminal:closed', payload)
  )

  // ---------- 终端控制 ----------
  ipcMain.handle('terminal:list', () => sessionManager.list())
  ipcMain.handle(
    'terminal:createLocal',
    (_e, cols?: number, rows?: number) => sessionManager.createLocal(cols, rows)
  )
  ipcMain.handle('terminal:createSsh', (_e, profileId: string, cols?: number, rows?: number) => {
    const profile = storage.getSshProfile(profileId)
    if (!profile) throw new Error(`SSH 配置不存在: ${profileId}`)
    return sessionManager.createSsh(profile, cols, rows)
  })
  ipcMain.handle('terminal:write', (_e, sessionId: string, data: string) =>
    sessionManager.write(sessionId, data)
  )
  ipcMain.handle('terminal:resize', (_e, sessionId: string, cols: number, rows: number) =>
    sessionManager.resize(sessionId, cols, rows)
  )
  ipcMain.handle('terminal:kill', (_e, sessionId: string) => sessionManager.kill(sessionId))
  ipcMain.handle('terminal:recentOutput', (_e, sessionId: string, maxChars?: number) =>
    sessionManager.recentOutput(sessionId, maxChars)
  )

  // ---------- ZMODEM 文件传输（rz/sz） ----------
  // 打开系统文件选择框，读取选中文件并返回字节，供渲染端作为上传内容
  ipcMain.handle('zmodem:pickFiles', async () => {
    const window = win()
    if (!window || window.isDestroyed()) return []
    const { canceled, filePaths } = await dialog.showOpenDialog(window, {
      properties: ['openFile', 'multiSelections']
    })
    if (canceled || !filePaths.length) return []
    const files: { name: string; size: number; data: Buffer }[] = []
    for (const p of filePaths) {
      const buf = await fs.readFile(p)
      const name = p.split(/[\\/]/).pop() || 'file'
      files.push({ name, size: buf.length, data: buf })
    }
    return files
  })
  // 弹出保存对话框并把字节写入磁盘，返回最终路径
  ipcMain.handle('zmodem:saveFile', async (_e, name: string, data: Uint8Array) => {
    const window = win()
    if (!window || window.isDestroyed()) return null
    const { canceled, filePath } = await dialog.showSaveDialog(window, { defaultPath: name })
    if (canceled || !filePath) return null
    await fs.writeFile(filePath, Buffer.from(data))
    return filePath
  })

  // ---------- SSH 配置 CRUD ----------
  ipcMain.handle('ssh:list', () => storage.listSshProfiles())
  ipcMain.handle('ssh:save', (_e, profile: SshProfile) => storage.saveSshProfile(profile))
  ipcMain.handle('ssh:delete', (_e, id: string) => storage.deleteSshProfile(id))

  // ---------- AI 模型配置 ----------
  ipcMain.handle('ai:config:list', () => storage.listAiConfigs())
  ipcMain.handle('ai:config:save', (_e, config: AiModelConfig) => storage.saveAiConfig(config))
  ipcMain.handle('ai:config:delete', (_e, id: string) => storage.deleteAiConfig(id))
  ipcMain.handle('ai:settings:get', () => storage.getAiSettings())
  ipcMain.handle(
    'ai:settings:save',
    (_e, settings: Partial<import('@shared/types').AiSettings>) => storage.saveAiSettings(settings)
  )
  ipcMain.handle('ai:chat', async (_e, history: AiChatMessage[]) => aiService.chat(history))
  ipcMain.handle('ai:abort', (_e, requestId: string) => aiService.abort(requestId))
  aiService.on('chat-event', (requestId: string, event: AiStreamEvent) =>
    broadcast(win, 'ai:chat-event', { requestId, event })
  )

  // ---------- AI 命令执行确认（确认模式） ----------
  aiService.setConfirmRequester((req) => broadcast(win, 'ai:confirm', req))
  ipcMain.handle(
    'ai:confirm:resolve',
    (_e, payload: { id: string; approved: boolean }) =>
      aiService.resolveConfirm(payload.id, payload.approved)
  )

  // ---------- MCP ----------
  ipcMain.handle('mcp:list', () => mcpManager.listStatus())
  ipcMain.handle('mcp:save', (_e, server: McpServerConfig) => {
    const next = storage.saveMcpServer(server)
    mcpManager.invalidate(server.id)
    return next
  })
  ipcMain.handle('mcp:delete', (_e, id: string) => {
    const next = storage.deleteMcpServer(id)
    mcpManager.invalidate(id)
    return next
  })
  ipcMain.handle('mcp:tools', async () => {
    const { infos, errors } = await mcpManager.buildToolset()
    return { tools: infos, errors }
  })

  // ---------- 偏好（主题等） ----------
  ipcMain.handle('prefs:get', () => storage.getPreferences())
  ipcMain.handle('prefs:save', (_e, patch: Partial<Preferences>) => {
    const prefs = storage.savePreferences(patch)
    // themeSource 变化会同步影响 renderer 的 prefers-color-scheme
    nativeTheme.themeSource = prefs.theme
    return prefs
  })

  // ---------- 应用信息 ----------
  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    electron: process.versions.electron ?? '',
    node: process.versions.node ?? '',
    platform: process.platform
  }))
}
