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
  SessionInfo,
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
    createLocal: (cols?: number, rows?: number): Promise<SessionInfo> =>
      ipcRenderer.invoke('terminal:createLocal', cols, rows),
    createSsh: (profileId: string, cols?: number, rows?: number): Promise<SessionInfo> =>
      ipcRenderer.invoke('terminal:createSsh', profileId, cols, rows),
    write: (sessionId: string, data: string): Promise<boolean> =>
      ipcRenderer.invoke('terminal:write', sessionId, data),
    resize: (sessionId: string, cols: number, rows: number): Promise<void> =>
      ipcRenderer.invoke('terminal:resize', sessionId, cols, rows),
    kill: (sessionId: string): Promise<void> =>
      ipcRenderer.invoke('terminal:kill', sessionId),
    recentOutput: (sessionId: string, maxChars?: number): Promise<string | null> =>
      ipcRenderer.invoke('terminal:recentOutput', sessionId, maxChars),
    onData: (cb: (payload: { sessionId: string; data: string }) => void) =>
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
  prefs: {
    get: (): Promise<Preferences> => ipcRenderer.invoke('prefs:get'),
    save: (patch: Partial<Preferences>): Promise<Preferences> =>
      ipcRenderer.invoke('prefs:save', patch)
  },
  app: {
    info: (): Promise<AppInfo> => ipcRenderer.invoke('app:info'),
    /** 订阅主进程触发的全局快捷键动作 */
    onShortcut: (cb: (action: AppShortcutAction) => void) => subscribe('app:shortcut', cb)
  }
}

export type Api = typeof api

contextBridge.exposeInMainWorld('api', api)
