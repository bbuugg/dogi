import { ipcMain, nativeTheme, dialog, shell, type BrowserWindow } from 'electron'
import { promises as fs } from 'node:fs'
import { sessionManager } from './services/sessions'
import { monitorService } from './services/monitor'
import { storage } from './services/storage'
import { detectShells } from './services/shells'
import { aiService } from './services/ai'
import { mcpManager } from './services/mcp'
import { registerShortcuts, unregisterShortcuts } from './shortcuts'
import { pluginHost } from './services/plugins'
import { app } from 'electron'
import type {
  AiModelConfig,
  AiStreamEvent,
  McpServerConfig,
  Preferences,
  ServerMetrics,
  ScriptEntry,
  SessionInfo,
  SshConnectProgress,
  SshProfile
} from '@shared/types'

function broadcast(win: () => BrowserWindow | null, channel: string, payload: unknown): void {
  const window = win()
  if (!window || window.isDestroyed()) return
  window.webContents.send(channel, payload)
}

/**
 * 安全地用系统默认程序打开外部链接。仅放行常见协议（http(s)/mailto/file），
 * 其余协议（ssh://、telnet://、vscode:// 等）系统往往没有注册的处理程序，
 * 直接 shell.openExternal 会弹出"需要新应用才能打开此链接"的对话框。
 */
export function openExternalSafe(url: string): void {
  if (/^(https?:\/\/|mailto:|file:\/\/)/i.test(url)) {
    void shell.openExternal(url)
  } else {
    console.warn('[openExternal] 忽略未支持协议的链接:', url)
  }
}

