/**
 * 全局 store 的共享类型、常量与纯函数。
 *
 * 各 slice 文件 import 这里的接口/类型来声明自己的 state + actions，
 * 主 store 文件 import 这里组合出完整的 `AppStore` 接口。
 * 消费方（features / app / shared）仍然只 import `@/stores/app-store`，
 * 那里 re-export 本文件的全部公开符号，保持单一入口。
 */
import type { PluginInfo } from '@shared/plugin'
import type { SshProfile } from '@shared/types'
import type { PaneNode, SplitDirectionInput } from '@/app/layout/pane-layout'
import type { PluginViewInstance } from '@/features/plugins/host'
import type {
  AcpConversationState,
  AcpSessionInfo,
  AgentBackend,
  AgentChatMessage,
  AgentConfirmRequest,
  ContextCompression,
  AgentConversation,
  AgentStreamEvent,
  AgentWorkspace,
  AiModelConfig,
  AiPermissionMode,
  AiSettings,
  ApiGroup,
  ApiHistoryEntry,
  ApiProtocol,
  ApiRequestEntry,
  AppShortcutAction,
  AskFollowupAnswer,
  AskFollowupRequest,
  ColorThemeName,
  CommandHistoryEntry,
  HostLogEntry,
  MonitorUnsupportedReason,
  NoteFileContent,
  NoteFileItem,
  NoteSaveMode,
  Preferences,
  ScriptEntry,
  ScriptGroup,
  ServerMetrics,
  SessionInfo,
  ShellDetectResult,
  ShortcutConfig,
  SkillInfo,
  SkillRootInfo,
  SkillSettings,
  SftpTransferProgress,
  SshConnectProgress,
  SshGroup,
  SshKnownHost,
  SshTunnel,
  SshTunnelRuntime,
  TerminalThemeName,
  ThemeMode,
  TransferExportResult,
  TransferImportResult,
  TransferKind,
  TransferPickResult
} from '@shared/types'
import type { WorkspaceConfig, WorkspaceConfigSnapshot } from '@shared/workspace-config'

// ---------------------------------------------------------------------------
// 枚举与常量
// ---------------------------------------------------------------------------

/** PanelView 标签类型（终端会话也是其中一种，不再有独立的「终端」固定标签） */
export type PanelTabType =
  | 'terminal'
  | 'script'
  | 'note'
  | 'api'
  | 'plugins'
  | 'plugin'
  | 'sftp'
  | 'rdp'
  | 'tunnels'
  | 'logs'
  | 'agent'

/** 设置弹窗左侧分组（与 `features/settings/SettingsModal` 的菜单一一对应） */
export type SettingsTab =
  | 'prefs'
  | 'shortcuts'
  | 'terminal'
  | 'models'
  | 'acp'
  | 'mcp'
  | 'skills'
  | 'timeouts'
  | 'prompt'

/** 全部合法分组（顺序即菜单顺序） */
export const SETTINGS_TABS: readonly SettingsTab[] = [
  'prefs',
  'shortcuts',
  'terminal',
  'models',
  'acp',
  'mcp',
  'skills',
  'timeouts',
  'prompt'
]

/** 归一化外部传入的分组（非法值或未传都回落到「偏好」） */
export function normalizeSettingsTab(tab?: string): SettingsTab {
  if (tab && (SETTINGS_TABS as readonly string[]).includes(tab)) return tab as SettingsTab
  return 'prefs'
}

/** 编辑页（脚本 / 笔记 / 接口请求）的保存状态，由页面自己投影到底部状态栏 */
export type EditorSaveState = 'saving' | 'dirty' | 'saved'

/**
 * 状态栏保存状态的键。
 *
 * 脚本 id / 笔记文件路径 / 接口请求 id 来自三张不同的表、理论上可能撞车，所以带上类型前缀区分。
 * `api` 与 `ws` 其实同属 apiRequests 一张表（id 不会撞），分开只是为了状态栏的提示语
 * 能分别显示「接口请求」和「WebSocket」。
 */
export const editorSaveKey = (kind: 'script' | 'note' | 'api' | 'ws', id: string): string =>
  `${kind}:${id}`

/** 渲染端主机日志条数上限（与主进程内存环形缓冲一致，超出丢最旧的） */
export const HOST_LOG_LIMIT = 1000
/** 终端命令历史条数上限（与主进程 services/terminal/history.ts 的 COMMAND_HISTORY_MAX 同值） */
export const COMMAND_HISTORY_LIMIT = 1000

/**
 * 组内批量关闭（标签右键菜单的「关闭其他 / 关闭左侧 / 关闭右侧标签」）的范围。
 * 三种范围都只在本组内生效，锚点标签（用户右键的那个）自身始终保留。
 */
export type SiblingTabsCloseMode = 'others' | 'left' | 'right'

/** 未保存的「新建请求」草稿标签使用的请求 id（不是一个真实存储条目） */
export const NEW_API_REQUEST_ID = '__new__'

/**
 * 未保存的「新建 WebSocket」草稿标签的请求 id。
 *
 * 与 HTTP 草稿**分开**：两者共用同一个草稿 id 的话，已经打开 HTTP 草稿时
 * 再点「新建 WebSocket」只会聚焦到那个 HTTP 草稿上，协议切换不过来。
 */
export const NEW_WS_REQUEST_ID = '__new_ws__'

/** 请求历史最多保留的条数 */
export const API_HISTORY_LIMIT = 50

// ---------------------------------------------------------------------------
// 标签与面板组
// ---------------------------------------------------------------------------

/**
 * PanelView 中打开的标签页。
 *
 * 标签 id 由身份推导（terminal-<sessionId> / script-<id> / note-<id> / api-<id> /
 * plugins / plugin-<viewId>），这样「是否已打开」只需比对 id，无需遍历业务字段。
 */
export interface PanelTab {
  id: string
  type: PanelTabType
  title: string
  /**
   * 用户自定义标题（标签条上「重命名」写进来的那份）。
   *
   * 多数标签的展示标题是**从业务对象实时推导**的（终端取主机名 / 会话标题、Agent 取会话
   * 标题、接口取请求名），页面自己也会跟着对象改标题 —— 那些路径只写 `title`，压不住它。
   * 所以用户显式重命名的值单独放这个字段：渲染时优先用它，置空（空串）即恢复自动标题。
   */
  customTitle?: string
  closable: boolean
  /** 所属面板组（分屏树的一个叶子） */
  groupId: string
  /** terminal：对应的终端会话 id */
  sessionId?: string
  /** agent：对应的 Agent 会话 id */
  agentConversationId?: string
  scriptId?: string
  /** 旧版笔记 id（兼容旧标签数据） */
  noteId?: string
  /** 笔记文件绝对路径（新版本地文件模式） */
  noteFilePath?: string
  /** 接口请求：保存的请求 id */
  apiRequestId?: string
  /**
   * 接口请求的协议类型（决定这个标签渲染 ApiPage 还是 WsPage）。
   * 打开标签时从请求上抄一份 —— 协议创建后不可改，所以不会与请求本身漂移；
   * 草稿标签则是新建时指定的协议（见 `openNewApiDraft`）。
   */
  apiProtocol?: ApiProtocol
  /** 接口请求（未保存草稿）的目标分组：保存落盘时写入该分组 */
  apiGroupId?: string
  /** sftp：对应的 SSH 主机配置 id（凭据在主进程按它解密） */
  sftpProfileId?: string
  /** rdp：对应的主机配置 id（kind = 'rdp'：地址 / 端口 / 凭据都取自它） */
  rdpProfileId?: string
  pluginViewId?: string
}

