import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import { applyColorTheme } from '../shared/theme'
import type { ColorThemeName } from '../shared/types'
import type {
  AgentBackend,
  AgentChatMessage,
  AgentChatRequest,
  AgentConfirmRequest,
  AgentConversation,
  AgentStreamEvent,
  AgentWorkspace,
  AiChatRequest,
  AiConfirmRequest,
  AiModelConfig,
  AiSettings,
  AiStreamEvent,
  ApiGroup,
  ApiHistoryEntry,
  ApiHttpRequest,
  ApiHttpResponse,
  ApiRequestEntry,
  AppInfo,
  DetectedAcpAgent,
  IdeInfo,
  McpServerConfig,
  McpToolInfo,
  NoteEntry,
  NoteGroup,
  OpenResult,
  Preferences,
  ScriptEntry,
  ScriptGroup,
  ServerMetrics,
  SessionInfo,
  ShellDetectResult,
  SshConnectProgress,
  SshGroup,
  SshProfile,
  WsConnectOptions,
  WsEvent,
  WsOpenResult,
  WsSendPayload
} from '@shared/types'
import type {
  PluginInfo,
  PluginHttpRequest,
  PluginHttpResponse
} from '@shared/plugin'

/**
 * 首帧之前把主题落到 html 上。
 *
 * 渲染端要等异步的 `bootstrap()` 才能拿到 preferences，在那之前 `index.html`
 * 上硬编码的 `class="dark"` 会先按默认主题渲染一帧 —— 这就是「启动时先黑一下、
 * 再变成设置里的配色」的来源（闪的是**配色主题**，不是明暗）。
 * preload 在页面脚本之前执行，这里同步取一次偏好直接设好 class 与
 * `data-color-theme`，首帧就是用户设置的样子，不需要任何启动画面去遮。
 *
 * 读不到偏好（异常等）时保持 index.html 的默认值，渲染端 bootstrap 会再纠正。
 */
function applyInitialTheme(): void {
  let prefs: {
    theme: 'system' | 'light' | 'dark'
    colorTheme: ColorThemeName
    customColor?: string
  } | null = null
  try {
    prefs = ipcRenderer.sendSync('prefs:themeSync')
  } catch {
    return
  }
  if (!prefs) return

  const { theme, colorTheme, customColor } = prefs
  // 明暗由主进程的 nativeTheme.themeSource 决定，这里按同一规则解析
  const isDark =
    theme === 'dark' ||
    (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)

  const apply = (): boolean => {
    const root = document.documentElement
    if (!root) return false
    root.classList.toggle('dark', isDark)
    applyColorTheme(colorTheme, customColor, root)
    return true
  }

  if (apply()) {
    console.log('[theme] preload 已应用首帧主题：', theme, colorTheme, document.readyState)
    return
  }

  // ⚠️ Electron 的 preload 跑在 document_start，此时连 <html> 都还没被解析出来
  // （documentElement 为 null），所以这里不能直接 return —— 否则主题根本没设上，
  // 首帧仍是 index.html 里硬编码的默认主题，照样闪。
  // 盯着 document 的子节点，<html> 一出现立刻补上：MutationObserver 是微任务，
  // 在解析器继续之前执行，所以仍在首帧（body 尚未解析）之前。
  const observer = new MutationObserver(() => {
    if (!apply()) return
    observer.disconnect()
    console.log('[theme] preload 已补应用首帧主题：', theme, colorTheme, document.readyState)
  })
  observer.observe(document, { childList: true })
}

