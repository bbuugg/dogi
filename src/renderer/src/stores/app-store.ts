import { create } from 'zustand'
import type {
  AiChatMessage,
  AiConfirmRequest,
  AiMessagePart,
  AiModelConfig,
  AiPermissionMode,
  AiSettings,
  AiStreamEvent,
  ColorThemeName,
  Preferences,
  ServerMetrics,
  SessionInfo,
  ShellDetectResult,
  ScriptEntry,
  ShortcutConfig,
  SshConnectProgress,
  SshGroup,
  SshProfile,
  TerminalThemeName,
  ThemeMode
} from '@shared/types'
import type { AppShortcutAction } from '@shared/types'
import type { PluginInfo } from '@shared/plugin'
import type { PluginViewInstance } from '@/plugins/host'
import { DEFAULT_SHORTCUTS } from '@shared/shortcuts'
import {
  HOSTS_ACTIVITY_ID,
  SCRIPTS_ACTIVITY_ID,
  pluginViewIdOf
} from '@/activity-ids'
import { clampTerminalFontSize } from '@/lib/terminal-font'
import { scriptToTerminalInput } from '@/lib/script'
import { applyColorTheme } from '@/lib/theme'
import {
  firstGroupId,
  genPaneId,
  insertSibling,
  makeLeaf,
  removeLeaf,
  updateSizes,
  type PaneNode,
  type SplitDirectionInput
} from '@/lib/pane-layout'

/** 打开一个已保存的主机会话：主进程按主机类型（ssh / local）决定启动方式 */
function openSession(profileId: string, cols = 80, rows = 24): Promise<SessionInfo> {
  return window.api.terminal.createFromProfile(profileId, cols, rows)
}

/** 终端字号持久化写入的防抖句柄（Ctrl+滚轮会触发连续调整） */
let fontSizeSaveTimer: number | undefined

/**
 * 插件被禁用 / 卸载 / 重载后，若当前功能区指向的插件视图已不存在，回到主机功能区。
 */
function fallbackFromMissingPlugin(
  ui: UiState,
  plugins: PluginViewInstance[]
): UiState {
  const viewId = pluginViewIdOf(ui.activeActivity)
  if (!viewId || plugins.some((p) => p.viewId === viewId)) return ui
  return { ...ui, activeActivity: HOSTS_ACTIVITY_ID }
}

/** 重连中的旧会话 ID：其 onClosed 事件不应从布局摘掉面板（会被新会话原地替换） */
const reconnectingIds = new Set<string>()

/** 单个终端会话独立的 AI 对话状态 */
export interface AiChatState {
  messages: AiChatMessage[]
  streaming: boolean
  /** 进行中的对话请求 id（用于事件路由与中止） */
  requestId: string | null
  error: string | null
}

function emptyAiChat(): AiChatState {
  return { messages: [], streaming: false, requestId: null, error: null }
}

/** requestId -> sessionId：把流式事件路由到发起对话的那个会话 */
const aiRequestSessions = new Map<string, string>()

/** AI 回复生成中的占位 assistant 消息尾部追加 part */
function appendAssistantPart(
  parts: AiMessagePart[],
  event: AiStreamEvent
): AiMessagePart[] {
  const next = [...parts]
  if (event.type === 'text-delta') {
    const last = next[next.length - 1]
    if (last?.type === 'text') {
      next[next.length - 1] = { type: 'text', text: last.text + event.delta }
    } else {
      next.push({ type: 'text', text: event.delta })
    }
  } else if (event.type === 'tool-call') {
    next.push({
      type: 'tool-call',
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      input: event.input
    })
  } else if (event.type === 'tool-result') {
    next.push({
      type: 'tool-result',
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      output: event.output,
      isError: event.isError
    })
  } else if (event.type === 'error') {
    next.push({ type: 'text', text: `\n\n⚠️ ${event.message}` })
  }
  return next
}

/** 从组中摘掉某会话；若组因此变空则返回被移除的组 ID */
function withoutSession(
  groups: Record<string, EditorGroup>,
  id: string
): { groups: Record<string, EditorGroup>; removedGroupId: string | null } {
  const next: Record<string, EditorGroup> = { ...groups }
  let removedGroupId: string | null = null
  for (const gid of Object.keys(next)) {
    const g = next[gid]
    if (!g.sessionIds.includes(id)) continue
    const sessionIds = g.sessionIds.filter((x) => x !== id)
    if (sessionIds.length === 0) {
      delete next[gid]
      removedGroupId = gid
    } else {
      next[gid] = {
        ...g,
        sessionIds,
        activeSessionId: g.activeSessionId === id ? sessionIds[sessionIds.length - 1] : g.activeSessionId
      }
    }
    break
  }
  return { groups: next, removedGroupId }
}

/** 关闭会话后统一维护：更新组、从布局摘掉空组、折叠单子节点、重选焦点 */
function applyTabClose(
  s: Pick<
    AppStore,
    | 'sessions'
    | 'layout'
    | 'groups'
    | 'activeGroupId'
    | 'activeSessionId'
    | 'exitedSessions'
    | 'monitors'
    | 'aiChats'
    | 'connectStages'
  >,
  id: string
): Partial<AppStore> {
  const sessions = s.sessions.filter((x) => x.id !== id)
  const { groups, removedGroupId } = withoutSession(s.groups, id)
  const layout = removedGroupId ? removeLeaf(s.layout, removedGroupId) : s.layout
  const activeGroupId =
    s.activeGroupId && groups[s.activeGroupId]
      ? s.activeGroupId
      : (firstGroupId(layout) ?? Object.keys(groups)[0] ?? null)
  const activeSessionId = activeGroupId ? (groups[activeGroupId]?.activeSessionId ?? null) : null
  const exited = new Set(s.exitedSessions)
  exited.delete(id)
  const monitors = { ...s.monitors }
  delete monitors[id]
  // 会话关闭，其独立的 AI 对话随之清理
  const aiChats = { ...s.aiChats }
  delete aiChats[id]
  // 连接进度也随之清理
  const connectStages = { ...s.connectStages }
  delete connectStages[id]
  return {
    sessions,
    groups,
    layout,
    activeGroupId,
    activeSessionId,
    exitedSessions: exited,
    monitors,
    aiChats,
    connectStages
  }
}