/**
 * 面板组（分屏树的一个叶子）：一组平级标签页，同一时刻只显示激活的那个。
 * 分屏、拖拽排序、跨组移动都作用在组与标签上（VS Code 编辑器组语义）。
 */
export interface PanelGroup {
  id: string
  tabIds: string[]
  activeTabId: string | null
}

/** 终端标签 id：由会话 id 推导，重连换会话 id 时同步换标签 id */
export function terminalTabId(sessionId: string): string {
  return `terminal-${sessionId}`
}

/** 接口请求标签 id：由请求 id 推导 */
export function apiTabId(requestId: string): string {
  return `api-${requestId}`
}

/** Agent 会话标签 id：由会话 id 推导 */
export function agentTabId(conversationId: string): string {
  return `agent-${conversationId}`
}

/**
 * Agent 会话标签的载荷。
 *
 * `title` 只是个初值 —— 渲染时 `PanelTabItem` 会优先取会话当前的 title
 * （与终端标签取 `session.title` 同一套路），所以会话重命名 / 首条消息自动定标题
 * 都不需要再同步标签，不会漂移。
 */
export function agentTab(conversation: Pick<AgentConversation, 'id' | 'title'>): Omit<PanelTab, 'groupId'> {
  return {
    id: agentTabId(conversation.id),
    type: 'agent',
    title: conversation.title,
    closable: true,
    agentConversationId: conversation.id
  }
}

/**
 * 会话的**有效形态**（`AgentConversation.kind` 的「未定」态在这里被推断出来）。
 *
 * 新建的会话刻意不写 `kind` —— 形态由**首条消息时选中的模型**决定（见 4.3）。
 * 所以消费方（会话页的模型下拉、侧边栏的类型标识）要统一走这个函数：
 * 已定的按已定；未定的按「已经选中了什么」推断（选中 / 预置了 ACP agent → `acp`，
 * 选了内置模型 → `mastra`，都没选 → undefined）；`undefined` 时标识先不显示。
 */
export function conversationKind(
  c: Pick<AgentConversation, 'kind' | 'acpAgentId' | 'configId'> | undefined | null
): AgentBackend | undefined {
  if (!c) return undefined
  return c.kind ?? (c.acpAgentId ? 'acp' : c.configId ? 'mastra' : undefined)
}

/**
 * 「草稿」= **还没发出首条消息**的会话。
 *
 * `kind` 只在首条消息时定型（见 4.3），所以 `!kind` 就是「一个键都没按过」。
 * 草稿在内存里是**真实存在**的会话（会话页、标签、模型选择都挂在它上面），但——
 * - **不进侧边栏的会话列表**：用户点「新建会话」看到的是「当前工作区的新建会话页」，
 *   列表里不该立刻多出一条空会话；
 * - 发出第一条消息那一刻它才「转正」：标题取首条消息、形态按选中的模型定，随后出现在列表里。
 *
 * 别用别的条件（如 `messages.length === 0`）代替：清空过消息的会话、ACP 会话的 `messages`
 * 恒为空，都会被误判成草稿。
 */
export function isDraftConversation(c: Pick<AgentConversation, 'kind'>): boolean {
  return !c.kind
}

/**
 * 接口请求的展示名：优先用用户起的名字，否则退回「协议 + 路径」，
 * 都没有时给个占位（新建但还没填地址的请求）。
 */
export function apiTabTitle(
  req: Pick<ApiRequestEntry, 'name' | 'method' | 'url'> & { protocol?: ApiProtocol }
): string {
  const name = req.name.trim()
  if (name) return name
  const isWs = req.protocol === 'ws'
  const url = req.url.trim()
  if (!url) return isWs ? '新建 WebSocket' : '新建请求'
  // WebSocket 没有 HTTP 方法，用 WS 前缀代替
  const prefix = isWs ? 'WS' : req.method
  try {
    const u = new URL(url)
    // 根路径且无查询串时用主机名，避免出现「GET /」这种没信息量的标题
    const path = u.pathname === '/' && !u.search ? u.host : `${u.pathname}${u.search}`
    return `${prefix} ${path}`
  } catch {
    // 地址还不完整（如只输入了 example.com）时按原文展示
    return `${prefix} ${url}`
  }
}

/**
 * 某个面板组里「激活标签对应的终端会话 id」（激活的不是终端时为 undefined）。
 *
 * 「终端页面」= 终端标签 = 一个会话，这是 AI 助手的归属单位。状态栏开关、
 * 面板渲染、快捷键都以此为准，省得每处各写一遍「取激活标签再判类型」。
 */
export function groupTerminalSessionId(
  s: { groups: Record<string, PanelGroup>; ui: { panelTabs: PanelTab[] } },
  groupId: string | null | undefined
): string | undefined {
  const tabId = groupId ? s.groups[groupId]?.activeTabId : null
  const tab = tabId ? s.ui.panelTabs.find((t) => t.id === tabId) : undefined
  return tab?.type === 'terminal' ? tab.sessionId : undefined
}

// ---------------------------------------------------------------------------
// AI 与 Agent 状态
// ---------------------------------------------------------------------------

/**
 * 单个会话的运行时状态。
 *
 * 消息本身存在 `agentConversations` 里（唯一真源，也是落盘的那份），
 * 这里只放「这一轮跑到哪了」—— 两者分开，避免同一份消息维护两遍。
 */
export interface AgentRunState {
  streaming: boolean
  /** 进行中的对话请求 id（用于事件路由与中止） */
  requestId: string | null
  error: string | null
  /** 本轮是否因可重试的网络错误（如网关中途断流 ECONNRESET）失败，供界面给出「重试」入口 */
  retryable?: boolean
  /**
   * 模型请求正在重试（第 `attempt` 次）：界面据此显示一条**自替换**的「第 N 次重试」提示。
   * 重试是「通知」不是内容 —— 不为它建消息 part，只在气泡的「正在生成」位置替换掉三点指示器。
   */
  retrying?: { attempt: number; maxRetries: number } | null
  /**
   * 最近一次上下文压缩的通知（只用于顶部提示一条，**不进消息历史**）。
   * 压缩只改「这一次请求怎么带上下文」，屏幕上的历史始终是原文。
   */
  contextNotice?: ContextCompression
}

export function emptyAgentRun(): AgentRunState {
  return { streaming: false, requestId: null, error: null }
}

/**
 * 待发送队列里的一条消息（会话进行中用户继续发的内容）。
 *
 * 形态参考 fishwork 的 `QueuedMessage`。**只活在内存里**：它和输入框里没发出去的草稿
 * 是同一类「还没交给 agent 的输入」，跟着会话走但不落盘（`AgentConversation` 只存真正
 * 发出去的消息）。
 */
export interface QueuedAgentMessage {
  id: string
  text: string
  createdAt: number
}

// ---------------------------------------------------------------------------
// 传输任务
// ---------------------------------------------------------------------------

/** 传输任务条目：主进程进度 + 渲染端按「字节差 / 时间差」计算的实时速度（字节/秒） */
export interface TransferItem extends SftpTransferProgress {
  /** 当前速度（字节/秒）；0 表示尚未采样或已结束 */
  speed: number
  /** 上次速度采样的时间与字节数（内部状态，用于差值计算） */
  lastAt?: number
  lastBytes?: number
}

// ---------------------------------------------------------------------------
// UI 状态
// ---------------------------------------------------------------------------

