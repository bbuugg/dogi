import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
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
  Preferences,
  ScriptEntry,
  ServerMetrics,
  SessionInfo,
  ShellDetectResult,
  SshConnectProgress,
  SshGroup,
  SshProfile
} from '@shared/types'
import type {
  PluginInfo,
  PluginHttpRequest,
  PluginHttpResponse
} from '@shared/plugin'

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
    /**
     * 等待会话就绪后写入内容（用于「连接主机后自动执行脚本」）；
     * 返回是否写入成功（会话不存在/已退出/超时返回 false）
     */
    runScript: (sessionId: string, data: string): Promise<boolean> =>
      ipcRenderer.invoke('terminal:runScript', sessionId, data),
    onData: (cb: (payload: { sessionId: string; data: Uint8Array }) => void) =>
      subscribe('terminal:data', cb),
    onExit: (cb: (payload: { sessionId: string; exitCode: number }) => void) =>
      subscribe('terminal:exit', cb),
    /** SSH 连接阶段进度（解析/握手/认证/打开 shell/重试） */
    onStatus: (cb: (payload: SshConnectProgress) => void) =>
      subscribe('terminal:status', cb),
    onClosed: (cb: (payload: { sessionId: string }) => void) =>
      subscribe('terminal:closed', cb)
  },
  ssh: {
    list: (): Promise<SshProfile[]> => ipcRenderer.invoke('ssh:list'),
    save: (profile: SshProfile): Promise<SshProfile[]> =>
      ipcRenderer.invoke('ssh:save', profile),
    remove: (id: string): Promise<SshProfile[]> => ipcRenderer.invoke('ssh:delete', id),
    /** 拖拽排序 / 换组后的整体重排（数组顺序即显示顺序） */
    arrange: (payload: {
      groupIds: string[]
      profiles: Array<{ id: string; groupId?: string }>
    }): Promise<{ groups: SshGroup[]; profiles: SshProfile[] }> =>
      ipcRenderer.invoke('ssh:arrange', payload),
    listGroups: (): Promise<SshGroup[]> => ipcRenderer.invoke('ssh:groups:list'),
    saveGroup: (input: { id?: string; name: string }): Promise<SshGroup[]> =>
      ipcRenderer.invoke('ssh:groups:save', input),
    /** 删除分组；deleteProfiles=true 时连同组内连接一起删除 */
    removeGroup: (id: string, deleteProfiles?: boolean): Promise<SshGroup[]> =>
      ipcRenderer.invoke('ssh:groups:delete', id, deleteProfiles)
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
    chat: (req: AiChatRequest): Promise<{ requestId: string }> =>
      ipcRenderer.invoke('ai:chat', req),
    abort: (requestId: string): Promise<void> =>
      ipcRenderer.invoke('ai:abort', requestId),
    onChatEvent: (cb: (payload: { requestId: string; event: AiStreamEvent }) => void) =>
      subscribe('ai:chat-event', cb),
    /** 确认模式下收到命令执行确认请求 */
    onConfirmRequest: (cb: (req: AiConfirmRequest) => void) => subscribe('ai:confirm', cb),
    /** 确认已有结论（用户回复走本地移除；超时 / 中止由主进程通知移除卡片） */
    onConfirmResolved: (cb: (payload: { id: string }) => void) =>
      subscribe('ai:confirm-resolved', cb),
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
  shortcuts: {
    /** 读取当前快捷键配置（动作 -> accelerator） */
    get: (): Promise<import('@shared/types').ShortcutConfig[]> =>
      ipcRenderer.invoke('shortcuts:get'),
    /** 保存快捷键配置并立即重注册系统级快捷键 */
    save: (shortcuts: import('@shared/types').ShortcutConfig[]): Promise<
      import('@shared/types').ShortcutConfig[]
    > => ipcRenderer.invoke('shortcuts:save', shortcuts),
    /**
     * 录制模式开关：开启时注销全部系统级快捷键，避免已注册的全局快捷键
     * （如 Ctrl+Alt+T）抢先触发动作、干扰录制；关闭时按存储重新注册。
     */
    setCapture: (enabled: boolean): Promise<void> =>
      ipcRenderer.invoke('shortcuts:capture', enabled)
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
    /** 设置采集间隔（毫秒）：立即生效并持久化，返回更新后的偏好设置 */
    setInterval: (ms: number): Promise<Preferences> =>
      ipcRenderer.invoke('monitor:setInterval', ms),
    /**
     * 订阅服务器指标推送；主进程在会话建立后自动采集，
     * 采集不到数据的主机不会有推送（前端据此不显示指标）
     */
    onData: (cb: (payload: { sessionId: string; metrics: ServerMetrics }) => void) =>
      subscribe('monitor:data', cb)
  },
  plugins: {
    /** 列出已加载插件的 manifest（含启用状态与渲染端入口信息） */
    list: (): Promise<PluginInfo[]> => ipcRenderer.invoke('plugins:list'),
    /** 启用/禁用插件（持久化），返回最新插件列表 */
    setEnabled: (id: string, enabled: boolean): Promise<PluginInfo[]> =>
      ipcRenderer.invoke('plugins:setEnabled', id, enabled),
    /** 卸载插件，返回最新插件列表 */
    uninstall: (id: string): Promise<PluginInfo[]> => ipcRenderer.invoke('plugins:uninstall', id),
    /** 从文件/目录安装插件，返回最新插件列表 */
    install: (sourcePath: string): Promise<PluginInfo[]> =>
      ipcRenderer.invoke('plugins:install', sourcePath),
    /** 重新加载插件（不传 id 表示全部），返回最新插件列表 */
    reload: (id?: string): Promise<PluginInfo[]> => ipcRenderer.invoke('plugins:reload', id),
    /** 读取插件渲染端源码（供渲染端 blob import 运行） */
    rendererCode: (id: string): Promise<string | null> =>
      ipcRenderer.invoke('plugin:rendererCode', id),
    /** 发起 HTTP 请求（需插件声明 http 权限） */
    http: (pluginId: string, req: PluginHttpRequest): Promise<PluginHttpResponse> =>
      ipcRenderer.invoke('plugin:http', pluginId, req),
    /** 读取插件持久化数据（需 storage 权限） */
    storageGet: (pluginId: string, key: string): Promise<unknown> =>
      ipcRenderer.invoke('plugin:storageGet', pluginId, key),
    /** 写入插件持久化数据（需 storage 权限） */
    storageSet: (pluginId: string, key: string, value: unknown): Promise<void> =>
      ipcRenderer.invoke('plugin:storageSet', pluginId, key, value),
    /** 调用插件自有主进程 handler */
    invoke: (pluginId: string, name: string, ...args: unknown[]): Promise<unknown> =>
      ipcRenderer.invoke('plugin:invoke', pluginId, name, args)
  },
  /** 原生文件/目录选择对话框 */
  dialog: {
    open: (options: unknown): Promise<{ canceled: boolean; filePaths: string[] }> =>
      ipcRenderer.invoke('dialog:open', options)
  }
}

export type Api = typeof api

contextBridge.exposeInMainWorld('api', api)