interface UiState {
  /** 各编辑器组是否打开其内置 AI 助手（key 为 groupId；AI 属于终端组而非全局） */
  aiOpenGroups: Record<string, boolean>
  settingsOpen: boolean
  /** 编辑中的 SSH 配置（null=新建，undefined=关闭）；groupId 为新建时预设的分组 */
  sshDialog: { open: boolean; editing?: SshProfile | null; groupId?: string }
  /** 运行脚本对话框：scriptId 为预设脚本（可空，在对话框内选择） */
  runScriptDialog: { open: boolean; scriptId?: string }
  settingsTab: 'ai' | 'terminal' | 'prefs' | 'shortcuts'
  /** 是否打开命令面板（Ctrl+Shift+P：脚本、终端、主机、设置等命令入口） */
  commandPaletteOpen: boolean
  /**
   * 当前激活的功能区 id（活动栏选中的 tab，导航的唯一真源）：
   * 主区域显示什么、侧边栏显示哪个面板都由它派生（见 src/renderer/src/activities.tsx）。
   * id 失效（插件被卸载等）时回退到第一个内置功能区。
   */
  activeActivity: string
  /** 各功能区的侧边栏是否折叠（key 为功能区 id；侧边栏属于功能区，互不影响） */
  collapsedActivities: Record<string, boolean>
  /** 侧边栏宽度（px） */
  sidebarWidth: number
  /** AI 助手面板宽度（px） */
  aiPanelWidth: number
}

/** 编辑器组：承载多个会话（标签页），并指向当前激活的会话 */
interface EditorGroup {
  id: string
  sessionIds: string[]
  activeSessionId: string | null
}

interface AppStore {
  // ---------- 终端 ----------
  sessions: SessionInfo[]
  activeSessionId: string | null
  exitedSessions: Set<string>
  /**主机中的会话阶段（key 为 sessionId；连接就绪/失败/关闭后移除） */
  connectStages: Record<string, SshConnectProgress>
  /** 分屏布局树：每个叶子承载一个编辑器组；null 表示尚无任何会话 */
  layout: PaneNode | null
  /** 所有编辑器组，key 为组 ID */
  groups: Record<string, EditorGroup>
  /** 当前聚焦的组 ID（决定拆分/新建终端落在哪个组，以及监控/AI 的上下文） */
  activeGroupId: string | null

  // ---------- SSH ----------
  profiles: SshProfile[]
  /**主机分组（侧边栏归类用） */
  sshGroups: SshGroup[]

  // ---------- 用户脚本 ----------
  scripts: ScriptEntry[]

  // ---------- 偏好 ----------
  preferences: Preferences
  /** 全局快捷键配置（动作 -> accelerator），主进程据此注册系统级快捷键 */
  shortcuts: ShortcutConfig[]
  /** 本地可用 shell 检测结果（null = 尚未加载） */
  shells: ShellDetectResult | null

  // ---------- AI ----------
  aiConfigs: AiModelConfig[]
  aiSettings: AiSettings
  /** 每个终端会话独立的 AI 对话（key 为 sessionId，互不影响） */
  aiChats: Record<string, AiChatState>
  /** 确认模式下等待用户处理的命令执行请求（key 为确认 id；各会话实例独立弹卡） */
  pendingConfirms: Record<string, AiConfirmRequest>

  // ---------- UI ----------
  ui: UiState

  // ---------- 插件（运行时加载外部插件） ----------
  /** 已加载插件的视图实例（侧边栏入口 + 主区域渲染组件） */
  plugins: PluginViewInstance[]
  /** 插件管理页列表（含启用状态/加载错误），与 plugins 分开以支撑管理操作 */
  pluginList: PluginInfo[]
  /** 插件通过宿主注册的命令面板命令 */
  pluginCommands: Record<string, { pluginId: string; title: string; run: () => void }>

  // ---------- 服务器监控 ----------
  /** 各会话最新指标，key 为 sessionId；无该 key 表示取不到数据（不显示指标） */
  monitors: Record<string, ServerMetrics>