export interface UiState {
  /**
   * 各终端页面是否打开其内置 AI 助手（key 为会话 id，终端标签 = 一个终端页面）。
   *
   * AI 助手**属于终端页面**而不是面板组：同一个组里切标签就换实例，
   * 每个终端页面各自记住自己的开关，互不影响（对话状态见 `aiChats`，同样按会话隔离）。
   */
  aiOpenSessions: Record<string, boolean>
  /**
   * 各终端页面的 AI 浮窗是否最小化（key 为会话 id）：
   * 最小化后收起消息列表与输入栏，只留一行状态条展示最新对话内容。
   */
  aiMinimizedSessions: Record<string, boolean>
  settingsOpen: boolean
  /** 编辑中的 SSH 配置（null=新建，undefined=关闭）；groupId 为新建时预设的分组 */
  sshDialog: { open: boolean; editing?: SshProfile | null; groupId?: string }
  /** 运行脚本对话框：scriptId 为预设脚本（可空，在对话框内选择） */
  runScriptDialog: { open: boolean; scriptId?: string }
  /** 设置弹窗当前选中的分组（打开时由入口参数写入，见 setSettingsOpen） */
  settingsTab: SettingsTab
  /** 是否打开命令面板（Ctrl+Shift+P：脚本、终端、主机、设置等命令入口） */
  commandPaletteOpen: boolean
  /**
   * 当前激活的功能区 id（活动栏选中的 tab，导航的唯一真源）：
   * 主区域显示什么、侧边栏显示哪个面板都由它派生（见 src/renderer/src/activities.tsx）。
   * id 失效（插件被卸载等）时回退到第一个内置功能区。
   */
  activeActivity: string
  /**
   * 活动栏功能区的显示顺序（存功能区 id 列表）。
   * null = 用户没拖过，按 BUILTIN_ACTIVITIES 的默认顺序；
   * 列表里缺失的 id（新增功能区）排在已排序 id 之后、保持默认相对顺序（见 orderActivities）。
   */
  activityOrder: string[] | null
  /** 各功能区的侧边栏是否折叠（key 为功能区 id；侧边栏属于功能区，互不影响） */
  collapsedActivities: Record<string, boolean>
  /**
   * 侧边栏内各「可折叠纵向分区」是否收起（key 为分区 id，见 section-ids.ts）。
   *
   * 与 collapsedActivities 同一思路：状态放 store 而不是组件里，
   * 这样分区所在的组件重挂载（切换功能区等）后折叠态仍然保持；
   * 通用容器见 components/StackedSections.tsx。
   */
  collapsedSections: Record<string, boolean>
  /**
   * 侧边栏内各「可拖拽分区」的高度（px，key 为分区 id，见 section-ids.ts）。
   *
   * 有值 = 用户拖过，该分区高度固定为它（不再参与剩余空间分配）；
   * 无值 = 按 SectionShell 的 flex 权重自动分配（默认状态）。
   * 声明了 `resizableAbove` 的分区才可能被写入。
   */
  sectionHeights: Record<string, number>
  /** 插件管理功能：当前正在查看的插件 id（null = 未选中） */
  activePluginId: string | null
  /** PanelView 中打开的标签页（扁平列表，按 groupId 归属到面板组） */
  panelTabs: PanelTab[]
  /** 侧边栏宽度（px） */
  sidebarWidth: number
  /** AI 助手浮窗宽度（px） */
  aiPanelWidth: number
  /**
   * AI 助手浮窗展开时的高度（px，含底部输入横条）。
   *
   * 展开态高度固定为它，不随消息多少变化（空对话 / 长回复都一样高），
   * 用户可拖动卡片自由边调整；实际渲染时再按容器剩余空间钳制。
   */
  aiPanelHeight: number
  /** AI 助手浮窗位置（相对面板组内容区：x=左边距、y=下边距；null=默认底部居中） */
  aiFloatingPos: { x: number; y: number } | null
  /**
   * 各编辑页的保存状态（key 见 `editorSaveKey`），显示在底部状态栏（见 EditorSaveStatus）。
   *
   * 脚本页 / 笔记页自己维护草稿与自动保存，「保存中/未保存/已保存」只是把它投影到状态栏；
   * 按实体隔离，多个脚本或笔记标签同时打开时互不干扰（每个页面只写自己那一格）。
   */
  editorSaveStatus: Record<string, EditorSaveState>
  /**
   * 设置页是否正在录制快捷键。
   *
   * 录制时全局的 keydown 分发必须让路，否则按下的组合会**既被录进去、又把动作执行一遍**
   * （两边都监听 window 的捕获阶段，注册更早的分发会先跑）。所以录制期间用一个标志位挂起分发。
   */
  shortcutRecording: boolean
  /**
   * AI Agent 内嵌终端的「切换请求」计数器（每命中一次开关快捷键 +1）。
   *
   * 终端会话是 AgentPage 的页面内状态（要绑定打开时的那个工作区目录），不适合挪进 store，
   * 所以用自增计数器当一次性信号：store 只广播「请切换一次」，由挂载着的 AgentPage 消费。
   * 用计数而不是布尔：连按多次不会被合并成一次。
   */
  agentTerminalToggle: number
}

/**
 * 插件列表变化（禁用 / 卸载 / 重载 / 刷新）后，若插件管理页选中的插件已不在列表中，
 * 清空选中，避免右侧详情停留在已卸载插件的残留数据上。
 */
export function withPluginList(ui: UiState, list: PluginInfo[]): UiState {
  if (!ui.activePluginId || list.some((p) => p.id === ui.activePluginId)) return ui
  return { ...ui, activePluginId: null }
}

// ---------------------------------------------------------------------------
// 偏好默认值
// ---------------------------------------------------------------------------

/** 偏好设置默认值：任何存档里缺失的字段都用这里的初值兜底（避免旧存档缺新字段导致 undefined） */
export const DEFAULT_PREFERENCES: Preferences = {
  theme: 'system',
  colorTheme: 'neutral',
  customColor: '#3b82f6',
  terminalTheme: 'auto',
  copyOnSelect: true,
  rightClickPaste: true,
  commandPrediction: true,
  commandHistory: true,
  terminalFontSize: 13,
  localShell: 'default',
  minimizeToTray: true,
  monitorInterval: 2000,
  confirmCloseTab: true,
  // 笔记默认「手动保存」：改动留在编辑器里，点保存 / Ctrl+S 才落盘
  noteSaveMode: 'manual',
  noteAutoSaveDelay: 2,
  notifyOnAgentFinish: true,
  hiddenActivities: [],
  browserChannel: 'auto'
}

// ---------------------------------------------------------------------------
// 完整 AppStore 接口（供 slice 声明引用、主 store 组合）
// ---------------------------------------------------------------------------

/**
 * 完整 store 接口。各 slice 文件声明自己那部分 state + actions，
 * 主 store 文件把它们交叉合并成这个接口。
 *
 * 由于 zustand slice 模式下各 slice 共享同一个 `set`/`get`，
 * 任何 slice 的 action 都可以读写完整 `AppStore` 的全部字段。
 */
export interface AppStore
  extends PanelSlice,
    TerminalSlice,
    SshSlice,
    HostLogsSlice,
    CommandHistorySlice,
    ScriptsSlice,
    NotesSlice,
    ApiSlice,
    PreferencesSlice,
    AiSlice,
    AgentSlice,
    SkillsSlice,
    UiSlice,
    PluginSlice,
    MonitorSlice,
    TransferSlice,
    DataTransferSlice {
  bootstrap: () => Promise<void>
}

// ---- 各 slice 接口 ----

