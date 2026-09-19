/**
 * Tauri 版 `window.api` 适配层。
 *
 * 目标：与 Electron 版 preload 暴露的 api 形状完全一致，渲染层业务代码零改动。
 * 差异只在传输细节：
 * - IPC 用 `invoke`，参数名走 camelCase（Tauri 默认）
 * - 二进制（终端数据 / ZMODEM 文件）经 base64 编解码
 * - 事件用 `listen`（见 events.ts 的 subscribe）
 */

import { invoke } from '@tauri-apps/api/core'
import { platform as osPlatform } from '@tauri-apps/plugin-os'

import type {
  AiChatRequest,
  AiConfirmRequest,
  AiModelConfig,
  AiSettings,
  AiStreamEvent,
  AppInfo,
  AppShortcutAction,
  McpServerConfig,
  McpToolInfo,
  NoteEntry,
  Preferences,
  ScriptEntry,
  ServerMetrics,
  SessionInfo,
  ShellDetectResult,
  ShortcutConfig,
  SshConnectProgress,
  SshGroup,
  SshProfile
} from '@shared/types'
import type { PluginHttpRequest, PluginHttpResponse, PluginInfo } from '@shared/plugin'

import { base64ToBytes, bytesToBase64, subscribe, terminalDataToBase64 } from './events'

type Unsubscribe = () => void

/** 把 Tauri 的 os 插件平台名映射回 Electron 的 `process.platform` 取值 */
function electronPlatform(): string {
  switch (osPlatform()) {
    case 'windows':
      return 'win32'
    case 'macos':
      return 'darwin'
    default:
      return 'linux'
  }
}

/** 尚未接入的能力统一给出可读错误，避免静默失败 */
function notImplemented(feature: string): Promise<never> {
  return Promise.reject(new Error(`${feature}将在后续阶段接入`))
}