  bootstrap: () => Promise<void>
  /** 创建本地终端：不传 shellId 时使用偏好设置的默认本地终端 */
  createLocalSession: (shellId?: string) => Promise<void>
  /** 连接一个已保存的主机（ssh 远程 / local 本地），返回新会话信息 */
  connectHost: (profile: SshProfile) => Promise<SessionInfo>
  /** 连接指定主机并在其上执行脚本：连接就绪后把脚本写入该会话，返回是否执行成功 */
  runScriptOnHost: (profile: SshProfile, script: ScriptEntry) => Promise<boolean>
  closeSession: (id: string) => Promise<void>
  /** 会话结束后重连：按原类型/SSH 配置新建一个会话并替换旧的 */
  reconnectSession: (id: string) => Promise<void>
  setActiveSession: (id: string) => void
  /** 聚焦某个编辑器组 */
  setActiveGroup: (groupId: string) => void
  /** 向当前激活组的上/下/左/右拆分出新组（镜像其会话类型） */
  splitActivePane: (direction: SplitDirectionInput) => Promise<void>
  /** 将某个会话（标签）移动到目标组；源组若因此变空则从布局中移除 */
  moveSessionToGroup: (sessionId: string, targetGroupId: string) => void
  /** 组内重排：把 sessionId 移到组内 toIndex（相对重排前）位置 */
  reorderSessions: (groupId: string, sessionId: string, toIndex: number) => void
  /** 关闭整个组（含其全部会话） */
  closeGroup: (groupId: string) => Promise<void>
  /** 拖拽分隔条时更新某分隔节点的权重 */
  resizeSplit: (splitId: string, sizes: number[]) => void
  refreshProfiles: () => Promise<void>
  /** 新建（不传 id）或重命名（传 id）SSH 分组；color 为 undefined 保留原色，null 清除 */
  saveSshGroup: (input: { id?: string; name: string; color?: string | null }) => Promise<void>
  /** 设置连接的强调色（null 清除，回到继承所属分组） */
  setSshProfileColor: (id: string, color: string | null) => Promise<void>
  /** 删除分组；deleteProfiles=true 时连同组内连接一起删除，否则组内连接回到「未分组」 */
  deleteSshGroup: (id: string, deleteProfiles?: boolean) => Promise<void>
  /** 拖拽排序 / 换组后的整体重排：数组顺序即显示顺序 */
  arrangeSsh: (payload: {
    groupIds: string[]
    profiles: Array<{ id: string; groupId?: string }>
  }) => Promise<void>

  setGroupAiOpen: (groupId: string, open: boolean) => void
  setSettingsOpen: (open: boolean, tab?: UiState['settingsTab']) => void
  setCommandPaletteOpen: (open: boolean) => void
  /** 切换功能区（活动栏 tab）：主区域与侧边栏都由它派生，不再单独存 view */
  selectActivity: (id: string) => void
  /** 运行时加载插件（扫描 userData/plugins，收集视图注入 store） */
  loadPlugins: () => Promise<void>
  /** 刷新插件管理页列表（manifest + 启用状态 + 错误） */
  refreshPluginList: () => Promise<void>
  /** 启用/禁用插件并刷新视图与列表 */
  togglePluginEnabled: (id: string, enabled: boolean) => Promise<void>
  /** 卸载插件并刷新视图与列表 */
  uninstallPlugin: (id: string) => Promise<void>
  /** 从文件/目录安装插件并刷新视图与列表 */
  installPlugin: (sourcePath: string) => Promise<void>
  /** 重新加载插件（不传 id 表示全部）并刷新视图与列表，无需重启应用 */
  reloadPlugins: (id?: string) => Promise<void>
  /** 插件注册的命令面板命令 */
  registerPluginCommand: (
    pluginId: string,
    cmd: { id: string; title: string; run: () => void }
  ) => void
  setSidebarWidth: (width: number) => void
  /** 折叠/展开「当前功能区」自己的侧边栏（侧边栏属于功能区，互不影响） */
  setSidebarCollapsed: (collapsed: boolean) => void
  setAiPanelWidth: (width: number) => void
  refreshScripts: () => Promise<void>
  /** 打开/关闭 SSH 配置弹窗（editing=null 为新建；groupId 预设新建时的分组） */
  setSshDialog: (open: boolean, editing?: SshProfile | null, groupId?: string) => void
  /** 打开/关闭「运行脚本」对话框（可预设要运行的脚本） */
  setRunScriptDialog: (open: boolean, scriptId?: string) => void
  refreshAiConfigs: () => Promise<void>
  setActiveAiConfig: (id: string) => Promise<void>
  saveAiSettings: (patch: Partial<AiSettings>) => Promise<void>
  setAiPermissionMode: (mode: AiPermissionMode) => Promise<void>
  resolveAiConfirm: (id: string, approved: boolean) => Promise<void>
  setTheme: (mode: ThemeMode) => Promise<void>
  /** 设置界面配色方案（强调色，立即生效并持久化）；custom 时传入自定义色值 */
  setColorTheme: (name: ColorThemeName, customColor?: string) => Promise<void>
  setTerminalTheme: (name: TerminalThemeName) => Promise<void>
  setCopyOnSelect: (enabled: boolean) => Promise<void>
  setRightClickPaste: (enabled: boolean) => Promise<void>
  setCommandPrediction: (enabled: boolean) => Promise<void>
  /** 关闭窗口时是否最小化到系统托盘（持久化到偏好设置） */
  setMinimizeToTray: (enabled: boolean) => Promise<void>
  /** 设置本地终端默认 shell（持久化到偏好设置） */
  setLocalShell: (shellId: string) => Promise<void>
  setTerminalFontSize: (size: number) => Promise<void>
  /** 设置服务器指标采集间隔（毫秒）：立即生效并持久化 */
  /** 保存快捷键配置（持久化到主进程并立即重注册系统级快捷键） */
  saveShortcuts: (shortcuts: ShortcutConfig[]) => Promise<void>
  setMonitorInterval: (ms: number) => Promise<void>
  sendAiMessage: (text: string, targetSessionId?: string | null) => Promise<void>
  abortAi: (sessionId: string) => Promise<void>
  clearAiMessages: (sessionId: string) => void
  handleAiEvent: (requestId: string, event: AiStreamEvent) => void
}

let listenersBound = false