export interface PanelSlice {
  /** 分屏布局树：每个叶子承载一个面板组；null 表示还没有任何标签页 */
  layout: PaneNode | null
  /** 所有面板组，key 为组 ID */
  groups: Record<string, PanelGroup>
  /** 当前聚焦的组 ID（决定新建标签落在哪个组，以及监控/AI 的上下文） */
  activeGroupId: string | null
  setActiveGroup: (groupId: string) => void
  /**
   * 向当前激活组的上/下/左/右拆分出新组：把该组的激活标签拎过去。
   * 组内不足两个标签时不做任何事（拆了还是同一个组，且绝不新建终端）。
   */
  splitActivePane: (direction: SplitDirectionInput) => Promise<void>
  /** 把标签移到目标组（可指定插入位置）；源组若因此变空则从布局中移除 */
  moveTabToGroup: (tabId: string, targetGroupId: string, index?: number) => void
  /** 把标签拖到某组的边缘：在该方向新建组并放入该标签 */
  splitTabToGroup: (tabId: string, targetGroupId: string, direction: SplitDirectionInput) => void
  /** 组内重排：把 tabId 移到组内 toIndex（相对重排前）位置 */
  reorderTabs: (groupId: string, tabId: string, toIndex: number) => void
  /** 关闭整个组（含其全部标签；终端会话会被结束） */
  closeGroup: (groupId: string) => Promise<void>
  /** 拖拽分隔条时更新某分隔节点的权重 */
  resizeSplit: (splitId: string, sizes: number[]) => void
  /** 激活 PanelView 中的指定标签 */
  activatePanelTab: (id: string) => void
  /** 关闭 PanelView 中的指定标签 */
  closePanelTab: (id: string) => void
  /**
   * 请求关闭标签：**用户入口一律走这个**，别直接调 `closePanelTab`。
   *
   * 确认框画在标签面板内部，所以先把标签带到前台，再向该标签的总线推
   * `close-request`（`shared/lib/tab-event-bus.ts`）：页面注册的确认 handler
   * （dirty / 防手滑 / 自定义）在页面内部完成确认，全部放行后页面侧 emit `close`，
   * 经 `setTabCloseExecutor` 注入的回调回到 `closePanelTab`；任一拒绝则什么都不发生。
   * （`closePanelTab` 保留为「无条件关闭」，供程序化场景使用。）
   */
  requestClosePanelTab: (id: string) => Promise<void>
  /** 请求关闭整个面板组：逐个把组内标签带到前台并推 close-request，任一取消则中止剩余 */
  requestCloseGroup: (groupId: string) => Promise<void>
  /**
   * 请求组内批量关闭：`others` 关闭同组其它标签，`left` / `right` 关闭锚点标签
   * 左侧 / 右侧的标签。**只在本组内生效**，锚点标签自己始终保留。
   * 逐个推 close-request 确认，任一取消则中止剩余。
   */
  requestCloseSiblingTabs: (tabId: string, mode: SiblingTabsCloseMode) => Promise<void>
  /**
   * 无条件执行组内批量关闭。与 `closePanelTab` 一样保留为「无条件」入口，供程序化场景使用。
   */
  closeSiblingTabs: (tabId: string, mode: SiblingTabsCloseMode) => Promise<void>
  /** 更新 PanelView 标签标题（业务对象改名时同步自动标题用，见 ApiPage / ScriptsPage） */
  updatePanelTabTitle: (id: string, title: string) => void
  /**
   * 重命名标签（标签条的「重命名」入口）：写 `customTitle`，压住各类型自动推导的标题。
   * 传空串 = 清掉自定义标题，恢复自动标题。
   */
  renamePanelTab: (id: string, title: string) => void
  /** 上报某个编辑页（脚本 / 笔记）的保存状态（由状态栏的 EditorSaveStatus 读取，key 见 `editorSaveKey`） */
  setEditorSaveStatus: (key: string, state: EditorSaveState) => void
  /** 在 PanelView 中打开脚本标签（已存在则激活） */
  openScriptTab: (scriptId: string) => void
  /** 在 PanelView 中打开笔记文件标签（filePath 为绝对路径，已存在则激活） */
  openNoteTab: (filePath: string, title?: string) => void
  /** 在 PanelView 中打开接口请求标签（已存在则激活） */
  openApiTab: (requestId: string) => void
  /**
   * 打开一个「未保存的新请求」草稿标签（不落盘，保存时才写进列表）。
   * `protocol` 决定草稿是 HTTP 还是 WebSocket（两者用不同的草稿标签 id）。
   */
  openNewApiDraft: (groupId?: string, protocol?: ApiProtocol) => void
  /** 从历史记录载入：把条目内容存为草稿种子，再打开（或聚焦）「新建请求」草稿标签 */
  loadApiHistoryDraft: (entry: ApiHistoryEntry) => void
  /** 草稿页取走种子（取走即清空，避免之后打开草稿又带上旧内容） */
  consumeApiDraftSeed: () => void
  /** 打开主机的 SFTP 文件管理标签（已打开则聚焦） */
  openSftpTab: (profileId: string) => void
  /** 打开主机的远程桌面（RDP）标签（已打开则聚焦；标签内弹凭据对话框再连接） */
  openRdpTab: (profileId: string) => void
  /** 打开「隧道」管理标签（已打开则聚焦；传 profileId 时预选该主机新建隧道） */
  openTunnelsTab: (profileId?: string) => void
  /** 隧道面板取走预选主机（取走即清空，避免之后打开又带上旧预选） */
  consumeTunnelSeed: () => void
  /** 打开「主机日志」标签（全局单例，已打开则聚焦；打开时顺手拉一次全量） */
  openLogsTab: () => void
  /** 在 PanelView 中打开插件管理标签（已存在则激活） */
  openPluginsTab: () => void
  /** 在 PanelView 中打开插件视图标签（已存在则激活） */
  openPluginTab: (viewId: string) => void
}

export interface TerminalSlice {
  sessions: SessionInfo[]
  activeSessionId: string | null
  exitedSessions: Set<string>
  /**主机中的会话阶段（key 为 sessionId；连接就绪/失败/关闭后移除） */
  connectStages: Record<string, SshConnectProgress>
  /** 新建本地终端标签（不传 shellId 时用偏好设置的默认本地终端），落在当前激活组 */
  createLocalSession: (shellId?: string) => Promise<void>
  /**
   * 连接一个已保存的主机：ssh / local 作为终端会话标签打开，rdp 打开远程桌面标签。
   * 终端会话返回新会话信息；rdp 主机没有终端会话，返回 null
   */
  connectHost: (profile: SshProfile) => Promise<SessionInfo | null>
  /** 连接指定主机并在其上执行脚本：连接就绪后把脚本写入该会话，返回是否执行成功 */
  runScriptOnHost: (profile: SshProfile, script: ScriptEntry) => Promise<boolean>
  closeSession: (id: string) => Promise<void>
  /** 会话结束后重连：按原类型/SSH 配置新建一个会话并替换旧的 */
  reconnectSession: (id: string) => Promise<void>
  setActiveSession: (id: string) => void
  /** 本地可用 shell 检测结果（null = 尚未加载） */
  shells: ShellDetectResult | null
}

export interface SshSlice {
  profiles: SshProfile[]
  /**主机分组（侧边栏归类用） */
  sshGroups: SshGroup[]
  /** 主机指纹记录（TOFU：首连静默记录，指纹变化硬失败） */
  knownHosts: SshKnownHost[]
  /** SSH 隧道配置（本地转发 / SOCKS5 动态代理） */
  tunnels: SshTunnel[]
  /** 隧道运行态（key 为隧道 id；由 tunnels:status 全量推送刷新） */
  tunnelRuntime: Record<string, SshTunnelRuntime>
  /** 「新建隧道」预选主机（右键「隧道…」传入；面板消费后清空） */
  tunnelSeed: string | null
  refreshProfiles: () => Promise<void>
  /** 刷新主机指纹记录（重置 / 连接记录后调用） */
  refreshKnownHosts: () => Promise<void>
  /** 重置指定 host:port 的主机指纹记录（下次连接重新 TOFU） */
  resetHostKey: (host: string, port: number) => Promise<void>
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
  /** 拉取隧道配置与运行态（启动 / 增删后调用） */
  refreshTunnels: () => Promise<void>
  /** 新建（id 为空）或更新隧道；运行中被编辑的隧道由主进程自动重启 */
  saveTunnel: (input: SshTunnel) => Promise<void>
  /** 删除隧道（运行中先停止） */
  removeTunnel: (id: string) => Promise<void>
  startTunnel: (id: string) => Promise<void>
  stopTunnel: (id: string) => Promise<void>
}

