import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import type {
  AiChatMessage,
  AiConfirmRequest,
  AiModelConfig,
  AiSettings,
  AiStreamEvent,
  AppInfo,
  AppShortcutAction,
  McpServerConfig,
  McpToolInfo,
  Preferences,
  ScriptEntry,
  ServerMetrics,
  SessionInfo,
  ShellDetectResult,
  SshProfile
} from '@shared/types'

type Unsubscribe = () => void

function subscribe<T extends unknown[]>(
  channel: string,
  callback: (...args: T) => void
): Unsubscribe {
  const handler = (_event: IpcRendererEvent, ...args: T) => callback(...args)
  ipcRenderer.on(channel, handler as never)
  return () => ipcRenderer.removeListener(channel, handler as never)
}

const api = {
  terminal: {
    list: (): Promise<SessionInfo[]> => ipcRenderer.invoke('terminal:list'),
    /** 检测本地可用 shell（含平台默认 id） */
    listShells: (): Promise<ShellDetectResult> => ipcRenderer.invoke('terminal:listShells'),
    createLocal: (cols?: number, rows?: number, shellId?: string): Promise<SessionInfo> =>
      ipcRenderer.invoke('terminal:createLocal', cols, rows, shellId),
    createSsh: (profileId: string, cols?: number, rows?: number): Promise<SessionInfo> =>
      ipcRenderer.invoke('terminal:createSsh', profileId, cols, rows),
    write: (sessionId: string, data: string | Uint8Array): Promise<boolean> =>
      ipcRenderer.invoke('terminal:write', sessionId, data),
    resize: (sessionId: string, cols: number, rows: number): Promise<void> =>
      ipcRenderer.invoke('terminal:resize', sessionId, cols, rows),
    kill: (sessionId: string): Promise<void> =>
      ipcRenderer.invoke('terminal:kill', sessionId),
    recentOutput: (sessionId: string, maxChars?: number): Promise<string | null> =>
      ipcRenderer.invoke('terminal:recentOutput', sessionId, maxChars),
    onData: (cb: (payload: { sessionId: string; data: Uint8Array }) => void) =>
      subscribe('terminal:data', cb),
    onExit: (cb: (payload: { sessionId: string; exitCode: number }) => void) =>
      subscribe('terminal:exit', cb),
    onClosed: (cb: (payload: { sessionId: string }) => void) =>
      subscribe('terminal:closed', cb)
  },
  ssh: {
    list: (): Promise<SshProfile[]> => ipcRenderer.invoke('ssh:list'),
    save: (profile: SshProfile): Promise<SshProfile[]> =>
      ipcRenderer.invoke('ssh:save', profile),
    remove: (id: string): Promise<SshProfile[]> => ipcRenderer.invoke('ssh:delete', id)
  },
  ai: {
    listConfigs: (): Promise<AiModelConfig[]> => ipcRenderer.invoke('ai:config:list'),
    saveConfig: (config: AiModelConfig): Promise<AiModelConfig[]> =>
      ipcRenderer.invoke('ai:config:save', config),
    deleteConfig: (id: string): Promise<AiModelConfig[]> =>
      ipcRenderer.invoke('ai:config:delete', id),
    getSettings: (): Promise<AiSettings> => ipcRenderer.invoke('ai:settings:get'),
    saveSettings: (settings: Partial<AiSettings>): Promise<AiSettings> =>
      ipcRenderer.invoke('ai:settings:save', settings),
    chat: (history: AiChatMessage[]): Promise<{ requestId: string }> =>
      ipcRenderer.invoke('ai:chat', history),
    abort: (requestId: string): Promise<void> =>
      ipcRenderer.invoke('ai:abort', requestId),
    onChatEvent: (cb: (payload: { requestId: string; event: AiStreamEvent }) => void) =>
      subscribe('ai:chat-event', cb),
    /** 确认模式下收到命令执行确认请求 */
    onConfirmRequest: (cb: (req: AiConfirmRequest) => void) => subscribe('ai:confirm', cb),
    /** 回复确认请求：approved=true 执行，false 取消 */
    resolveConfirm: (id: string, approved: boolean): Promise<void> =>
      ipcRenderer.invoke('ai:confirm:resolve', { id, approved })
  },
  mcp: {
    list: (): Promise<McpServerConfig[]> => ipcRenderer.invoke('mcp:list'),
    save: (server: McpServerConfig): Promise<McpServerConfig[]> =>
      ipcRenderer.invoke('mcp:save', server),
    remove: (id: string): Promise<McpServerConfig[]> => ipcRenderer.invoke('mcp:delete', id),
    listTools: (): Promise<{ tools: McpToolInfo[]; errors: string[] }> =>
      ipcRenderer.invoke('mcp:tools')
  },
  scripts: {
    list: (): Promise<ScriptEntry[]> => ipcRenderer.invoke('scripts:list'),
    save: (entry: ScriptEntry): Promise<ScriptEntry[]> =>
      ipcRenderer.invoke('scripts:save', entry),
    remove: (id: string): Promise<ScriptEntry[]> => ipcRenderer.invoke('scripts:delete', id)
  },
  prefs: {
    get: (): Promise<Preferences> => ipcRenderer.invoke('prefs:get'),
    save: (patch: Partial<Preferences>): Promise<Preferences> =>
      ipcRenderer.invoke('prefs:save', patch)
  },
  app: {
    /** 当前平台（同步常量，用于标题栏等 UI 的系统适配） */
    platform: process.platform,
    info: (): Promise<AppInfo> => ipcRenderer.invoke('app:info'),
    /** 订阅主进程触发的全局快捷键动作 */
    onShortcut: (cb: (action: AppShortcutAction) => void) => subscribe('app:shortcut', cb),
    /** 用系统默认程序打开外部链接（主进程会按安全协议过滤，避免弹窗） */
    openExternal: (url: string): Promise<void> => ipcRenderer.invoke('app:openExternal', url)
  },
  window: {
    minimize: (): Promise<void> => ipcRenderer.invoke('window:minimize'),
    toggleMaximize: (): Promise<void> => ipcRenderer.invoke('window:toggleMaximize'),
    close: (): Promise<void> => ipcRenderer.invoke('window:close'),
    isMaximized: (): Promise<boolean> => ipcRenderer.invoke('window:isMaximized'),
    /** 订阅最大化状态变化（自定义标题栏切换最大化/还原图标） */
    onMaximizedChange: (cb: (maximized: boolean) => void) =>
      subscribe('window:maximized', cb)
  },
  zmodem: {
    /** 打开文件选择框，返回选中文件的字节（用于 rz 上传） */
    pickFiles: (): Promise<{ name: string; size: number; data: Uint8Array }[]> =>
      ipcRenderer.invoke('zmodem:pickFiles'),
    /** 弹出保存对话框，返回用户选定的完整路径（先选位置再下载）；取消返回 null */
    askSavePath: (defaultName: string): Promise<string | null> =>
      ipcRenderer.invoke('zmodem:askSavePath', defaultName),
    /** 将字节写入指定路径并保存，返回实际保存路径（失败返回 null） */
    saveFileTo: (filePath: string, data: Uint8Array): Promise<string | null> =>
      ipcRenderer.invoke('zmodem:saveFileTo', filePath, data)
  },
  monitor: {
    /**
     * 订阅服务器指标推送；主进程在会话建立后自动采集，
     * 采集不到数据的主机不会有推送（前端据此不显示指标）
     */
    onData: (cb: (payload: { sessionId: string; metrics: ServerMetrics }) => void) =>
      subscribe('monitor:data', cb)
  }
}

export type Api = typeof api

contextBridge.exposeInMainWorld('api', api)