export const useAppStore = create<AppStore>()((set, get) => {
/** 全局快捷键监听器仅注册一次，避免 HMR / 重复 bootstrap 叠加 */
let shortcutWired = false
  if (!listenersBound && typeof window !== 'undefined' && window.api) {
    listenersBound = true
    // 会话输出退出等事件 -> 更新状态（数据本身由 TerminalView 自行订阅）
    window.api.terminal.onExit(({ sessionId }) => {
      set((s) => {
        const exited = new Set(s.exitedSessions)
        exited.add(sessionId)
        // 连接失败/中断：清掉进度，让终端里的失败提示露出来
        const connectStages = { ...s.connectStages }
        delete connectStages[sessionId]
        return { exitedSessions: exited, connectStages }
      })
    })
    //主机阶段：就绪即移除（渲染端据此收起进度提示）
    window.api.terminal.onStatus((payload) => {
      set((s) => {
        const connectStages = { ...s.connectStages }
        if (payload.stage === 'ready') delete connectStages[payload.sessionId]
        else connectStages[payload.sessionId] = payload
        return { connectStages }
      })
    })
    window.api.terminal.onClosed(({ sessionId }) => {
      if (reconnectingIds.has(sessionId)) return
      set((s) => applyTabClose(s, sessionId))
    })
    window.api.ai.onChatEvent(({ requestId, event }) => {
      get().handleAiEvent(requestId, event)
    })
    window.api.ai.onConfirmRequest((req) => {
      // 每个会话的助手实例独立弹卡（同一实例内已由主进程串行化）
      set((s) => ({ pendingConfirms: { ...s.pendingConfirms, [req.id]: req } }))
    })
    // 确认已有结论（超时 / 中止等非用户路径）：移除对应卡片
    window.api.ai.onConfirmResolved(({ id }) => {
      set((s) => {
        if (!(id in s.pendingConfirms)) return {}
        const next = { ...s.pendingConfirms }
        delete next[id]
        return { pendingConfirms: next }
      })
    })
    window.api.monitor.onData(({ sessionId, metrics }) => {
      set((s) => ({ monitors: { ...s.monitors, [sessionId]: metrics } }))
    })
  }

  return {
    sessions: [],
    activeSessionId: null,
    exitedSessions: new Set(),
    connectStages: {},
    layout: null,
    groups: {},
    activeGroupId: null,

    profiles: [],
    sshGroups: [],

    scripts: [],

    preferences: { theme: 'system', colorTheme: 'neutral', customColor: '#3b82f6', terminalTheme: 'auto', copyOnSelect: true, rightClickPaste: true, commandPrediction: true, terminalFontSize: 13, localShell: 'default', minimizeToTray: true, monitorInterval: 2000 },

    shortcuts: DEFAULT_SHORTCUTS,

    shells: null,

    aiConfigs: [],
    aiSettings: { permissionMode: 'full' },
    aiChats: {},
    pendingConfirms: {},

    plugins: [],
    pluginList: [],
    pluginCommands: {},

    ui: {
      aiOpenGroups: {},
      settingsOpen: false,
      sshDialog: { open: false, editing: null },
      runScriptDialog: { open: false },
      settingsTab: 'prefs',
      commandPaletteOpen: false,
      activeActivity: HOSTS_ACTIVITY_ID,
      collapsedActivities: {},
      sidebarWidth: 240,
      aiPanelWidth: 350
    },

    monitors: {},

    bootstrap: async () => {
      const [profiles, sshGroups, configs, settings, preferences, shells, scripts, shortcuts] = await Promise.all([
        window.api.ssh.list(),
        window.api.ssh.listGroups(),
        window.api.ai.listConfigs(),
        window.api.ai.getSettings(),
        window.api.prefs.get(),
        window.api.terminal.listShells(),
        window.api.scripts.list(),
        window.api.shortcuts.get()
      ])
      // 配色必须在偏好写进 store 之前落到 html 上：antd 的 token 是在 store 更新引发的那次
      // 重渲染里从 CSS 变量读出来的，晚一步就会永远停在默认中性配色（直到用户手动切换）
      applyColorTheme(preferences.colorTheme, preferences.customColor)
      set({
        profiles,
        sshGroups,
        aiConfigs: configs,
        aiSettings: settings,
        preferences,
        shells,
        scripts,
        shortcuts
      })
      // 运行时加载外部插件（扫描 userData/plugins 并收集视图）
      const { loadPlugins } = await import('@/plugins/host')
      const pluginViews = await loadPlugins()
      const pluginList = await window.api.plugins.list()
      set({ plugins: pluginViews, pluginList })
      // 有插件加载失败时给出一次性提示（详情见插件管理页）
      const failedPlugins = pluginList.filter((p) => p.error)
      if (failedPlugins.length > 0) {
        const { message } = await import('antd')
        message.error(
          `${failedPlugins.length} 个插件加载失败：${failedPlugins.map((p) => p.name).join('、')}`
        )
      }
      // 全局快捷键：主进程触发后在此分发到具体 UI 动作
      if (!shortcutWired) {
        shortcutWired = true
        window.api.app.onShortcut((action: AppShortcutAction) => {
          const s = get()
          if (action === 'open-settings') s.setSettingsOpen(true)
          else if (action === 'new-session') void s.createLocalSession()
          else if (action === 'open-command-palette') s.setCommandPaletteOpen(true)
          else if (action === 'toggle-ai-panel') {
            // AI 属于终端组：作用于当前激活组
            const gid = s.activeGroupId
            if (gid) s.setGroupAiOpen(gid, !s.ui.aiOpenGroups[gid])
          }
          else if (action === 'open-scripts') s.selectActivity(SCRIPTS_ACTIVITY_ID)
        })
      }
    },

    createLocalSession: async (shellId) => {
      const info = await window.api.terminal.createLocal(80, 24, shellId)
      set((s) => {
        const groups = { ...s.groups }
        let activeGroupId = s.activeGroupId ?? firstGroupId(s.layout)
        // 无可用组：新建一个组并放入布局（若已有布局则整体重置为该组）
        if (!activeGroupId || !groups[activeGroupId]) {
          const gid = genPaneId()
          groups[gid] = { id: gid, sessionIds: [info.id], activeSessionId: info.id }
          return {
            sessions: [...s.sessions, info],
            groups,
            layout: makeLeaf(gid),
            activeGroupId: gid,
            activeSessionId: info.id
          }
        }
        // 否则作为新标签页加入当前激活组（VS Code 行为）
        const g = groups[activeGroupId]
        groups[activeGroupId] = {
          ...g,
          sessionIds: [...g.sessionIds, info.id],
          activeSessionId: info.id
        }
        return { sessions: [...s.sessions, info], groups, activeGroupId, activeSessionId: info.id }
      })
      // 切回终端功能区，避免在脚本管理页等其它页面新建后看不到终端
      get().selectActivity(HOSTS_ACTIVITY_ID)
    },

    connectHost: async (profile) => {
      const info = await openSession(profile.id)
      set((s) => {
        const groups = { ...s.groups }
        let activeGroupId = s.activeGroupId ?? firstGroupId(s.layout)
        if (!activeGroupId || !groups[activeGroupId]) {
          const gid = genPaneId()
          groups[gid] = { id: gid, sessionIds: [info.id], activeSessionId: info.id }
          return {
            sessions: [...s.sessions, info],
            groups,
            layout: makeLeaf(gid),
            activeGroupId: gid,
            activeSessionId: info.id
          }
        }
        const g = groups[activeGroupId]
        groups[activeGroupId] = {
          ...g,
          sessionIds: [...g.sessionIds, info.id],
          activeSessionId: info.id
        }
        return { sessions: [...s.sessions, info], groups, activeGroupId, activeSessionId: info.id }
      })
      // 连接后切回终端功能区（连接可能是在脚本管理页等其它页面发起的）
      get().selectActivity(HOSTS_ACTIVITY_ID)
      return info
    },

    runScriptOnHost: async (profile, script) => {
      // connectHost 内部已切回终端功能区
      const info = await get().connectHost(profile)
      return window.api.terminal.runScript(info.id, scriptToTerminalInput(script.content))
    },

    closeSession: async (id) => {
      await window.api.terminal.kill(id)
      // closed 事件会同步状态，双保险
      set((s) => applyTabClose(s, id))
    },

    reconnectSession: async (id) => {
      const old = get().sessions.find((x) => x.id === id)
      if (!old) return
      reconnectingIds.add(id)
      // 按原会话重建：绑定了主机的（ssh 或 local 主机）沿用它，纯本地会话新建默认 shell
      let info: SessionInfo
      if (old.profileId) {
        try {
          info = await openSession(old.profileId)
        } catch {
          // 主机配置可能已删除：退化为普通本地终端
          info = await window.api.terminal.createLocal(80, 24)
        }
      } else {
        info = await window.api.terminal.createLocal(80, 24)
      }
      // 关闭已退出的旧会话（onClosed 已被 reconnectingIds 屏蔽，不会摘掉组）
      await window.api.terminal.kill(id)
      set((s) => {
        // 找到承载该会话的组，原地替换会话 ID（保留组与面板位置）
        const groups = { ...s.groups }
        let targetGid: string | null = null
        for (const gid of Object.keys(groups)) {
          if (groups[gid].sessionIds.includes(id)) {
            targetGid = gid
            break
          }
        }
        if (targetGid) {
          const g = groups[targetGid]
          const wasActive = g.activeSessionId === id
          groups[targetGid] = {
            ...g,
            sessionIds: g.sessionIds.map((x) => (x === id ? info.id : x)),
            activeSessionId: wasActive ? info.id : g.activeSessionId
          }
        }
        const sessions = s.sessions.filter((x) => x.id !== id).concat(info)
        const exited = new Set(s.exitedSessions)
        exited.delete(id)
        // 旧会话的指标随之作废（新会话的指标由主进程重新采集）
        const monitors = { ...s.monitors }
        delete monitors[id]
        // 该会话的 AI 对话随重连迁移到新会话 ID（上下文保留）
        const aiChats = { ...s.aiChats }
        if (aiChats[id]) {
          aiChats[info.id] = aiChats[id]
          delete aiChats[id]
        }
        const activeGroupId = targetGid ?? s.activeGroupId
        const activeSessionId = targetGid ? groups[targetGid].activeSessionId : s.activeSessionId
        return {
          sessions,
          groups,
          activeGroupId,
          activeSessionId,
          exitedSessions: exited,
          monitors,
          aiChats
        }
      })
      reconnectingIds.delete(id)
    },

    splitActivePane: async (direction) => {
      const s = get()
      const activeGroupId = s.activeGroupId
      // 无激活组时退化为新建一个终端
      if (!activeGroupId || !s.groups[activeGroupId]) {
        await get().createLocalSession()
        return
      }
      const g = s.groups[activeGroupId]

      // 组内有多个会话：把当前激活会话「拎出来」放到该方向的新分组，不新建会话
      if (g.sessionIds.length > 1) {
        const movingId = g.activeSessionId ?? g.sessionIds[0]
        set((st) => {
          // 从原组摘掉该会话（原组仍留有其它会话，不会被移除）
          const { groups: afterRemove } = withoutSession(st.groups, movingId)
          const gid = genPaneId()
          const groups = {
            ...afterRemove,
            [gid]: { id: gid, sessionIds: [movingId], activeSessionId: movingId }
          }
          const layout = st.layout
            ? insertSibling(st.layout, activeGroupId, direction, makeLeaf(gid))
            : makeLeaf(gid)
          return { groups, layout, activeGroupId: gid, activeSessionId: movingId }
        })
        return
      }

      // 组内只有一个会话：新建一个同类型会话并拆到该方向（原行为）
      const src =
        s.sessions.find((x) => x.id === g.activeSessionId) ??
        s.sessions.find((x) => g.sessionIds.includes(x.id))
      // 镜像当前组激活会话：绑定了主机（ssh / local 主机）的沿用其配置，纯本地会话新建默认 shell
      const info: SessionInfo = src?.profileId
        ? await openSession(src.profileId)
        : await window.api.terminal.createLocal(80, 24)
      set((st) => {
        const gid = genPaneId()
        const groups = {
          ...st.groups,
          [gid]: { id: gid, sessionIds: [info.id], activeSessionId: info.id }
        }
        // 在激活组旁插入承载新组的叶子
        const layout = st.layout
          ? insertSibling(st.layout, activeGroupId, direction, makeLeaf(gid))
          : makeLeaf(gid)
        return {
          sessions: [...st.sessions, info],
          groups,
          layout,
          activeGroupId: gid,
          activeSessionId: info.id
        }
      })
    },

    moveSessionToGroup: (sessionId, targetGroupId) =>
      set((s) => {
        const srcGid = Object.keys(s.groups).find((k) =>
          s.groups[k].sessionIds.includes(sessionId)
        )
        // 同组内拖动无需处理（当前不支持组内重排）；目标组必须存在
        if (!srcGid || srcGid === targetGroupId || !s.groups[targetGroupId]) return {}

        // 先从源组摘掉该会话（源组变空会被记录为 removedGroupId）
        const { groups: afterRemove, removedGroupId } = withoutSession(s.groups, sessionId)
        const target = afterRemove[targetGroupId]
        if (!target) return {}

        const groups = {
          ...afterRemove,
          [targetGroupId]: {
            ...target,
            sessionIds: [...target.sessionIds, sessionId],
            activeSessionId: sessionId
          }
        }
        const layout = removedGroupId ? removeLeaf(s.layout, removedGroupId) : s.layout
        return { groups, layout, activeGroupId: targetGroupId, activeSessionId: sessionId }
      }),

    // 组内重排：toIndex 指重排前数组中的目标位，先取出后按移除偏移校正
    reorderSessions: (groupId, sessionId, toIndex) =>
      set((s) => {
        const g = s.groups[groupId]
        if (!g) return {}
        const arr = [...g.sessionIds]
        const from = arr.indexOf(sessionId)
        if (from === -1) return {}
        arr.splice(from, 1)
        let idx = from < toIndex ? toIndex - 1 : toIndex
        idx = Math.max(0, Math.min(arr.length, idx))
        arr.splice(idx, 0, sessionId)
        return { groups: { ...s.groups, [groupId]: { ...g, sessionIds: arr } } }
      }),

    closeGroup: async (groupId) => {
      const g = get().groups[groupId]
      if (!g) return
      await Promise.all(g.sessionIds.map((id) => window.api.terminal.kill(id)))
      set((s) => {
        const groups = { ...s.groups }
        delete groups[groupId]
        const layout = removeLeaf(s.layout, groupId)
        const activeGroupId =
          s.activeGroupId === groupId
            ? (firstGroupId(layout) ?? Object.keys(groups)[0] ?? null)
            : s.activeGroupId
        const activeSessionId = activeGroupId
          ? (groups[activeGroupId]?.activeSessionId ?? null)
          : null
        // 组已移除：其 AI 面板开关状态一并清理
        const aiOpenGroups = { ...s.ui.aiOpenGroups }
        delete aiOpenGroups[groupId]
        return { groups, layout, activeGroupId, activeSessionId, ui: { ...s.ui, aiOpenGroups } }
      })
    },

    resizeSplit: (splitId, sizes) =>
      set((s) => (s.layout ? { layout: updateSizes(s.layout, splitId, sizes) } : {})),

    setActiveSession: (id) =>
      set((s) => {
        const gid = Object.keys(s.groups).find((k) => s.groups[k].sessionIds.includes(id))
        if (!gid) return {}
        const g = s.groups[gid]
        const groups =
          g.activeSessionId === id
            ? s.groups
            : { ...s.groups, [gid]: { ...g, activeSessionId: id } }
        return { groups, activeGroupId: gid, activeSessionId: id }
      }),

    setActiveGroup: (groupId) =>
      set((s) => {
        const g = s.groups[groupId]
        if (!g) return {}
        return { activeGroupId: groupId, activeSessionId: g.activeSessionId }
      }),

    refreshProfiles: async () => {
      set({ profiles: await window.api.ssh.list() })
    },

    saveSshGroup: async (input) => {
      set({ sshGroups: await window.api.ssh.saveGroup(input) })
    },

    setSshProfileColor: async (id, color) => {
      const profile = get().profiles.find((p) => p.id === id)
      if (!profile) return
      // 只改颜色：password 等敏感字段不传，主进程会保留原值
      set({ profiles: await window.api.ssh.save({ ...profile, color: color ?? undefined }) })
    },

    deleteSshGroup: async (id, deleteProfiles) => {
      // 组内连接可能被删除或回到「未分组」，两份数据都要刷新
      const [sshGroups, profiles] = await Promise.all([
        window.api.ssh.removeGroup(id, deleteProfiles),
        window.api.ssh.list()
      ])
      set({ sshGroups, profiles })
    },

    arrangeSsh: async (payload) => {
      const { groups, profiles } = await window.api.ssh.arrange(payload)
      set({ sshGroups: groups, profiles })
    },

    setGroupAiOpen: (groupId, open) =>
      set((s) => ({ ui: { ...s.ui, aiOpenGroups: { ...s.ui.aiOpenGroups, [groupId]: open } } })),
    setSettingsOpen: (open, tab) =>
      set((s) => ({
        ui: {
          ...s.ui,
          settingsOpen: open,
          ...(tab ? { settingsTab: tab } : {})
        }
      })),
    setSshDialog: (open, editing = null, groupId) =>
      set((s) => ({ ui: { ...s.ui, sshDialog: { open, editing, groupId } } })),

    setRunScriptDialog: (open, scriptId) =>
      set((s) => ({ ui: { ...s.ui, runScriptDialog: { open, scriptId } } })),

    setCommandPaletteOpen: (open) =>
      set((s) => ({ ui: { ...s.ui, commandPaletteOpen: open } })),

    selectActivity: (id) => set((s) => ({ ui: { ...s.ui, activeActivity: id } })),

    loadPlugins: async () => {
      const { loadPlugins } = await import('@/plugins/host')
      const views = await loadPlugins()
      set((s) => ({ plugins: views, ui: fallbackFromMissingPlugin(s.ui, views) }))
    },

    refreshPluginList: async () => {
      set({ pluginList: await window.api.plugins.list() })
    },

    togglePluginEnabled: async (id, enabled) => {
      const list = await window.api.plugins.setEnabled(id, enabled)
      const { loadPlugins } = await import('@/plugins/host')
      const plugins = await loadPlugins()
      // 当前正在查看的插件功能区因禁用而消失时，回到主机功能区
      set((s) => ({ pluginList: list, plugins, ui: fallbackFromMissingPlugin(s.ui, plugins) }))
    },

    uninstallPlugin: async (id) => {
      const list = await window.api.plugins.uninstall(id)
      const { loadPlugins } = await import('@/plugins/host')
      const plugins = await loadPlugins()
      set((s) => ({ pluginList: list, plugins, ui: fallbackFromMissingPlugin(s.ui, plugins) }))
    },

    installPlugin: async (sourcePath) => {
      const list = await window.api.plugins.install(sourcePath)
      const { loadPlugins } = await import('@/plugins/host')
      const plugins = await loadPlugins()
      set({ pluginList: list, plugins })
    },

    reloadPlugins: async (id) => {
      const list = await window.api.plugins.reload(id)
      const { loadPlugins } = await import('@/plugins/host')
      const plugins = await loadPlugins()
      // 当前查看的插件功能区若因重载消失，回到主机功能区
      set((s) => ({ pluginList: list, plugins, ui: fallbackFromMissingPlugin(s.ui, plugins) }))
    },

    registerPluginCommand: (pluginId, cmd) =>
      set((s) => ({
        pluginCommands: { ...s.pluginCommands, [cmd.id]: { pluginId, ...cmd } }
      })),

    setSidebarWidth: (width) =>
      set((s) => ({ ui: { ...s.ui, sidebarWidth: width } })),

    // 折叠状态记在当前功能区名下：侧边栏属于功能区，切 tab 不会互相影响
    setSidebarCollapsed: (collapsed) =>
      set((s) => ({
        ui: {
          ...s.ui,
          collapsedActivities: { ...s.ui.collapsedActivities, [s.ui.activeActivity]: collapsed }
        }
      })),

    setAiPanelWidth: (width) =>
      set((s) => ({ ui: { ...s.ui, aiPanelWidth: width } })),

    refreshScripts: async () => {
      set({ scripts: await window.api.scripts.list() })
    },

    refreshAiConfigs: async () => {
      set({ aiConfigs: await window.api.ai.listConfigs() })
    },

    setActiveAiConfig: async (id) => {
      const settings = await window.api.ai.saveSettings({ activeConfigId: id })
      set({ aiSettings: settings })
    },

    saveAiSettings: async (patch) => {
      const settings = await window.api.ai.saveSettings(patch)
      set({ aiSettings: settings })
    },

    setAiPermissionMode: async (mode) => {
      // 实时生效：主进程在每次执行命令时才读取该配置
      set((s) => ({ aiSettings: { ...s.aiSettings, permissionMode: mode } }))
      const settings = await window.api.ai.saveSettings({ permissionMode: mode })
      set({ aiSettings: settings })
    },

    resolveAiConfirm: async (id, approved) => {
      // 用户直接回复：本地先移除卡片，再通知主进程对应实例
      set((s) => {
        if (!(id in s.pendingConfirms)) return {}
        const next = { ...s.pendingConfirms }
        delete next[id]
        return { pendingConfirms: next }
      })
      await window.api.ai.resolveConfirm(id, approved)
    },

    setTheme: async (mode) => {
      const preferences = await window.api.prefs.save({ theme: mode })
      set({ preferences })
    },

    setColorTheme: async (name, customColor) => {
      // 立即生效（改 html 的 data-color-theme / 自定义色变量），再持久化
      const next = customColor ?? get().preferences.customColor
      applyColorTheme(name, next)
      set((s) => ({ preferences: { ...s.preferences, colorTheme: name, customColor: next } }))
      const preferences = await window.api.prefs.save({ colorTheme: name, customColor: next })
      set({ preferences })
    },

    setTerminalTheme: async (name) => {
      // 立即生效，终端监听 preferences 变化时热更新配色
      set((s) => ({ preferences: { ...s.preferences, terminalTheme: name } }))
      const preferences = await window.api.prefs.save({ terminalTheme: name })
      set({ preferences })
    },

    setCopyOnSelect: async (enabled) => {
      set((s) => ({ preferences: { ...s.preferences, copyOnSelect: enabled } }))
      const preferences = await window.api.prefs.save({ copyOnSelect: enabled })
      set({ preferences })
    },

    setRightClickPaste: async (enabled) => {
      set((s) => ({ preferences: { ...s.preferences, rightClickPaste: enabled } }))
      const preferences = await window.api.prefs.save({ rightClickPaste: enabled })
      set({ preferences })
    },

    setCommandPrediction: async (enabled) => {
      set((s) => ({ preferences: { ...s.preferences, commandPrediction: enabled } }))
      const preferences = await window.api.prefs.save({ commandPrediction: enabled })
      set({ preferences })
    },

    setMinimizeToTray: async (enabled) => {
      set((s) => ({ preferences: { ...s.preferences, minimizeToTray: enabled } }))
      const preferences = await window.api.prefs.save({ minimizeToTray: enabled })
      set({ preferences })
    },

    setLocalShell: async (shellId) => {
      set((s) => ({ preferences: { ...s.preferences, localShell: shellId } }))
      const preferences = await window.api.prefs.save({ localShell: shellId })
      set({ preferences })
    },

    setTerminalFontSize: async (size) => {
      const terminalFontSize = clampTerminalFontSize(size)
      // 先本地生效（缩放需即时反馈）；持久化做防抖，避免滚轮连续调整时频繁写盘
      set((s) => ({ preferences: { ...s.preferences, terminalFontSize } }))
      if (fontSizeSaveTimer) window.clearTimeout(fontSizeSaveTimer)
      fontSizeSaveTimer = window.setTimeout(() => {
        void window.api.prefs
          .save({ terminalFontSize: get().preferences.terminalFontSize })
          .then((preferences) => set({ preferences }))
      }, 300)
    },

    setMonitorInterval: async (ms) => {
      // 先本地生效（进度条节奏随之变化），主进程归一化后返回最终值
      set((s) => ({ preferences: { ...s.preferences, monitorInterval: ms } }))
      set({ preferences: await window.api.monitor.setInterval(ms) })
    },

    saveShortcuts: async (shortcuts) => {
      set({ shortcuts })
      const next = await window.api.shortcuts.save(shortcuts)
      set({ shortcuts: next })
    },

    sendAiMessage: async (text, targetSessionId) => {
      const trimmed = text.trim()
      // 对话归属于一个终端会话（默认当前激活的），各会话的助手上下文互相独立
      const sid = targetSessionId ?? get().activeSessionId
      if (!sid) return
      const chat = get().aiChats[sid] ?? emptyAiChat()
      if (!trimmed || chat.streaming) return
      const now = Date.now()
      const userMsg: AiChatMessage = {
        id: `u-${now}`,
        role: 'user',
        parts: [{ type: 'text', text: trimmed }],
        createdAt: now
      }
      const assistantMsg: AiChatMessage = {
        id: `a-${now}`,
        role: 'assistant',
        parts: [],
        createdAt: now + 1
      }
      const history = [...chat.messages, userMsg]
      set((s) => ({
        aiChats: {
          ...s.aiChats,
          [sid]: { ...chat, messages: [...history, assistantMsg], streaming: true, error: null }
        }
      }))

      try {
        // 主进程把工具绑定到该会话：切换激活终端不影响这段对话的作用目标
        const { requestId } = await window.api.ai.chat({ history, targetSessionId: sid })
        aiRequestSessions.set(requestId, sid)
        set((s) => {
          const c = s.aiChats[sid]
          if (!c) return {}
          return { aiChats: { ...s.aiChats, [sid]: { ...c, requestId } } }
        })
      } catch (err) {
        set((s) => {
          const c = s.aiChats[sid]
          if (!c) return {}
          return {
            aiChats: {
              ...s.aiChats,
              [sid]: {
                ...c,
                streaming: false,
                requestId: null,
                error: err instanceof Error ? err.message : String(err)
              }
            }
          }
        })
      }
    },

    abortAi: async (sid) => {
      if (!sid) return
      const chat = get().aiChats[sid]
      const requestId = chat?.requestId ?? null
      if (!requestId) return
      aiRequestSessions.delete(requestId)
      // 只清属于本次请求的确认卡，不影响其他会话实例的对话
      for (const c of Object.values(get().pendingConfirms)) {
        if (c.requestId === requestId) void get().resolveAiConfirm(c.id, false)
      }
      await window.api.ai.abort(requestId)
      set((s) => ({
        aiChats: s.aiChats[sid]
          ? { ...s.aiChats, [sid]: { ...s.aiChats[sid], streaming: false, requestId: null } }
          : s.aiChats
      }))
    },

    clearAiMessages: (sid) => {
      if (!sid) return
      const chat = get().aiChats[sid]
      if (chat?.requestId) aiRequestSessions.delete(chat.requestId)
      set((s) => ({ aiChats: { ...s.aiChats, [sid]: emptyAiChat() } }))
    },

    handleAiEvent: (requestId, event) => {
      // 路由到发起该对话的会话（不依赖当前激活终端）
      const sid = aiRequestSessions.get(requestId)
      if (!sid) return
      if (event.type === 'finish') {
        aiRequestSessions.delete(requestId)
        set((s) => {
          const chat = s.aiChats[sid]
          if (!chat) return {}
          return {
            aiChats: { ...s.aiChats, [sid]: { ...chat, streaming: false, requestId: null } }
          }
        })
        // 兜底：该对话已结束但仍有其挂起确认时按取消处理，避免主进程工具悬挂
        for (const c of Object.values(get().pendingConfirms)) {
          if (c.requestId === requestId) void get().resolveAiConfirm(c.id, false)
        }
        return
      }
      set((s) => {
        const chat = s.aiChats[sid]
        if (!chat) return {}
        const messages = [...chat.messages]
        const last = messages[messages.length - 1]
        if (last?.role === 'assistant') {
          messages[messages.length - 1] = {
            ...last,
            parts: appendAssistantPart(last.parts, event)
          }
        }
        return { aiChats: { ...s.aiChats, [sid]: { ...chat, messages } } }
      })
    }
  }
})

// CDP 调试暴露（模块初始化完成后赋值，避免 TDZ）
if (typeof window !== 'undefined') {
  ;(window as unknown as Record<string, unknown>).__store = useAppStore
}