export interface HostLogsSlice {
  /** SSH / 隧道 / SFTP 等主机事件（从旧到新，界面倒序展示；上限 HOST_LOG_LIMIT） */
  hostLogs: HostLogEntry[]
  /** 重新拉取主机日志全量（跨重启保留的旧记录一并进来） */
  refreshHostLogs: () => Promise<void>
  /** 清空主机日志（内存 + 落盘文件） */
  clearHostLogs: () => Promise<void>
}

export interface CommandHistorySlice {
  /**
   * 终端命令历史镜像（最新在前；上限 COMMAND_HISTORY_LIMIT）。
   * 真源在主进程（userData/command-history.json），所有终端会话共享、跨重启保留；
   * 命令预测与管理界面读这里。
   */
  commandHistory: CommandHistoryEntry[]
  /**
   * 记录一条命令（回车提交时由 TerminalView 调）：镜像去重置顶 + fire-and-forget 上报主进程。
   * 偏好 commandHistory 关闭时只不记录，已有历史照常可用（预测 / 管理）。
   */
  pushCommandHistory: (cmd: string) => void
  /** 删除单条（按命令文本定位，主进程与镜像同步删） */
  removeCommandHistory: (cmd: string) => Promise<void>
  /** 清空历史（内存 + 落盘文件） */
  clearCommandHistory: () => Promise<void>
}

export interface ScriptsSlice {
  scripts: ScriptEntry[]
  /** 脚本分组（侧边栏里的分组节点，数组顺序即显示顺序） */
  scriptGroups: ScriptGroup[]
  refreshScripts: () => Promise<void>
  /** 删除脚本，并关掉它的标签页 */
  deleteScript: (id: string) => Promise<void>
  /** 刷新脚本分组到 store */
  refreshScriptGroups: () => Promise<void>
  /** 新建（不传 id）或重命名（传 id）脚本分组 */
  saveScriptGroup: (input: { id?: string; name: string }) => Promise<void>
  /** 删除分组；deleteScripts=true 时连同组内脚本一起删除 */
  deleteScriptGroup: (id: string, deleteScripts?: boolean) => Promise<void>
  /** 拖拽排序 / 换组后的整体重排：数组顺序即显示顺序 */
  arrangeScripts: (payload: {
    groupIds: string[]
    scripts: Array<{ id: string; groupId?: string }>
  }) => Promise<void>
}

export interface NotesSlice {
  /** 已打开的笔记目录绝对路径（顺序 = 侧边栏顺序；同一目录只出现一次，父子可同时打开） */
  noteRoots: string[]
  /** 各目录的 Markdown 文件树（key = 目录绝对路径） */
  noteTrees: Record<string, NoteFileItem[]>
  /** 弹系统框选择目录并加入侧边栏（可多选；已存在的跳过）。null = 用户取消 */
  openNoteFolder: () => Promise<{ added: number; skipped: number } | null>
  /** 把若干目录加入侧边栏（openNoteFolder 去掉对话框的部分：去重 → 扫描 → 并入） */
  addNoteRoots: (roots: string[]) => Promise<{ added: number; skipped: number }>
  /** 从侧边栏移除目录（只影响列表，不删磁盘文件） */
  removeNoteRoot: (root: string) => void
  /** 读取目录内指定文件（filePath 为相对该目录的路径） */
  readNoteFile: (root: string, filePath: string) => Promise<NoteFileContent>
  /** 保存内容到文件（filePath 为绝对路径） */
  saveNoteFile: (filePath: string, content: string) => Promise<{ mtime: number }>
  /** 新建笔记文件（root = 所属目录，dirPath 为相对该目录的子目录路径，空串 = 根下） */
  createNoteFile: (root: string, dirPath?: string) => Promise<NoteFileContent>
  /** 刷新文件树（root 缺省 = 全部目录） */
  refreshNoteFolder: (root?: string) => Promise<void>
  /** 重命名文件（在所属目录内） */
  renameNoteFile: (root: string, oldPath: string, newName: string) => Promise<string>
  /** 删除文件（磁盘删除，不可恢复） */
  deleteNoteFile: (root: string, filePath: string) => Promise<void>
}

export interface ApiSlice {
  /** 保存的接口请求（侧边栏列表；一个请求对应 PanelView 里的一个标签） */
  apiRequests: ApiRequestEntry[]
  /** 接口请求分组（侧边栏里的分组节点，数组顺序即显示顺序） */
  apiGroups: ApiGroup[]
  /** 请求历史（发送后自动记录，按时间倒序） */
  apiHistory: ApiHistoryEntry[]
  /**
   * 「新建请求」草稿的种子：侧边栏历史记录「载入」时先存一份条目内容再打开草稿标签，
   * 草稿页感知到种子后消费掉（consumeApiDraftSeed），只对 HTTP 草稿生效一次。
   */
  apiDraftSeed: Partial<ApiRequestEntry> | null
  /** 刷新接口请求列表到 store */
  refreshApiRequests: () => Promise<void>
  /** 刷新接口请求分组到 store */
  refreshApiGroups: () => Promise<void>
  /** 新建（不传 id）或重命名（传 id）接口请求分组 */
  saveApiGroup: (input: { id?: string; name: string }) => Promise<void>
  /** 删除分组；deleteRequests=true 时连同组内请求一起删除，否则组内请求回到「未分组」 */
  deleteApiGroup: (id: string, deleteRequests?: boolean) => Promise<void>
  /** 拖拽排序 / 换组后的整体重排：数组顺序即显示顺序 */
  arrangeApi: (payload: {
    groupIds: string[]
    requests: Array<{ id: string; groupId?: string }>
  }) => Promise<void>
  /**
   * 新建一条请求并返回其 id（不自动打开标签，由调用方决定）。
   * `seed` 用于预填内容（导入 cURL 走这条路），缺省就是一条空请求。
   */
  createApiRequest: (seed?: Partial<ApiRequestEntry>) => Promise<string>
  /**
   * 解析 cURL 命令并保存为一条新请求，返回新请求 id。
   * 解析失败会抛错（由调用方提示），成功时也不自动打开标签。
   */
  importCurlRequest: (curlText: string) => Promise<string>
  /** 刷新请求历史到 store */
  refreshApiHistory: () => Promise<void>
  /** 保存接口请求（upsert）：已有请求原地更新 */
  saveApiRequest: (entry: ApiRequestEntry) => Promise<void>
  /** 删除接口请求，并关掉它的标签页 */
  deleteApiRequest: (id: string) => Promise<void>
  /** 记录一条请求历史（截断到 API_HISTORY_LIMIT 条并落盘） */
  recordApiHistory: (entry: ApiHistoryEntry) => Promise<void>
  /** 清空请求历史 */
  clearApiHistory: () => Promise<void>
}