applyInitialTheme()

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
    createLocal: (cols?: number, rows?: number, shellId?: string, cwd?: string): Promise<SessionInfo> =>
      ipcRenderer.invoke('terminal:createLocal', cols, rows, shellId, cwd),
    createSsh: (profileId: string, cols?: number, rows?: number): Promise<SessionInfo> =>
      ipcRenderer.invoke('terminal:createSsh', profileId, cols, rows),
    /** 按主机配置创建会话：主进程根据主机类型（ssh/local）决定启动方式 */
    createFromProfile: (profileId: string, cols?: number, rows?: number): Promise<SessionInfo> =>
      ipcRenderer.invoke('terminal:createFromProfile', profileId, cols, rows),
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
    /**主机阶段进度（解析/握手/认证/打开 shell/重试） */
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
    saveGroup: (input: { id?: string; name: string; color?: string | null }): Promise<SshGroup[]> =>
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
    /** 检测本机 PATH 中已安装的 ACP agent */
    detectAcpAgents: (): Promise<DetectedAcpAgent[]> =>
      ipcRenderer.invoke('ai:detectAcpAgents'),
    /** 拉取 OpenAI 兼容接口的模型列表（GET {baseURL}/models） */
    listRemoteModels: (input: { baseURL: string; apiKey?: string }): Promise<string[]> =>
      ipcRenderer.invoke('ai:listRemoteModels', input),
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
  /** AI Agent（工作区编程/运维助手）：对话绑定一个本地工作区，工具在其内读写/执行命令 */
  agent: {
    listWorkspaces: (): Promise<AgentWorkspace[]> =>
      ipcRenderer.invoke('agent:workspaces:list'),
    saveWorkspace: (input: {
      id?: string
      name: string
      path: string
      backend?: AgentBackend
    }): Promise<AgentWorkspace[]> => ipcRenderer.invoke('agent:workspaces:save', input),
    deleteWorkspace: (id: string): Promise<AgentWorkspace[]> =>
      ipcRenderer.invoke('agent:workspaces:delete', id),
    /** 全部会话（含消息历史），渲染端按 workspaceId 归到各工作区下 */
    listConversations: (): Promise<AgentConversation[]> =>
      ipcRenderer.invoke('agent:conversations:list'),
    /** 新建（不传 id）或更新会话，返回保存后的那一个（不回传全量列表） */
    saveConversation: (input: {
      id?: string
      workspaceId: string
      title?: string
      messages?: AgentChatMessage[]
    }): Promise<AgentConversation> => ipcRenderer.invoke('agent:conversations:save', input),
    deleteConversation: (id: string): Promise<void> =>
      ipcRenderer.invoke('agent:conversations:delete', id),
    chat: (req: AgentChatRequest): Promise<{ requestId: string }> =>
      ipcRenderer.invoke('agent:chat', req),
    abort: (requestId: string): Promise<void> => ipcRenderer.invoke('agent:abort', requestId),
    onChatEvent: (cb: (payload: { requestId: string; event: AgentStreamEvent }) => void) =>
      subscribe('agent:chat-event', cb),
    /** 确认模式下收到 execute_command 执行确认请求 */
    onConfirmRequest: (cb: (req: AgentConfirmRequest) => void) => subscribe('agent:confirm', cb),
    /** 确认已有结论（超时 / 中止由主进程通知移除卡片） */
    onConfirmResolved: (cb: (payload: { id: string }) => void) =>
      subscribe('agent:confirm-resolved', cb),
    /** 回复确认请求：approved=true 执行，false 取消 */
    resolveConfirm: (id: string, approved: boolean): Promise<void> =>
      ipcRenderer.invoke('agent:confirm:resolve', { id, approved })
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
    remove: (id: string): Promise<ScriptEntry[]> => ipcRenderer.invoke('scripts:delete', id),
    /** 拖拽排序 / 换组后的整体重排（数组顺序即显示顺序） */
    arrange: (payload: {
      groupIds: string[]
      scripts: Array<{ id: string; groupId?: string }>
    }): Promise<{ groups: ScriptGroup[]; scripts: ScriptEntry[] }> =>
      ipcRenderer.invoke('scripts:arrange', payload),
    listGroups: (): Promise<ScriptGroup[]> => ipcRenderer.invoke('scripts:groups:list'),
    saveGroup: (input: { id?: string; name: string }): Promise<ScriptGroup[]> =>
      ipcRenderer.invoke('scripts:groups:save', input),
    /** 删除分组；deleteScripts=true 时连同组内脚本一起删除 */
    removeGroup: (
      id: string,
      deleteScripts?: boolean
    ): Promise<{ groups: ScriptGroup[]; scripts: ScriptEntry[] }> =>
      ipcRenderer.invoke('scripts:groups:delete', id, deleteScripts)
  },
  notes: {
    list: (): Promise<NoteEntry[]> => ipcRenderer.invoke('notes:list'),
    save: (note: NoteEntry): Promise<NoteEntry[]> => ipcRenderer.invoke('notes:save', note),
    remove: (id: string): Promise<NoteEntry[]> => ipcRenderer.invoke('notes:delete', id),
    /** 拖拽排序 / 换组后的整体重排（数组顺序即显示顺序） */
    arrange: (payload: {
      groupIds: string[]
      notes: Array<{ id: string; groupId?: string }>
    }): Promise<{ groups: NoteGroup[]; notes: NoteEntry[] }> =>
      ipcRenderer.invoke('notes:arrange', payload),
    listGroups: (): Promise<NoteGroup[]> => ipcRenderer.invoke('notes:groups:list'),
    saveGroup: (input: { id?: string; name: string }): Promise<NoteGroup[]> =>
      ipcRenderer.invoke('notes:groups:save', input),
    /** 删除分组；deleteNotes=true 时连同组内笔记一起删除 */
    removeGroup: (
      id: string,
      deleteNotes?: boolean
    ): Promise<{ groups: NoteGroup[]; notes: NoteEntry[] }> =>
      ipcRenderer.invoke('notes:groups:delete', id, deleteNotes)
  },
  /** 内置的「接口请求」功能：请求由主进程发出，规避渲染进程的 CORS 限制 */
  apiClient: {
    list: (): Promise<ApiRequestEntry[]> => ipcRenderer.invoke('api:list'),
    save: (entry: ApiRequestEntry): Promise<ApiRequestEntry[]> =>
      ipcRenderer.invoke('api:save', entry),
    remove: (id: string): Promise<ApiRequestEntry[]> => ipcRenderer.invoke('api:delete', id),
    /** 拖拽排序 / 换组后的整体重排（数组顺序即显示顺序） */
    arrange: (payload: {
      groupIds: string[]
      requests: Array<{ id: string; groupId?: string }>
    }): Promise<{ groups: ApiGroup[]; requests: ApiRequestEntry[] }> =>
      ipcRenderer.invoke('api:arrange', payload),
    listGroups: (): Promise<ApiGroup[]> => ipcRenderer.invoke('api:groups:list'),
    saveGroup: (input: { id?: string; name: string }): Promise<ApiGroup[]> =>
      ipcRenderer.invoke('api:groups:save', input),
    /** 删除分组；deleteRequests=true 时连同组内请求一起删除 */
    removeGroup: (
      id: string,
      deleteRequests?: boolean
    ): Promise<{ groups: ApiGroup[]; requests: ApiRequestEntry[] }> =>
      ipcRenderer.invoke('api:groups:delete', id, deleteRequests),
    listHistory: (): Promise<ApiHistoryEntry[]> => ipcRenderer.invoke('api:history:list'),
    /** 覆盖写入整段历史（渲染端负责裁剪条数） */
    saveHistory: (entries: ApiHistoryEntry[]): Promise<ApiHistoryEntry[]> =>
      ipcRenderer.invoke('api:history:save', entries),
    clearHistory: (): Promise<ApiHistoryEntry[]> => ipcRenderer.invoke('api:history:clear'),
    send: (req: ApiHttpRequest): Promise<ApiHttpResponse> => ipcRenderer.invoke('api:send', req)
  },
  /**
   * WebSocket 调试（接口请求里的 ws 协议）。
   * `open` 只建连并返回 connId，握手结果与每一帧消息都通过 `onEvent` 推送。
   */
  ws: {
    /** connId 由渲染端生成（先拿 id 再建连，避免握手事件早于 IPC 回包被丢掉） */
    open: (connId: string, options: WsConnectOptions): Promise<WsOpenResult> =>
      ipcRenderer.invoke('ws:open', connId, options),
    send: (connId: string, payload: WsSendPayload): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('ws:send', connId, payload),
    close: (connId: string, code?: number, reason?: string): Promise<void> =>
      ipcRenderer.invoke('ws:close', connId, code, reason),
    /** 订阅所有连接的事件；渲染端按 payload.connId 过滤出自己那条 */
    onEvent: (cb: (event: WsEvent) => void) => subscribe('ws:event', cb)
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
    /** 用系统默认程序打开外部链接（主进程会按安全协议过滤，避免弹窗） */
    openExternal: (url: string): Promise<void> => ipcRenderer.invoke('app:openExternal', url)
  },
  shortcuts: {
    /** 读取当前快捷键配置（动作 -> accelerator） */
    get: (): Promise<import('@shared/types').ShortcutConfig[]> =>
      ipcRenderer.invoke('shortcuts:get'),
    /**
     * 保存快捷键配置。这些是**应用内**快捷键（渲染端自己监听 keydown 匹配），
     * 主进程只负责落盘，保存后无需重注册。
     */
    save: (shortcuts: import('@shared/types').ShortcutConfig[]): Promise<
      import('@shared/types').ShortcutConfig[]
    > => ipcRenderer.invoke('shortcuts:save', shortcuts)
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
  },
  /** 系统打开：文件管理器 / 终端 / 已安装 IDE（平台差异由主进程处理） */
  shell: {
    openFileManager: (dir: string): Promise<OpenResult> =>
      ipcRenderer.invoke('shell:openFileManager', dir),
    openTerminal: (dir: string): Promise<OpenResult> =>
      ipcRenderer.invoke('shell:openTerminal', dir),
    listIdes: (): Promise<IdeInfo[]> => ipcRenderer.invoke('shell:listIdes'),
    openIde: (ideId: string, dir: string): Promise<OpenResult> =>
      ipcRenderer.invoke('shell:openIde', ideId, dir)
  }
}

export type Api = typeof api

contextBridge.exposeInMainWorld('api', api)