const api = {
  terminal: {
    list: (): Promise<SessionInfo[]> => invoke('terminal_list'),
    listShells: (): Promise<ShellDetectResult> => invoke('terminal_list_shells'),
    createLocal: (cols?: number, rows?: number, shellId?: string): Promise<SessionInfo> =>
      invoke('terminal_create_local', { cols, rows, shellId }),
    createSsh: (profileId: string, cols?: number, rows?: number): Promise<SessionInfo> =>
      invoke('terminal_create_ssh', { profileId, cols, rows }),
    createFromProfile: (profileId: string, cols?: number, rows?: number): Promise<SessionInfo> =>
      invoke('terminal_create_from_profile', { profileId, cols, rows }),
    write: (sessionId: string, data: string | Uint8Array): Promise<boolean> =>
      invoke('terminal_write', { sessionId, dataBase64: terminalDataToBase64(data) }),
    resize: (sessionId: string, cols: number, rows: number): Promise<void> =>
      invoke('terminal_resize', { sessionId, cols, rows }),
    kill: (sessionId: string): Promise<void> => invoke('terminal_kill', { sessionId }),
    recentOutput: (sessionId: string, maxChars?: number): Promise<string | null> =>
      invoke('terminal_recent_output', { sessionId, maxChars }),
    runScript: (sessionId: string, data: string): Promise<boolean> =>
      invoke('terminal_run_script', { sessionId, data }),
    onData: (cb: (payload: { sessionId: string; data: Uint8Array }) => void): Unsubscribe =>
      subscribe<{ sessionId: string; data: string }>('terminal:data', (p) =>
        cb({ sessionId: p.sessionId, data: base64ToBytes(p.data) })
      ),
    onExit: (cb: (payload: { sessionId: string; exitCode: number }) => void): Unsubscribe =>
      subscribe('terminal:exit', cb),
    onStatus: (cb: (payload: SshConnectProgress) => void): Unsubscribe =>
      subscribe('terminal:status', cb),
    onClosed: (cb: (payload: { sessionId: string }) => void): Unsubscribe =>
      subscribe('terminal:closed', cb)
  },
  ssh: {
    list: (): Promise<SshProfile[]> => invoke('ssh_list'),
    save: (profile: SshProfile): Promise<SshProfile[]> => invoke('ssh_save', { profile }),
    remove: (id: string): Promise<SshProfile[]> => invoke('ssh_delete', { id }),
    arrange: (payload: {
      groupIds: string[]
      profiles: Array<{ id: string; groupId?: string }>
    }): Promise<{ groups: SshGroup[]; profiles: SshProfile[] }> =>
      invoke('ssh_arrange', { payload }),
    listGroups: (): Promise<SshGroup[]> => invoke('ssh_groups_list'),
    saveGroup: (input: { id?: string; name: string; color?: string | null }): Promise<SshGroup[]> =>
      invoke('ssh_groups_save', { input }),
    removeGroup: (id: string, deleteProfiles?: boolean): Promise<SshGroup[]> =>
      invoke('ssh_groups_delete', { id, deleteProfiles })
  },
  ai: {
    listConfigs: (): Promise<AiModelConfig[]> => invoke('ai_config_list'),
    saveConfig: (config: AiModelConfig): Promise<AiModelConfig[]> =>
      invoke('ai_config_save', { config }),
    deleteConfig: (id: string): Promise<AiModelConfig[]> => invoke('ai_config_delete', { id }),
    getSettings: (): Promise<AiSettings> => invoke('ai_settings_get'),
    saveSettings: (settings: Partial<AiSettings>): Promise<AiSettings> =>
      invoke('ai_settings_save', { settings }),
    chat: (req: AiChatRequest): Promise<{ requestId: string }> => invoke('ai_chat', { req }),
    abort: (requestId: string): Promise<void> => invoke('ai_abort', { requestId }),
    onChatEvent: (cb: (payload: { requestId: string; event: AiStreamEvent }) => void): Unsubscribe =>
      subscribe('ai:chat-event', cb),
    onConfirmRequest: (cb: (req: AiConfirmRequest) => void): Unsubscribe =>
      subscribe('ai:confirm', cb),
    onConfirmResolved: (cb: (payload: { id: string }) => void): Unsubscribe =>
      subscribe('ai:confirm-resolved', cb),
    resolveConfirm: (id: string, approved: boolean): Promise<void> =>
      invoke('ai_confirm_resolve', { id, approved })
  },
  mcp: {
    list: (): Promise<McpServerConfig[]> => invoke('mcp_list'),
    save: (server: McpServerConfig): Promise<McpServerConfig[]> => invoke('mcp_save', { server }),
    remove: (id: string): Promise<McpServerConfig[]> => invoke('mcp_delete', { id }),
    listTools: (): Promise<{ tools: McpToolInfo[]; errors: string[] }> =>
      invoke('mcp_list_tools')
  },
  scripts: {
    list: (): Promise<ScriptEntry[]> => invoke('scripts_list'),
    save: (entry: ScriptEntry): Promise<ScriptEntry[]> => invoke('scripts_save', { entry }),
    remove: (id: string): Promise<ScriptEntry[]> => invoke('scripts_delete', { id })
  },
  notes: {
    list: (): Promise<NoteEntry[]> => invoke('notes_list'),
    save: (note: NoteEntry): Promise<NoteEntry[]> => invoke('notes_save', { note }),
    remove: (id: string): Promise<NoteEntry[]> => invoke('notes_delete', { id })
  },
  prefs: {
    get: (): Promise<Preferences> => invoke('prefs_get'),
    save: (patch: Partial<Preferences>): Promise<Preferences> => invoke('prefs_save', { patch })
  },
  app: {
    /** 当前平台（同步常量，与 `process.platform` 取值一致） */
    platform: electronPlatform(),
    info: (): Promise<AppInfo> => invoke('app_info'),
    onShortcut: (cb: (action: AppShortcutAction) => void): Unsubscribe =>
      subscribe('app:shortcut', cb),
    openExternal: (url: string): Promise<void> => invoke('app_open_external', { url })
  },
  shortcuts: {
    get: (): Promise<ShortcutConfig[]> => invoke('shortcuts_get'),
    save: (shortcuts: ShortcutConfig[]): Promise<ShortcutConfig[]> =>
      invoke('shortcuts_save', { shortcuts }),
    setCapture: (enabled: boolean): Promise<void> => invoke('shortcuts_capture', { enabled })
  },
  window: {
    minimize: (): Promise<void> => invoke('window_minimize'),
    toggleMaximize: (): Promise<void> => invoke('window_toggle_maximize'),
    close: (): Promise<void> => invoke('window_close'),
    isMaximized: (): Promise<boolean> => invoke('window_is_maximized'),
    onMaximizedChange: (cb: (maximized: boolean) => void): Unsubscribe =>
      subscribe('window:maximized', cb)
  },
  zmodem: {
    pickFiles: async (): Promise<{ name: string; size: number; data: Uint8Array }[]> => {
      const picked = await invoke<Array<{ name: string; size: number; dataBase64: string }>>(
        'zmodem_pick_files'
      )
      return picked.map((f) => ({
        name: f.name,
        size: f.size,
        data: base64ToBytes(f.dataBase64)
      }))
    },
    askSavePath: (defaultName: string): Promise<string | null> =>
      invoke('zmodem_ask_save_path', { defaultName }),
    saveFileTo: (filePath: string, data: Uint8Array): Promise<string | null> =>
      invoke('zmodem_save_file_to', { filePath, dataBase64: bytesToBase64(data) })
  },
  monitor: {
    setInterval: (ms: number): Promise<Preferences> => invoke('monitor_set_interval', { ms }),
    onData: (cb: (payload: { sessionId: string; metrics: ServerMetrics }) => void): Unsubscribe =>
      subscribe('monitor:data', cb)
  },
  plugins: {
    // 插件宿主在 Phase 3 接入：列表返回空，其余入口给出可读错误
    list: (): Promise<PluginInfo[]> => Promise.resolve([]),
    setEnabled: (_id: string, _enabled: boolean): Promise<PluginInfo[]> =>
      notImplemented('插件系统'),
    uninstall: (_id: string): Promise<PluginInfo[]> => notImplemented('插件系统'),
    install: (_sourcePath: string): Promise<PluginInfo[]> => notImplemented('插件系统'),
    reload: (_id?: string): Promise<PluginInfo[]> => notImplemented('插件系统'),
    rendererCode: (_id: string): Promise<string | null> => Promise.resolve(null),
    webviewInfo: (_id: string): Promise<{ entry: string; preload: string | null } | null> =>
      Promise.resolve(null),
    http: (_pluginId: string, _req: PluginHttpRequest): Promise<PluginHttpResponse> =>
      notImplemented('插件 HTTP 能力'),
    storageGet: (pluginId: string, key: string): Promise<unknown> =>
      invoke('plugin_storage_get', { pluginId, key }),
    storageSet: (pluginId: string, key: string, value: unknown): Promise<void> =>
      invoke('plugin_storage_set', { pluginId, key, value }),
    invoke: (_pluginId: string, _name: string, ..._args: unknown[]): Promise<unknown> =>
      notImplemented('插件主进程能力')
  },
  dialog: {
    open: (options: unknown): Promise<{ canceled: boolean; filePaths: string[] }> =>
      invoke('dialog_open', { options })
  }
}

export type Api = typeof api

/** 注入全局（替代 preload 的 contextBridge） */
export function installApi(): void {
  window.api = api
}