export interface PreferencesSlice {
  preferences: Preferences
  /**
   * 应用内快捷键配置（动作 -> accelerator）。
   *
   * 由**渲染端**在 window 上监听 keydown 自行匹配分发（见 bootstrap 里的 shortcutWired），
   * 不用 Electron 的 globalShortcut —— 那是系统级的，会占用全局组合键、和别的程序抢。
   */
  shortcuts: ShortcutConfig[]
  setTheme: (mode: ThemeMode) => Promise<void>
  /** 设置界面配色方案（强调色，立即生效并持久化）；custom 时传入自定义色值 */
  setColorTheme: (name: ColorThemeName, customColor?: string) => Promise<void>
  setTerminalTheme: (name: TerminalThemeName) => Promise<void>
  setCopyOnSelect: (enabled: boolean) => Promise<void>
  setRightClickPaste: (enabled: boolean) => Promise<void>
  setCommandPrediction: (enabled: boolean) => Promise<void>
  /** 是否记录终端命令历史（持久化到偏好设置；关闭后不再记录，已有历史仍可预测/管理） */
  setCommandHistory: (enabled: boolean) => Promise<void>
  /** 关闭窗口时是否最小化到系统托盘（持久化到偏好设置） */
  setMinimizeToTray: (enabled: boolean) => Promise<void>
  /** 关闭标签页前是否二次确认（持久化到偏好设置；确认框里勾「以后都不再提示」会把它关掉） */
  setConfirmCloseTab: (enabled: boolean) => Promise<void>
  /** 设置笔记的保存时机（手动 / 立即 / 延迟，持久化到偏好设置） */
  setNoteSaveMode: (mode: NoteSaveMode) => Promise<void>
  /** 设置笔记「延迟保存」的等待秒数（1–60，持久化到偏好设置） */
  setNoteAutoSaveDelay: (seconds: number) => Promise<void>
  /** Agent 会话完成、应用不在前台时是否发系统通知（持久化到偏好设置） */
  setNotifyOnAgentFinish: (enabled: boolean) => Promise<void>
  /** 设置活动栏被隐藏的功能区 id 列表（持久化到偏好设置） */
  setHiddenActivities: (ids: string[]) => Promise<void>
  /** 设置本地终端默认 shell（持久化到偏好设置） */
  setLocalShell: (shellId: string) => Promise<void>
  setTerminalFontSize: (size: number) => Promise<void>
  /** 设置服务器指标采集间隔（毫秒）：立即生效并持久化 */
  setMonitorInterval: (ms: number) => Promise<void>
  /**
   * 保存快捷键配置（持久化到主进程）。
   * 应用内快捷键是「每次按键现读 store 匹配」，所以落盘后无需任何重注册，立刻生效。
   */
  saveShortcuts: (shortcuts: ShortcutConfig[]) => Promise<void>
}

export interface AiSlice {
  aiConfigs: AiModelConfig[]
  aiSettings: AiSettings
  /**
   * 终端 AI 助手的会话池（独立持久化，主进程分目录存 `terminal-conversations/`）。
   * **绝不进 agentConversations / AI Agent 侧边栏** —— 由存储边界保证，不靠消费方过滤。
   * 会话模型与工作区会话同构（均为 mastra 形态；工具是终端操作，scope 不在记录上区分来源）。
   */
  terminalConversations: AgentConversation[]
  /** 各终端页面当前打开的会话（key = sessionId；值指向 terminalConversations 或 terminalDrafts 里的 id） */
  activeTerminalConv: Record<string, string | null>
  /**
   * 各终端页面的「新建会话」草稿（key = sessionId；**仅内存**：不进会话列表、不落盘），
   * 发出首条消息那一刻转正 —— 标题取那条消息、进列表并落盘（见 `sendTerminalMessage`）。
   * 同一页面连点两次「新开会话」复用同一份草稿。
   */
  terminalDrafts: Record<string, AgentConversation>
  /**
   * 确认模式下等待用户处理的改动类工具请求（key 为确认 id）。
   * 终端助手与工作区 Agent 共用一张表、一条通道（`agent:confirm`）——
   * 工作区来源带 `workspaceName`，终端来源带 `sessionId` / `sessionTitle`。
   */
  pendingConfirms: Record<string, AgentConfirmRequest>
  refreshAiConfigs: () => Promise<void>
  /** 重新拉取 AI 设置（删除/新建配置后同步 activeConfigId，避免渲染端悬空） */
  refreshAiSettings: () => Promise<void>
  setActiveAiConfig: (id: string) => Promise<void>
  saveAiSettings: (patch: Partial<AiSettings>) => Promise<void>
  setAiPermissionMode: (mode: AiPermissionMode) => Promise<void>
  /** 选中某个终端页面要展示的会话（左侧列表点选；草稿 / 历史会话都可以） */
  selectTerminalConversation: (sessionId: string, conversationId: string) => void
  /**
   * 「新开会话」：给这个终端页面开一个草稿（已有草稿就复用）并选中它。
   * 模型选择继承该页面上一条会话的 configId / modelId，少一次重新选。
   */
  newTerminalConversation: (sessionId: string) => void
  /** 删除一条终端助手会话（连同落盘文件）；删的是当前打开的那条时自动切到最近一条或新草稿 */
  deleteTerminalConversation: (sessionId: string, conversationId: string) => Promise<void>
  /**
   * 设置**某条终端助手会话**使用的模型（只影响这一条会话）。
   * 草稿只写内存（不落盘）；转正后随会话落盘，重启后仍在。
   */
  setTerminalConversationModel: (
    conversationId: string,
    patch: { configId?: string; modelId?: string }
  ) => Promise<void>
  /** 回复确认请求：approved=true 执行，false 取消 */
  resolveAiConfirm: (id: string, approved: boolean) => Promise<void>
  /**
   * 发送终端助手的一条消息。工具作用于发起对话的终端页面（`sessionId`），
   * 绑定按请求计算 —— 历史会话在别的终端里接着聊时，工具作用于新终端。
   *
   * ⚠️ 这也是**草稿「转正」的那一刻**：标题取首条消息、进会话列表并落盘。
   */
  sendTerminalMessage: (text: string, sessionId: string) => Promise<void>
  /** 中止该终端页面当前会话的对话 */
  abortTerminal: (sessionId: string) => Promise<void>
  /** 删除某条消息及其之后的全部消息（用于「从这里重新开始」）；流式期间由 UI 侧禁用 */
  deleteTerminalMessagesFrom: (conversationId: string, messageId: string) => Promise<void>
  /**
   * 编辑并重发某条用户消息：**先删掉它及其之后的全部消息**，再用新文本重发。
   * 顺序不能反 —— `sendTerminalMessage` 读的是 store 里的历史，反了模型会看到「编辑前 + 编辑后」两条。
   */
  resendTerminalMessage: (conversationId: string, messageId: string, text: string) => Promise<void>
}

