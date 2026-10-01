import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { IpcRendererEvent } from 'electron'
import { applyColorTheme } from '../shared/theme'
import type { ColorThemeName } from '../shared/types'
import type {
  AcpConversationState,
  AcpModelList,
  AcpSessionInfo,
  AgentBackend,
  AgentChatMessage,
  AgentChatRequest,
  AgentConfirmRequest,
  AgentConversation,
  AskFollowupAnswer,
  AskFollowupRequest,
  AgentFsEntry,
  AgentFsFile,
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
  ApiPickFileResult,
  ApiRequestEntry,
  AppInfo,
  BrowserFrame,
  BrowserInputEvent,
  BrowserSessionState,
  BrowserViewportMode,
  DetectedAcpAgent,
  GitAction,
  GitBranchesResult,
  GitCommit,
  GitStatusResult,
  HostLogEntry,
  IdeInfo,
  McpServerConfig,
  McpToolInfo,
  MonitorUnsupportedPayload,
  MoshClientStatus,
  NoteEntry,
  NoteGroup,
  NoteFileItem,
  NoteFileContent,
  NoteSession,
  OpenResult,
  Preferences,
  RdpBridgeInfo,
  RdpCredentials,
  ScriptEntry,
  ScriptGroup,
  ServerMetrics,
  SessionInfo,
  ShellDetectResult,
  SftpEntry,
  SftpTransferProgress,
  SftpTransferResult,
  SshConnectProgress,
  SkillListResult,
  SkillSettings,
  SshGroup,
  SshKnownHost,
  SshProfile,
  SshTunnel,
  SshTunnelRuntime,
  TransferExportResult,
  TransferImportResult,
  TransferKind,
  TransferPickResult,
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
import type { WorkspaceConfig, WorkspaceConfigSnapshot } from '@shared/workspace-config'

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
    /**
     * 探测本地 mosh-client（原生 / WSL 回退）；refresh 为 true 时强制重扫，
     * 供「刚装完 mosh-client 不想重启应用」的场景
     */
    moshStatus: (refresh?: boolean): Promise<MoshClientStatus> =>
      ipcRenderer.invoke('terminal:moshStatus', refresh),
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
    /** 删除主机；clearedJumps 为被顺带清掉的跳板引用数量（>0 时渲染端提示） */
    remove: (id: string): Promise<{ profiles: SshProfile[]; clearedJumps: number }> =>
      ipcRenderer.invoke('ssh:delete', id),
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
      ipcRenderer.invoke('ssh:groups:delete', id, deleteProfiles),
    /** 测试连接：连上即断，返回耗时（毫秒）；失败抛错（错误信息已是用户可读文案） */
    test: (draft: SshProfile): Promise<{ ms: number }> => ipcRenderer.invoke('ssh:test', draft),
    /** 弹文件选择框读私钥内容；用户取消返回 null */
    readKeyFile: (): Promise<{ path: string; content: string } | null> =>
      ipcRenderer.invoke('ssh:readKeyFile'),
    knownHostsList: (): Promise<SshKnownHost[]> => ipcRenderer.invoke('ssh:knownHosts:list'),
    /** 重置指定 host:port 的主机指纹记录（下次连接重新 TOFU） */
    knownHostsReset: (host: string, port: number): Promise<void> =>
      ipcRenderer.invoke('ssh:knownHosts:reset', host, port)
  },
  /** SSH 隧道（本地转发 -L / 远程转发 -R / SOCKS5 动态 -D）：运行态经 onStatus 订阅推送 */
  tunnels: {
    list: (): Promise<{ tunnels: SshTunnel[]; runtime: SshTunnelRuntime[] }> =>
      ipcRenderer.invoke('tunnels:list'),
    /** 新建（id 为空）或更新（id 已存在）；运行中被编辑的隧道会自动重启 */
    save: (tunnel: SshTunnel): Promise<{ tunnels: SshTunnel[]; runtime: SshTunnelRuntime[] }> =>
      ipcRenderer.invoke('tunnels:save', tunnel),
    /** 删除（运行中会先停止） */
    remove: (id: string): Promise<{ tunnels: SshTunnel[]; runtime: SshTunnelRuntime[] }> =>
      ipcRenderer.invoke('tunnels:delete', id),
    /** 启动（失败不抛错，落在运行态的 error 里） */
    start: (id: string): Promise<void> => ipcRenderer.invoke('tunnels:start', id),
    stop: (id: string): Promise<void> => ipcRenderer.invoke('tunnels:stop', id),
    /** 运行态全量推送（启动/停止/出错/连接数变化都会触发） */
    onStatus: (cb: (runtime: SshTunnelRuntime[]) => void) => subscribe('tunnels:status', cb)
  },
  /** 主机日志：SSH 连接 / 隧道 / SFTP 等主机相关事件（记录在主进程，跨重启保留） */
  logs: {
    /** 全量读取（从旧到新，界面自行倒序）；上限 1000 条，更早的看落盘文件 */
    list: (): Promise<HostLogEntry[]> => ipcRenderer.invoke('logs:list'),
    /** 清空内存与落盘文件（序号继续递增，不复用） */
    clear: (): Promise<void> => ipcRenderer.invoke('logs:clear'),
    /** 在文件管理器中打开日志目录（userData/logs） */
    reveal: (): Promise<OpenResult> => ipcRenderer.invoke('logs:reveal'),
    /** 新日志实时推送（初始全量走 list，之后按此补增量） */
    onEntry: (cb: (entry: HostLogEntry) => void) => subscribe('logs:entry', cb)
  },
  /** SFTP 文件管理：凭据复用 SSH 主机配置（主进程解密，渲染端不接触密码） */
  sftp: {
    /** connId 由渲染端生成（一个「文件管理」标签一个连接）；resolve 即连接就绪 */
    open: (connId: string, profileId: string): Promise<void> =>
      ipcRenderer.invoke('sftp:open', connId, profileId),
    list: (connId: string, path: string): Promise<SftpEntry[]> =>
      ipcRenderer.invoke('sftp:list', connId, path),
    /**
     * 解析远端路径为绝对路径（realpath）；传 '.' 由服务端解析默认工作目录。
     * 初始目录以 `/` 列不出内容时（win32-openssh）用它兜底
     */
    realpath: (connId: string, path: string): Promise<string> =>
      ipcRenderer.invoke('sftp:realpath', connId, path),
    mkdir: (connId: string, path: string): Promise<void> =>
      ipcRenderer.invoke('sftp:mkdir', connId, path),
    rename: (connId: string, from: string, to: string): Promise<void> =>
      ipcRenderer.invoke('sftp:rename', connId, from, to),
    remove: (connId: string, path: string): Promise<void> =>
      ipcRenderer.invoke('sftp:remove', connId, path),
    /** 弹另存为对话框后下载，返回保存路径（canceled=true 表示用户取消） */
    download: (connId: string, remotePath: string, defaultName: string): Promise<SftpTransferResult> =>
      ipcRenderer.invoke('sftp:download', connId, remotePath, defaultName),
    /** 弹选择文件对话框（可多选）后上传到远端目录（并发） */
    upload: (connId: string, remoteDir: string): Promise<SftpTransferResult> =>
      ipcRenderer.invoke('sftp:upload', connId, remoteDir),
    /** 弹选择目录对话框后递归上传整个本地目录（目录内每个文件一笔独立传输） */
    uploadDir: (connId: string, remoteDir: string): Promise<SftpTransferResult> =>
      ipcRenderer.invoke('sftp:uploadDir', connId, remoteDir),
    /**
     * 按本地路径上传（不弹对话框）：目录递归上传为 remoteDir/<目录名>，文件落到 remoteDir。
     * 用于「拖文件/文件夹到终端」——路径由渲染端用 app.getPathForFile 从拖拽数据里取
     */
    uploadPaths: (
      connId: string,
      remoteDir: string,
      paths: string[]
    ): Promise<SftpTransferResult> =>
      ipcRenderer.invoke('sftp:uploadPaths', connId, remoteDir, paths),
    /** 弹选择目录对话框后递归下载整个远端目录（目录内每个文件一笔独立传输） */
    downloadDir: (connId: string, remoteDir: string, defaultName: string): Promise<SftpTransferResult> =>
      ipcRenderer.invoke('sftp:downloadDir', connId, remoteDir, defaultName),
    /** 远端复制（文件或目录，递归），to 为完整目标路径 */
    copy: (connId: string, from: string, to: string): Promise<SftpTransferResult> =>
      ipcRenderer.invoke('sftp:copy', connId, from, to),
    /** 远端移动（跨目录，必要时复制 + 删源），to 为完整目标路径 */
    move: (connId: string, from: string, to: string): Promise<SftpTransferResult> =>
      ipcRenderer.invoke('sftp:move', connId, from, to),
    /** 取消一笔进行中的传输（进度条上的取消按钮，按 transferId 定位） */
    abortTransfer: (transferId: string): Promise<void> =>
      ipcRenderer.invoke('sftp:abortTransfer', transferId),
    close: (connId: string): Promise<void> => ipcRenderer.invoke('sftp:close', connId),
    onProgress: (cb: (payload: SftpTransferProgress) => void) => subscribe('sftp:progress', cb),
    /** 连接断开（远端断连 / 网络错误），渲染端据此提示并停止操作 */
    onClosed: (cb: (payload: { connId: string }) => void) => subscribe('sftp:closed', cb)
  },
  /** 远程桌面（RDP）：主进程本地桥（RDCleanPath）+ 渲染端 WASM 客户端（ironrdp-wasm）
   *
   * 远程桌面是独立的主机类型（kind = 'rdp'）：host / port / 凭据都来自主机配置。
   */
  rdp: {
    /**
     * 为该主机配置开一座本地桥（幂等），返回 WASM 客户端要连的 ws 地址。
     * 主机地址与 RDP 端口都取自 kind = 'rdp' 的主机配置
     */
    open: (connId: string, profileId: string): Promise<RdpBridgeInfo> =>
      ipcRenderer.invoke('rdp:open', connId, profileId),
    /** 关闭本地桥（标签关闭时调用） */
    close: (connId: string): Promise<void> => ipcRenderer.invoke('rdp:close', connId),
    /**
     * 读取连接凭据（用户名 / 密码 / 域 / 端口）：密码在存储层已解密。
     * WASM 客户端要在渲染进程完成 NLA / CredSSP 票据计算，只能在连接时取用。
     */
    credentials: (profileId: string): Promise<RdpCredentials> =>
      ipcRenderer.invoke('rdp:credentials', profileId),
    /** 读取 WASM 字节（打包后 file:// 下 fetch 不可用，靠它加载 ironrdp-wasm） */
    wasm: (): Promise<Uint8Array> => ipcRenderer.invoke('rdp:wasm')
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
    /** 拉取 OpenAI 兼容接口的模型列表（GET {baseURL}/models）；编辑已有配置时传 configId 以复用存储的 key */
    listRemoteModels: (input: { baseURL: string; apiKey?: string; configId?: string }): Promise<string[]> =>
      ipcRenderer.invoke('ai:listRemoteModels', input),
    chat: (req: AiChatRequest): Promise<{ requestId: string }> =>
      ipcRenderer.invoke('ai:chat', req),
    abort: (requestId: string): Promise<void> =>
      ipcRenderer.invoke('ai:abort', requestId),
    onChatEvent: (cb: (payload: { requestId: string; event: AiStreamEvent }) => void) =>
      subscribe('ai:chat-event', cb),
    /** 确认模式下收到命令执行确认请求 */
    onConfirmRequest: (cb: (req: AiConfirmRequest) => void) => subscribe('ai:confirm', cb),
    /** 确认已有结论（用户回复走本地移除；中止 / 回合结束由主进程通知移除卡片） */
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
    }): Promise<AgentWorkspace[]> => ipcRenderer.invoke('agent:workspaces:save', input),
    deleteWorkspace: (id: string): Promise<AgentWorkspace[]> =>
      ipcRenderer.invoke('agent:workspaces:delete', id),
    /** 全部会话（含 mastra 会话的消息历史），渲染端按 workspaceId 归到各工作区下 */
    listConversations: (): Promise<AgentConversation[]> =>
      ipcRenderer.invoke('agent:conversations:list'),
    /** 新建（不传 id）或更新会话，返回保存后的那一个（不回传全量列表） */
    saveConversation: (input: {
      id?: string
      workspaceId: string
      /** 会话形态：mastra（自带 agent，消息本地存）/ acp（外部 agent，消息归它自己管） */
      kind?: AgentBackend
      title?: string
      /** 仅 mastra 有意义；ACP 会话的消息由 agent 管理，本地一律不保存 */
      messages?: AgentChatMessage[]
      configId?: string
      modelId?: string
      acpAgentId?: string
      acpSessionId?: string
    }): Promise<AgentConversation> => ipcRenderer.invoke('agent:conversations:save', input),
    deleteConversation: (id: string): Promise<void> =>
      ipcRenderer.invoke('agent:conversations:delete', id),
    chat: (req: AgentChatRequest): Promise<{ requestId: string }> =>
      ipcRenderer.invoke('agent:chat', req),
    abort: (requestId: string): Promise<void> => ipcRenderer.invoke('agent:abort', requestId),
    /**
     * ACP（外部 agent）：会话由 agent 自己管理，本应用只做「发现 → 导入 → 绑定」。
     * 检测 / 会话列表 / 删除都走临时连接，用完即杀。
     */
    acp: {
      /** 扫描本机 PATH 里已安装的已知 ACP agent */
      detect: (): Promise<DetectedAcpAgent[]> => ipcRenderer.invoke('agent:acp:detect'),
      /** 拉取某个 agent 侧的会话列表（`session/list`）；cwd 用于按工作区目录过滤 */
      listSessions: (payload: { acpAgentId: string; cwd?: string }): Promise<AcpSessionInfo[]> =>
        ipcRenderer.invoke('agent:acp:listSessions', payload),
      /** 向 agent 询问可用模型（临时建连读 configOptions）；agent 不上报时返回 null */
      listModels: (acpAgentId: string): Promise<AcpModelList | null> =>
        ipcRenderer.invoke('agent:acp:listModels', acpAgentId),
      /** 让 agent 删掉它那边的会话（`session/delete`）；删除会话时可选 */
      deleteSession: (payload: { acpAgentId: string; sessionId: string }): Promise<void> =>
        ipcRenderer.invoke('agent:acp:deleteSession', payload),
      /** 打开 ACP 会话：让 agent 用 `session/load` 回放历史（本地不落盘） */
      load: (payload: {
        workspaceId: string
        conversationId: string
        acpAgentId?: string
        acpSessionId?: string
        modelId?: string
      }): Promise<{ requestId: string }> => ipcRenderer.invoke('agent:acp:load', payload),
      /** 切换某个 ACP 会话的模型（`session/set_config_option`，不重建会话） */
      setModel: (payload: { conversationId: string; modelId?: string }): Promise<void> =>
        ipcRenderer.invoke('agent:acp:setModel', payload),
      /**
       * 会话就绪（新建 / 载入）后的状态推送：agent 侧会话 id + 可切换的模型列表。
       * 新建的 ACP 会话靠它把 `session/new` 返回的 id 落盘。
       */
      onState: (cb: (state: AcpConversationState) => void) => subscribe('agent:acp-state', cb)
    },
    /**
     * 流事件。`conversationId` 由主进程补上：事件可能早于 `chat()` 的返回值到达，
     * 渲染端不能只靠自己那张 requestId → 会话 的表（见 ipc/agent.ts）。
     */
    onChatEvent: (
      cb: (payload: { requestId: string; conversationId?: string; event: AgentStreamEvent }) => void
    ) => subscribe('agent:chat-event', cb),
    /** 确认模式下收到改动类工具的确认请求（执行命令 / 写入 / 编辑 / 删除） */
    onConfirmRequest: (cb: (req: AgentConfirmRequest) => void) => subscribe('agent:confirm', cb),
    /** 确认已有结论（中止 / 回合结束由主进程通知移除卡片） */
    onConfirmResolved: (cb: (payload: { id: string }) => void) =>
      subscribe('agent:confirm-resolved', cb),
    /** 回复确认请求：approved=true 执行，false 取消 */
    resolveConfirm: (id: string, approved: boolean): Promise<void> =>
      ipcRenderer.invoke('agent:confirm:resolve', { id, approved }),
    /** 工作区文件（右侧文件树 / 编辑器）：列表懒加载，一次读一层 */
    fs: {
      /** 列出某目录的直接子项；dir 为空表示工作区根 */
      list: (workspaceId: string, dir?: string): Promise<AgentFsEntry[]> =>
        ipcRenderer.invoke('agent:fs:list', { workspaceId, dir }),
      read: (workspaceId: string, path: string): Promise<AgentFsFile> =>
        ipcRenderer.invoke('agent:fs:read', { workspaceId, path }),
      write: (workspaceId: string, path: string, content: string): Promise<void> =>
        ipcRenderer.invoke('agent:fs:write', { workspaceId, path, content })
    },
    /**
     * 工作区目录配置（`<工作区>/.dogi/workspace.json`）：快捷功能等跟着项目走的配置。
     * 读写都在主进程直接操作该文件，不进 electron-store。
     */
    config: {
      /** 读取配置；目录 / 文件缺失会就地补齐 */
      get: (workspaceId: string): Promise<WorkspaceConfigSnapshot> =>
        ipcRenderer.invoke('agent:workspace:config:get', workspaceId),
      /** 整体覆盖保存（内容会在主进程规整一遍） */
      save: (workspaceId: string, config: WorkspaceConfig): Promise<WorkspaceConfigSnapshot> =>
        ipcRenderer.invoke('agent:workspace:config:save', { workspaceId, config })
    }
  },
  /**
   * `ask_followup_question` 提问卡：Agent 页与终端 AI 助手共用一组通道（broker 是全局单例，
   * 渲染端按 toolCallId 定位卡片，不按来源区分）。
   */
  followup: {
    /** 收到一张待回答的提问表单卡 */
    onRequest: (cb: (req: AskFollowupRequest) => void) => subscribe('followup:request', cb),
    /** 已有结论（用户作答 / 超时 / 中止）：移除卡片 */
    onResolved: (cb: (payload: { id: string; toolCallId: string }) => void) =>
      subscribe('followup:resolved', cb),
    /** 提交回答；传 null 表示跳过 */
    resolve: (id: string, answer: AskFollowupAnswer | null): Promise<void> =>
      ipcRenderer.invoke('followup:resolve', { id, answer })
  },
  mcp: {
    list: (): Promise<McpServerConfig[]> => ipcRenderer.invoke('mcp:list'),
    save: (server: McpServerConfig): Promise<McpServerConfig[]> =>
      ipcRenderer.invoke('mcp:save', server),
    remove: (id: string): Promise<McpServerConfig[]> => ipcRenderer.invoke('mcp:delete', id),
    listTools: (): Promise<{ tools: McpToolInfo[]; errors: string[] }> =>
      ipcRenderer.invoke('mcp:tools'),
    serverTools: (
      id: string
    ): Promise<{ tools: McpToolInfo[]; error?: string }> =>
      ipcRenderer.invoke('mcp:serverTools', id)
  },
  /** 技能（Agent Skills 约定：目录 + SKILL.md）：磁盘自动发现 + 启停 / 额外目录设置 */
  skills: {
    /** 扫描技能；传工作区 id 时连它的 `<工作区>/.dogi/skills` 一起扫 */
    list: (workspaceId?: string): Promise<SkillListResult> =>
      ipcRenderer.invoke('skills:list', workspaceId),
    saveSettings: (patch: Partial<SkillSettings>): Promise<SkillSettings> =>
      ipcRenderer.invoke('skills:saveSettings', patch)
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
      ipcRenderer.invoke('notes:groups:delete', id, deleteNotes),
    /** 打开本地笔记目录（可多选）：返回选中的目录绝对路径与各自的 Markdown 文件树 */
    openFolder: (): Promise<{ roots: string[]; trees: Record<string, NoteFileItem[]> } | null> =>
      ipcRenderer.invoke('notes:openFolder'),
    /** 上次打开的笔记目录与文件（启动时恢复用） */
    getSession: (): Promise<NoteSession> => ipcRenderer.invoke('notes:session:get'),
    /** 保存笔记会话（只传变化的部分：folders 或 files） */
    saveSession: (patch: { folders?: string[]; files?: string[] }): Promise<NoteSession> =>
      ipcRenderer.invoke('notes:session:save', patch),
    /** 读取文件夹内指定文件（filePath 为相对路径） */
    readFile: (root: string, filePath: string): Promise<NoteFileContent> =>
      ipcRenderer.invoke('notes:readFile', root, filePath),
    /** 保存内容到文件（filePath 为绝对路径） */
    saveFile: (filePath: string, content: string): Promise<{ mtime: number }> =>
      ipcRenderer.invoke('notes:saveFile', filePath, content),
    /** 新建笔记文件（root 为空时弹保存框） */
    newFile: (root: string, dirPath: string): Promise<NoteFileContent> =>
      ipcRenderer.invoke('notes:newFile', root, dirPath),
    /** 刷新已打开的文件夹，返回更新后的文件树 */
    refreshFolder: (root: string): Promise<NoteFileItem[]> =>
      ipcRenderer.invoke('notes:refreshFolder', root),
    /** 重命名文件（在已打开的文件夹内） */
    renameFile: (root: string, oldPath: string, newName: string): Promise<string> =>
      ipcRenderer.invoke('notes:renameFile', root, oldPath, newName),
    /** 删除文件（从已打开的文件夹中移除） */
    deleteFile: (root: string, filePath: string): Promise<void> =>
      ipcRenderer.invoke('notes:deleteFile', root, filePath)
  },
  /**
   * 浏览器会话控制（Agent 的浏览器工具与内嵌面板共用）。画面走 screencast 帧流
   * （onFrame），输入靠 input() 转发 —— 浏览器本身是无窗口跑的，面板里看到的就是这一路帧。
   */
  browser: {
    /** 启动会话；mode 是视口预设（PC / 手机），与面板尺寸无关 */
    open: (payload: {
      sessionId: string
      url?: string
      mode?: BrowserViewportMode
    }): Promise<BrowserSessionState> => ipcRenderer.invoke('browser:open', payload),
    close: (sessionId: string): Promise<void> => ipcRenderer.invoke('browser:close', sessionId),
    state: (sessionId: string): Promise<BrowserSessionState | null> =>
      ipcRenderer.invoke('browser:state', sessionId),
    navigate: (sessionId: string, url: string): Promise<void> =>
      ipcRenderer.invoke('browser:navigate', { sessionId, url }),
    back: (sessionId: string): Promise<void> => ipcRenderer.invoke('browser:back', sessionId),
    forward: (sessionId: string): Promise<void> => ipcRenderer.invoke('browser:forward', sessionId),
    reload: (sessionId: string): Promise<void> => ipcRenderer.invoke('browser:reload', sessionId),
    /** 合成输入（鼠标 / 滚轮 / 键盘 / 文本），坐标须为页面视口坐标 */
    input: (sessionId: string, event: BrowserInputEvent): Promise<void> =>
      ipcRenderer.invoke('browser:input', { sessionId, event }),
    /** 切换视口预设（PC / 手机） */
    viewport: (sessionId: string, mode: BrowserViewportMode): Promise<void> =>
      ipcRenderer.invoke('browser:viewport', { sessionId, mode }),
    onFrame: (cb: (frame: BrowserFrame) => void): Unsubscribe =>
      subscribe('browser:frame', cb),
    onState: (cb: (state: BrowserSessionState) => void): Unsubscribe =>
      subscribe('browser:state', cb),
    onClosed: (cb: (payload: { sessionId: string; reason: string }) => void): Unsubscribe =>
      subscribe('browser:closed', cb)
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
    /** sendId 由渲染端生成（一次请求一个），配合 abort 手动取消进行中的请求 */
    send: (req: ApiHttpRequest, sendId?: string): Promise<ApiHttpResponse> =>
      ipcRenderer.invoke('api:send', req, sendId),
    abort: (sendId: string): Promise<void> => ipcRenderer.invoke('api:abort', sendId),
    /**
     * 为 form-data 的文件字段选本地文件（弹系统对话框，主进程顺手 stat 出名字与大小）。
     * 只是选路径：文件内容由 send 在主进程侧读。
     */
    pickFile: (): Promise<ApiPickFileResult> => ipcRenderer.invoke('api:pickFile')
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
      ipcRenderer.invoke('prefs:save', patch),
    /** 偏好变更广播（主进程保存后推给所有渲染端窗口，跨窗口同步生效） */
    onUpdated: (cb: (prefs: Preferences) => void) =>
      subscribe('prefs:updated', cb)
  },
  /** 数据导入 / 导出（左下角菜单）：主机 / 笔记 / 接口请求 打成 zip 或从 zip 导回 */
  transfer: {
    /**
     * 导出：弹出保存对话框，把选中的类型各写成一个 JSON 后打包成 zip。
     * 凭据（密码 / 私钥 / 口令）不导出 —— 它们是 safeStorage 加密的，只在本机可用。
     */
    export: (kinds: TransferKind[]): Promise<TransferExportResult> =>
      ipcRenderer.invoke('transfer:export', kinds),
    /** 导入第一步：选 zip 并解析，返回可导入项摘要（内容留在主进程，靠 bundleId 引用） */
    pick: (): Promise<TransferPickResult> => ipcRenderer.invoke('transfer:pick'),
    /** 导入第二步：把勾选的类型写回库（按 id upsert） */
    import: (bundleId: string, kinds: TransferKind[]): Promise<TransferImportResult> =>
      ipcRenderer.invoke('transfer:import', bundleId, kinds),
    /** 放弃这次导入（丢掉主进程里暂存的内容） */
    cancel: (bundleId: string): Promise<void> => ipcRenderer.invoke('transfer:cancel', bundleId)
  },
  app: {
    /** 当前平台（同步常量，用于标题栏等 UI 的系统适配） */
    platform: process.platform,
    info: (): Promise<AppInfo> => ipcRenderer.invoke('app:info'),
    /** 用系统默认程序打开外部链接（主进程会按安全协议过滤，避免弹窗） */
    openExternal: (url: string): Promise<void> => ipcRenderer.invoke('app:openExternal', url),
    /**
     * 取拖入文件的本地绝对路径。Electron 32 起 `File.path` 已移除，
     * 必须在 preload 里用 `webUtils.getPathForFile` 包一层（官方推荐做法）；
     * 非真实文件（如程序构造的 File）返回空串，调用方需过滤。
     */
    getPathForFile: (file: File): string => webUtils.getPathForFile(file),
    /**
     * 发一条系统通知。**是否真的弹由主进程判定**：应用在前台时不打扰，
     * 通知开关也读偏好；返回是否弹出。
     */
    notify: (notice: { title: string; body: string }): Promise<boolean> =>
      ipcRenderer.invoke('app:notify', notice),
    /**
     * 退出前主进程请求渲染端把「进行中的状态」落盘（如 Agent 长任务中途退出）。
     * 处理完必须调 `flushDone()` —— 主进程只等一小会儿，等不到就照常退出。
     */
    onFlushRequest: (cb: () => void): Unsubscribe => subscribe('app:flush', cb),
    flushDone: (): Promise<void> => ipcRenderer.invoke('app:flushDone')
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
      subscribe('monitor:data', cb),
    /**
     * 订阅「该主机不支持监控」状态（非 Linux 主机，或采集持续无效）：
     * 每会话最多推送一次终态，渲染端据此展示「不支持监控」标识
     */
    onUnsupported: (cb: (payload: MonitorUnsupportedPayload) => void) =>
      subscribe('monitor:unsupported', cb)
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
      ipcRenderer.invoke('shell:openIde', ideId, dir),
    /** 打开文件位置：目录直接打开，文件在所在目录中选中（不存在时返回 ok:false） */
    revealPath: (path: string): Promise<OpenResult> =>
      ipcRenderer.invoke('shell:revealPath', path)
  },
  /** 源代码管理（git）：以工作区目录为入口，定位仓库根后执行 */
  git: {
    status: (cwd: string): Promise<GitStatusResult> => ipcRenderer.invoke('git:status', cwd),
    branches: (cwd: string): Promise<GitBranchesResult> => ipcRenderer.invoke('git:branches', cwd),
    log: (cwd: string, n?: number): Promise<GitCommit[]> => ipcRenderer.invoke('git:log', cwd, n),
    diff: (cwd: string, path: string, staged: boolean): Promise<string> =>
      ipcRenderer.invoke('git:diff', cwd, path, staged),
    action: (cwd: string, action: GitAction): Promise<string> =>
      ipcRenderer.invoke('git:action', cwd, action),
    /** 列出一个目录条目（未跟踪的目录 / 嵌套仓库）里的文件，仅用于展示 */
    dirList: (cwd: string, path: string): Promise<string[]> =>
      ipcRenderer.invoke('git:dirList', cwd, path)
  }
}

export type Api = typeof api

contextBridge.exposeInMainWorld('api', api)