export function registerIpc(win: () => BrowserWindow | null): void {
  // ---------- 终端事件转发 ----------
  sessionManager.on('data', (payload: { sessionId: string; data: string }) =>
    broadcast(win, 'terminal:data', payload)
  )
  sessionManager.on('exit', (payload: { sessionId: string; exitCode: number }) =>
    broadcast(win, 'terminal:exit', payload)
  )
  //主机阶段（解析/握手/认证/打开 shell/重试），渲染端据此显示连接进度
  sessionManager.on('status', (payload: SshConnectProgress) =>
    broadcast(win, 'terminal:status', payload)
  )
  sessionManager.on('created', (info: SessionInfo) => {
    broadcast(win, 'terminal:created', info)
    // 连接到主机后即在后台采集指标；采集不到数据的主机会自动停止（前端不显示）
    monitorService.start(info.id)
  })
  sessionManager.on('closed', (payload: { sessionId: string }) =>
    broadcast(win, 'terminal:closed', payload)
  )
  // 会话关闭时停止其监控，避免泄漏
  sessionManager.on('closed', ({ sessionId }: { sessionId: string }) =>
    monitorService.stop(sessionId)
  )

  // ---------- 服务器监控（自动采集 CPU/内存/流量等，仅推送有效数据） ----------
  monitorService.on(
    'data',
    (payload: { sessionId: string; metrics: ServerMetrics }) =>
      broadcast(win, 'monitor:data', payload)
  )
  // 采集间隔：启动时沿用上次的设置；渲染端调整后立即对现有会话生效并持久化
  monitorService.setInterval(storage.getPreferences().monitorInterval)
  ipcMain.handle('monitor:setInterval', (_e, ms: number) => {
    monitorService.setInterval(ms)
    return storage.savePreferences({ monitorInterval: monitorService.getInterval() })
  })

  // ---------- 终端控制 ----------
  ipcMain.handle('terminal:list', () => sessionManager.list())
  ipcMain.handle('terminal:listShells', () => detectShells())
  ipcMain.handle(
    'terminal:createLocal',
    (_e, cols?: number, rows?: number, shellId?: string) => {
      // 未显式指定 shell 时使用偏好设置中的默认本地终端（'default' = 平台默认）
      const id = shellId || storage.getPreferences().localShell
      return sessionManager.createLocal(cols, rows, id)
    }
  )
  ipcMain.handle('terminal:createSsh', (_e, profileId: string, cols?: number, rows?: number) => {
    const profile = storage.getSshProfile(profileId)
    if (!profile) throw new Error(`SSH 配置不存在: ${profileId}`)
    return sessionManager.createSsh(profile, cols, rows)
  })
  // 按主机类型创建会话：local 启动本地命令，ssh 建立远程连接（统一入口）
  ipcMain.handle(
    'terminal:createFromProfile',
    (_e, profileId: string, cols?: number, rows?: number) => {
      const profile = storage.getSshProfile(profileId)
      if (!profile) throw new Error(`主机配置不存在: ${profileId}`)
      return profile.kind === 'local'
        ? sessionManager.createLocalHost(profile, cols, rows)
        : sessionManager.createSsh(profile, cols, rows)
    }
  )
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
  // 等待会话就绪后写入内容（如：连上主机后自动执行保存的脚本），未就绪则丢弃
  ipcMain.handle('terminal:runScript', (_e, sessionId: string, data: string) =>
    sessionManager.writeWhenReady(sessionId, data)
  )

  // ---------- ZMODEM 文件传输（rz/sz） ----------
  // 打开系统文件选择框，读取选中文件并返回字节，供渲染端作为上传内容
  ipcMain.handle('zmodem:pickFiles', async () => {
    const window = win()
    if (!window || window.isDestroyed()) return []
    // Windows 上模态文件框可能被主窗口遮住（electron#32857），临时置顶并聚焦，
    // 确保选择框显示在最前、鼠标可正常交互
    if (window.isMinimized()) window.restore()
    window.setAlwaysOnTop(true)
    window.focus()
    let result: Electron.OpenDialogReturnValue
    try {
      result = await dialog.showOpenDialog(window, {
        properties: ['openFile', 'multiSelections']
      })
    } finally {
      window.setAlwaysOnTop(false)
    }
    const { canceled, filePaths } = result
    if (canceled || !filePaths.length) return []
    const files: { name: string; size: number; data: Buffer }[] = []
    for (const p of filePaths) {
      const buf = await fs.readFile(p)
      const name = p.split(/[\\/]/).pop() || 'file'
      files.push({ name, size: buf.length, data: buf })
    }
    return files
  })
  // 弹出保存对话框，返回用户选定的完整路径（先选位置再下载）；取消返回 null
  ipcMain.handle('zmodem:askSavePath', async (_e, defaultName: string) => {
    const window = win()
    if (!window || window.isDestroyed()) return null
    if (window.isMinimized()) window.restore()
    window.setAlwaysOnTop(true)
    window.focus()
    let result: Electron.SaveDialogReturnValue
    try {
      result = await dialog.showSaveDialog(window, { defaultPath: defaultName })
    } finally {
      window.setAlwaysOnTop(false)
    }
    const { canceled, filePath } = result
    if (canceled || !filePath) return null
    return filePath
  })
  // 将字节写入指定路径并保存，返回实际保存路径（失败返回 null）
  ipcMain.handle('zmodem:saveFileTo', async (_e, filePath: string, data: Uint8Array) => {
    try {
      await fs.writeFile(filePath, Buffer.from(data))
      return filePath
    } catch (e) {
      console.error('zmodem save failed', e)
      return null
    }
  })

  // ---------- SSH 配置 CRUD ----------
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

  // ---------- 用户脚本 CRUD ----------
  ipcMain.handle('scripts:list', () => storage.listScripts())
  ipcMain.handle('scripts:save', (_e, entry: ScriptEntry) => storage.saveScript(entry))
  ipcMain.handle('scripts:delete', (_e, id: string) => storage.deleteScript(id))

  // ---------- AI 模型配置 ----------
  ipcMain.handle('ai:config:list', () => storage.listAiConfigs())
  ipcMain.handle('ai:config:save', (_e, config: AiModelConfig) => storage.saveAiConfig(config))
  ipcMain.handle('ai:config:delete', (_e, id: string) => storage.deleteAiConfig(id))
  ipcMain.handle('ai:settings:get', () => storage.getAiSettings())
  ipcMain.handle(
    'ai:settings:save',
    (_e, settings: Partial<import('@shared/types').AiSettings>) => storage.saveAiSettings(settings)
  )
  ipcMain.handle('ai:chat', async (_e, req: import('@shared/types').AiChatRequest) =>
    aiService.chat(req)
  )
  ipcMain.handle('ai:abort', (_e, requestId: string) => aiService.abort(requestId))
  aiService.on('chat-event', (requestId: string, event: AiStreamEvent) =>
    broadcast(win, 'ai:chat-event', { requestId, event })
  )

  // ---------- AI 命令执行确认（确认模式） ----------
  aiService.setConfirmSink({
    request: (req) => broadcast(win, 'ai:confirm', req),
    // 确认已有结论（超时 / 中止等非用户路径），渲染端据此移除卡片
    resolved: (id) => broadcast(win, 'ai:confirm-resolved', { id })
  })
  ipcMain.handle(
    'ai:confirm:resolve',
    (_e, payload: { id: string; approved: boolean }) =>
      aiService.resolveConfirm(payload.id, payload.approved)
  )
  // 会话关闭：销毁其 AI 助手实例（每个终端会话一个独立实例）
  sessionManager.on('closed', ({ sessionId }: { sessionId: string }) =>
    aiService.disposeSession(sessionId)
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

  // ---------- 快捷键（全局，系统级） ----------
  ipcMain.handle('shortcuts:get', () => storage.getShortcuts())
  ipcMain.handle('shortcuts:save', (_e, shortcuts: import('@shared/types').ShortcutConfig[]) => {
    const next = storage.saveShortcuts(shortcuts)
    // 立即重新注册系统级快捷键，使改动即时生效
    registerShortcuts(win, () => next)
    return next
  })
  // 录制模式：注销/恢复系统级快捷键，避免已注册快捷键抢先触发、干扰录制
  ipcMain.handle('shortcuts:capture', (_e, enabled: boolean) => {
    if (enabled) unregisterShortcuts()
    else registerShortcuts(win, () => storage.getShortcuts())
  })

  // ---------- 插件（运行时加载外部插件） ----------
  ipcMain.handle('plugins:list', () => pluginHost.listManifests())
  // 启用/禁用（持久化）、卸载、从文件安装：均返回最新插件列表供渲染端刷新
  ipcMain.handle('plugins:setEnabled', (_e, id: string, enabled: boolean) =>
    pluginHost.setEnabled(id, enabled)
  )
  ipcMain.handle('plugins:uninstall', (_e, id: string) => pluginHost.uninstall(id))
  ipcMain.handle('plugins:install', (_e, sourcePath: string) => pluginHost.install(sourcePath))
  // 重新加载插件（不传 id 表示全部），返回最新插件列表
  ipcMain.handle('plugins:reload', (_e, id?: string) => pluginHost.reload(id))
  // 文件/目录选择对话框（用于「从文件安装」）
  ipcMain.handle('dialog:open', (_e, options) => {
    const browserWindow = win()
    return browserWindow
      ? dialog.showOpenDialog(browserWindow, options)
      : dialog.showOpenDialog(options)
  })
  ipcMain.handle('plugin:rendererCode', (_e, id: string) => pluginHost.getRendererCode(id))
  ipcMain.handle('plugin:invoke', (_e, pluginId: string, name: string, args: unknown[]) =>
    pluginHost.invoke(pluginId, name, args ?? [])
  )
  ipcMain.handle('plugin:http', (_e, pluginId: string, req) => pluginHost.http(pluginId, req))
  ipcMain.handle('plugin:storageGet', (_e, pluginId: string, key: string) =>
    pluginHost.storageGet(pluginId, key)
  )
  ipcMain.handle('plugin:storageSet', (_e, pluginId: string, key: string, value) => {
    pluginHost.storageSet(pluginId, key, value)
  })

  // ---------- 窗口控制（自定义标题栏） ----------
  ipcMain.handle('window:minimize', () => win()?.minimize())
  ipcMain.handle('window:toggleMaximize', () => {
    const window = win()
    if (!window) return
    if (window.isMaximized()) window.unmaximize()
    else window.maximize()
  })
  ipcMain.handle('window:close', () => win()?.close())
  ipcMain.handle('window:isMaximized', () => win()?.isMaximized() ?? false)

  // ---------- 应用信息 ----------
  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    electron: process.versions.electron ?? '',
    node: process.versions.node ?? '',
    platform: process.platform
  }))
  // 终端中点击链接时使用：按安全协议过滤后由系统默认程序打开
  ipcMain.handle('app:openExternal', (_e, url: string) => openExternalSafe(url))
}