export interface AgentSlice {
  agentWorkspaces: AgentWorkspace[]
  /** 当前选中的工作区 id */
  activeAgentWorkspaceId: string | null
  agentConversations: AgentConversation[]
  /** 当前选中的会话 id（主区域 AgentPage 展示它） */
  activeAgentConversationId: string | null
  /** 各会话的运行时状态（key 为 conversationId） */
  agentRuns: Record<string, AgentRunState>
  /**
   * **ACP 会话的本地消息镜像**（key = conversationId）。
   *
   * ACP 会话的消息由 agent 自己管理、**不落盘**：打开会话时主进程用 `session/load` 让 agent
   * 回放整段历史、拼成消息列表整段下发到这里；之后新产生的内容也只追加在这里。
   * 重启应用后为空 —— 靠重新 `session/load` 恢复（`mastra` 会话不走这里，看 messages）。
   */
  agentAcpMessages: Record<string, AgentChatMessage[]>
  /** ACP 会话的运行时状态（agent 侧会话 id / 可切换的模型），key = conversationId */
  acpStates: Record<string, AcpConversationState>
  /** 正在回放历史的 ACP 会话（key = conversationId），供会话页显示加载态 */
  acpLoading: Record<string, boolean>
  /**
   * **待发送队列**（key = conversationId）：会话进行中用户继续发的消息先排在这里，
   * 本轮自然结束后由 `pumpAgentQueue` 按顺序接上（见 `submitAgentMessage`）。
   *
   * 按会话隔离：两个会话各跑各的，互不串队。
   */
  agentQueues: Record<string, QueuedAgentMessage[]>
  followupRequests: Record<string, AskFollowupRequest>
  workspaceConfigs: Record<string, WorkspaceConfigSnapshot>
  /** 重新拉取 Agent 工作区列表 */
  loadAgentWorkspaces: () => Promise<void>
  /** 保存工作区（同名路径视为更新）；返回最新列表 */
  saveAgentWorkspace: (input: {
    id?: string
    name: string
    path: string
  }) => Promise<void>
  deleteAgentWorkspace: (id: string) => Promise<void>
  /**
   * 读取工作区目录里的配置（`<工作区>/.dogi/workspace.json`，快捷功能等）。
   * 已缓存时直接返回；`force` 用于外部改动后的手动重读。
   */
  loadWorkspaceConfig: (workspaceId: string, force?: boolean) => Promise<void>
  /** 保存工作区目录配置（写盘成功后同步本地缓存） */
  saveWorkspaceConfig: (workspaceId: string, config: WorkspaceConfig) => Promise<void>
  /**
   * 设置 **mastra 会话**使用的模型配置 / 具体模型（立即落盘）。
   * 只写这一个会话 —— 切换 A 会话的模型不该影响 B 会话。
   * 不动 `updatedAt`：这是配置变更，不该让会话在列表里跳到最前。
   * （ACP 会话不走这里：它的模型走 `setAcpConversationModel`。）
   */
  setAgentConversationModel: (
    id: string,
    patch: { configId?: string; modelId?: string }
  ) => Promise<void>
  /**
   * 会话模型下拉里选中「某个 ACP agent 的模型」：
   * - 形态未定（新建的会话）→ 这就是定型动作（记下 acpAgentId + modelId，首条消息时落成 `acp`）；
   * - 形态已是 acp → 只换模型并下发 `session/set_config_option`（不重建会话）；
   * - 形态已是 mastra → 忽略（形态不可互切）。
   */
  setAcpConversationModel: (
    id: string,
    input: { acpAgentId?: string; modelId: string }
  ) => Promise<void>
  /**
   * 选中工作区：定位到它**最近更新的会话**（草稿不算，见 `latestConversation`）；
   * 一条真会话都没有时退回该工作区的草稿，连草稿都没有才现建一个。
   */
  selectAgentWorkspace: (id: string) => void
  /**
   * 「新建会话」= 打开**这个工作区的新建会话页**（草稿：仅内存、不进侧边栏列表、不落盘），
   * 并选中它。该工作区已有草稿就复用它（连点两次还是同一个空页）。
   *
   * 会话是**发出首条消息那一刻**才真正诞生的：标题取那条消息、形态按选中的模型定，
   * 随后出现在列表里（见 `sendAgentMessage` 与 `isDraftConversation`）。
   */
  createAgentConversation: (workspaceId?: string) => void
  /**
   * 批量导入 ACP agent 侧的已有会话（`session/list` 拉取后勾选的结果）：
   * 每个会话生成一条绑定记录（acpAgentId + acpSessionId），消息由 agent 自己管理。
   */
  importAcpConversations: (input: {
    workspaceId: string
    acpAgentId: string
    sessions: AcpSessionInfo[]
  }) => Promise<void>
  /** 选中会话：同时把它的标签带到 PanelView 前台 */
  selectAgentConversation: (id: string) => void
  /** 重命名会话（立即落盘） */
  renameAgentConversation: (id: string, title: string) => Promise<void>
  /**
   * 删除会话；删的是当前会话时自动切到同工作区的下一个。
   * `deleteRemoteSession`（仅 ACP 会话有意义）= 连 agent 侧的会话一起删（`session/delete`），
   * 失败只提示、本地记录照删（默认不删，避免误删用户数据）。
   */
  deleteAgentConversation: (
    id: string,
    options?: { deleteRemoteSession?: boolean }
  ) => Promise<void>
  /** 清空指定会话的消息（保留会话本身）；ACP 会话清的是本地镜像 */
  clearAgentMessages: (conversationId: string) => void
  /**
   * 手动压缩进行中：圆环转圈 + 按钮进 loading。
   *
   * 同时禁发输入（但不禁打字）—— 压缩期间发出的那一轮如果也带上刚写的检查点，
   * 语义会很难解释；让用户等这一下更清楚。
   */
  contextCompressing: boolean
  /**
   * 手动压缩某个会话的上下文：把「最后一轮之外」的旧轮摘要成一段并落成检查点。
   *
   * 成功后本地会话的 `contextSummary` 一起改（即时反馈，主进程才是落库的真源）。
   *
   * `ok: false` 且 `fatal` 缺省 = **这次没做**（如不足两轮），`reason` 可直接展示；
   * `fatal: true` 才是真故障（IPC 抛错）。调用方据此决定用 info 还是 error 提示 ——
   * 「对话不足两轮」报红是错的，用户会以为哪里坏了。
   */
  compressAgentContext: (
    conversationId: string
  ) => Promise<{ ok: boolean; reason?: string; fatal?: boolean }>
  /** 清除摘要检查点，回到全文历史（原始消息一直在，所以无损） */
  clearAgentContextSummary: (
    conversationId: string
  ) => Promise<{ ok: boolean; reason?: string; fatal?: boolean }>
  /** 删除某条消息及其之后的全部消息（用于「从这里重新开始」）；流式期间由 UI 侧禁用 */
  deleteAgentMessagesFrom: (messageId: string, conversationId: string) => Promise<void>
  /** 编辑后重发：删掉这条及其之后的全部消息，再用新文本重新发起这一轮 */
  resendAgentMessage: (messageId: string, text: string, conversationId: string) => Promise<void>
  /** 断流重试：找到该 assistant 消息前一条用户消息，删掉它及其之后、用原文本重发这一轮 */
  retryAgentTurn: (conversationId: string, assistantMessageId: string) => Promise<void>
  /**
   * 发出该会话的一条用户消息。
   *
   * ⚠️ 这也**是草稿「转正」的那一刻**：写 `kind`（按选中的模型定）、把标题换成首条消息、
   * 落盘 —— 一条草稿在此之前不进列表、也不落盘（见 `isDraftConversation`）。
   */
  sendAgentMessage: (text: string, conversationId: string) => Promise<void>
  /**
   * **用户点发送时走的入口**：会话空闲就直接发，正在跑就排进 `agentQueues`。
   * `sendAgentMessage` 是「一定真的发一轮」的底层动作，不含入队判断。
   */
  submitAgentMessage: (text: string, conversationId: string) => Promise<void>
  /** 把一条消息追加到该会话的待发送队列 */
  enqueueAgentMessage: (text: string, conversationId: string) => void
  /** 从队列里删掉一条 */
  removeQueuedAgentMessage: (id: string, conversationId: string) => void
  /** 立刻发送队列里的某一条（摘出来马上开新一轮；会话正在跑则忽略） */
  sendQueuedAgentMessage: (id: string, conversationId: string) => Promise<void>
  /** 队列泵：会话空闲且队列非空时弹出第一条接着发（本轮结束时 / 切到空闲会话时调用） */
  pumpAgentQueue: (conversationId: string) => void
  /** 中止指定会话的对话（必传，理由同 `sendAgentMessage`） */
  abortAgent: (conversationId: string) => Promise<void>
  handleAgentEvent: (requestId: string, event: AgentStreamEvent) => void
  /**
   * 打开 ACP 会话时回放它的历史（`session/load`）。同一会话重复调用只会真正回放一次
   * （主进程去重），所以会话标签反复挂载 / StrictMode 双跑都安全。
   */
  loadAcpHistory: (conversationId: string) => Promise<void>
  /**
   * 回复改动类工具的确认请求：approved=true 执行，false 取消。
   * 终端助手与工作区 Agent 共用（同一张 `pendingConfirms` 表、同一条通道）。
   */
  resolveAgentConfirm: (id: string, approved: boolean) => Promise<void>
  /**
   * 提交 `ask_followup_question` 的回答。`toolCallId` 定位卡片（也是 followupRequests 的 key），
   * `answer` 传 null 表示跳过 —— 工具会拿到「未作答」并自行继续。
   */
  resolveFollowup: (toolCallId: string, answer: AskFollowupAnswer | null) => Promise<void>
}

export interface SkillsSlice {
  /** 磁盘上扫描到的技能（含未启用的，由 skillSettings.disabled 决定用不用） */
  skills: SkillInfo[]
  /** 各个技能根目录的扫描情况（设置页展示「扫了哪些地方」） */
  skillRoots: SkillRootInfo[]
  /** 技能的用户选择（启停 / 额外根目录）；null = 尚未加载 */
  skillSettings: SkillSettings | null
  /**
   * 重新扫描技能（设置页打开 / 改完设置后调用）。
   * 工作区级技能取**当前选中的工作区**；技能内容在磁盘上，所以每次都是实扫。
   */
  loadSkills: () => Promise<void>
  /** 保存技能设置（启停 / 额外根目录）并重新扫描 */
  saveSkillSettings: (patch: Partial<SkillSettings>) => Promise<void>
}

export interface UiSlice {
  ui: UiState
  /** 开/关某个终端页面（会话）的 AI 助手浮窗 */
  setSessionAiOpen: (sessionId: string, open: boolean) => void
  /** 最小化/展开 AI 浮窗的消息列表区 */
  setAiMinimized: (sessionId: string, minimized: boolean) => void
  /** 移动 AI 浮窗（null = 恢复默认底部居中） */
  setAiFloatingPos: (pos: { x: number; y: number } | null) => void
  setSettingsOpen: (open: boolean, tab?: UiState['settingsTab']) => void
  setCommandPaletteOpen: (open: boolean) => void
  /** 设置页开始/结束录制快捷键（录制期间挂起应用内快捷键分发） */
  setShortcutRecording: (recording: boolean) => void
  /** 请求开关一次 AI Agent 内嵌终端（快捷键触发；由 AgentPage 消费 ui.agentTerminalToggle） */
  toggleAgentTerminal: () => void
  /** 执行一个快捷键动作（应用内快捷键命中后调用） */
  runShortcutAction: (action: AppShortcutAction) => void
  /** 切换功能区（活动栏 tab）：主区域与侧边栏都由它派生，不再单独存 view */
  selectActivity: (id: string) => void
  /** 重排活动栏功能区（拖拽图标后写入完整 id 顺序） */
  setActivityOrder: (order: string[]) => void
  setSidebarWidth: (width: number) => void
  /** 折叠/展开「当前功能区」自己的侧边栏（侧边栏属于功能区，互不影响） */
  setSidebarCollapsed: (collapsed: boolean) => void
  /** 折叠/展开侧边栏内的某个纵向分区（分区 id 见 section-ids.ts） */
  setSectionCollapsed: (id: string, collapsed: boolean) => void
  /** 设置可拖拽分区的高度（px，由分区间拖拽条写入，见 StackedSections 的 SectionResizer） */
  setSectionHeight: (id: string, height: number) => void
  /**
   * 定位到「脚本」分区：切回主机功能区并展开侧边栏与脚本分区。
   *
   * 脚本不再是独立功能区（只服务于主机，见 section-ids.ts），
   * 凡是原先「跳到脚本功能区」的入口（状态栏菜单、命令面板）都改走这里。
   */
  openScriptsSection: () => void
  setAiPanelWidth: (width: number) => void
  /** 设置 AI 助手浮窗展开高度（px，含输入横条） */
  setAiPanelHeight: (height: number) => void
  /** 选择要查看的插件（null 表示取消选择） */
  selectPlugin: (id: string | null) => void
  /** 打开/关闭 SSH 配置弹窗（editing=null 为新建；groupId 预设新建时的分组） */
  setSshDialog: (open: boolean, editing?: SshProfile | null, groupId?: string) => void
  /** 打开/关闭「运行脚本」对话框（可预设要运行的脚本） */
  setRunScriptDialog: (open: boolean, scriptId?: string) => void
}

export interface PluginSlice {
  /** 已加载插件的视图实例（侧边栏入口 + 主区域渲染组件） */
  plugins: PluginViewInstance[]
  /** 插件管理页列表（含启用状态/加载错误），与 plugins 分开以支撑管理操作 */
  pluginList: PluginInfo[]
  /** 插件通过宿主注册的命令面板命令 */
  pluginCommands: Record<string, { pluginId: string; title: string; run: () => void }>
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
}

export interface MonitorSlice {
  /** 各会话最新指标，key 为 sessionId；无该 key 表示取不到数据（不显示指标） */
  monitors: Record<string, ServerMetrics>
  /**
   * 被判定为「不支持监控」的会话（非 Linux 主机 / 采集持续无效），key 为 sessionId，
   * 值为判定原因（windows / other / unavailable）。有新鲜指标推送时自动清除。
   */
  monitorUnsupported: Record<string, MonitorUnsupportedReason>
}

export interface TransferSlice {
  /** 进行中 / 已结束的 SFTP 传输任务（transferId → 进度）；全局，供状态栏任务面板展示。
   *  结束的不会自动移除，直到用户逐条移除或「清除已完成」（用户要求：完成后留在托盘里） */
  transfers: Record<string, TransferItem>
  /** 状态栏右下角传输任务面板是否展开 */
  transferTrayOpen: boolean
  /** 写入 / 更新一笔 SFTP 传输进度（来自 sftp:progress 广播；结束的保留在托盘，不自动移除） */
  upsertTransfer: (progress: SftpTransferProgress) => void
  /** 从任务面板移除一笔传输（用户手动关闭） */
  removeTransfer: (transferId: string) => void
  /** 清空所有已结束（成功/失败/取消）的传输 */
  clearFinishedTransfers: () => void
  /** 展开 / 收起状态栏右下角的传输任务面板 */
  setTransferTrayOpen: (open: boolean) => void
  toggleTransferTray: () => void
}

export interface DataTransferSlice {
  /**
   * 导出：弹保存对话框 → 主进程把选中的类型各写成一个 JSON 后打包成 zip。
   * 返回主进程的结果（含保存路径与各类型条目数），取消时不提示。
   */
  exportData: (kinds: TransferKind[]) => Promise<TransferExportResult>
  /** 导入第一步：选 zip 并解析，返回可导入项摘要（bundleId 指向主进程里暂存的内容） */
  pickImportBundle: () => Promise<TransferPickResult>
  /** 导入第二步：把勾选的类型写回库，成功后刷新对应的列表（分组可能一起进来） */
  applyImport: (bundleId: string, kinds: TransferKind[]) => Promise<TransferImportResult>
  /** 放弃这次导入（丢掉主进程里暂存的解析结果） */
  cancelImport: (bundleId: string) => Promise<void>
}
