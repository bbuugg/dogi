import { HOSTS_ACTIVITY_ID } from '@/app/activity-ids'
import { HOSTS_SCRIPTS_SECTION_ID } from '@/app/section-ids'
import { parseCurl } from '@/features/api/api-client'
import {
  firstGroupId,
  genPaneId,
  insertSibling,
  makeLeaf,
  removeLeaf,
  updateSizes,
  type PaneNode,
  type SplitDirectionInput
} from '@/app/layout/pane-layout'
import { scriptToTerminalInput } from '@/features/scripts/script'
import { clampTerminalFontSize } from '@/features/terminal/terminal-font'
import { applyColorTheme } from '@/shared/lib/theme'
import type { PluginViewInstance } from '@/features/plugins/host'
import type { PluginInfo } from '@shared/plugin'
import { DEFAULT_SHORTCUTS, findShortcutByEvent } from '@shared/shortcuts'
import type {
  AgentChatMessage,
  AgentConfirmRequest,
  AgentConversation,
  AgentStreamEvent,
  AgentWorkspace,
  AgentBackend,
  AiChatMessage,
  AiConfirmRequest,
  AiMessagePart,
  AiModelConfig,
  AiPermissionMode,
  AiSettings,
  AiStreamEvent,
  ApiGroup,
  ApiHistoryEntry,
  ApiProtocol,
  ApiRequestEntry,
  AppShortcutAction,
  ColorThemeName,
  NoteEntry,
  NoteGroup,
  Preferences,
  ScriptEntry,
  ScriptGroup,
  ServerMetrics,
  SessionInfo,
  ShellDetectResult,
  ShortcutConfig,
  SshConnectProgress,
  SshGroup,
  SshProfile,
  TerminalThemeName,
  ThemeMode
} from '@shared/types'
import { create } from 'zustand'

/** PanelView 标签类型（终端会话也是其中一种，不再有独立的「终端」固定标签） */
export type PanelTabType = 'terminal' | 'script' | 'note' | 'api' | 'plugins' | 'plugin'

/** 编辑页（脚本 / 笔记）的保存状态，由页面自己投影到底部状态栏 */
export type EditorSaveState = 'saving' | 'dirty' | 'saved'

/**
 * 状态栏保存状态的键。
 *
 * 脚本 id / 笔记 id / 接口请求 id 来自三张不同的表、理论上可能撞车，所以带上类型前缀区分。
 * `api` 与 `ws` 其实同属 apiRequests 一张表（id 不会撞），分开只是为了状态栏的提示语
 * 能分别显示「接口请求」和「WebSocket」。
 */
export const editorSaveKey = (kind: 'script' | 'note' | 'api' | 'ws', id: string): string =>
  `${kind}:${id}`

/**
 * 等待二次确认的关闭操作。
 *
 * 用户开了「关闭标签前二次确认」（`Preferences.confirmCloseTab`）时，
 * 关闭入口不直接关，而是挂到这里，由 `TabCloseConfirm` 弹框后再真正执行。
 */
export type PendingTabClose =
  | { kind: 'tab'; tabId: string; label: string }
  | { kind: 'group'; groupId: string; count: number }

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
  closable: boolean
  /** 所属面板组（分屏树的一个叶子） */
  groupId: string
  /** terminal：对应的终端会话 id */
  sessionId?: string
  scriptId?: string
  noteId?: string
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

/** 打开一个已保存的主机会话：主进程按主机类型（ssh / local）决定启动方式 */
function openSession(profileId: string, cols = 80, rows = 24): Promise<SessionInfo> {
  return window.api.terminal.createFromProfile(profileId, cols, rows)
}

/** 终端字号持久化写入的防抖句柄（Ctrl+滚轮会触发连续调整） */
let fontSizeSaveTimer: number | undefined

/**
 * 插件列表变化（禁用 / 卸载 / 重载 / 刷新）后，若插件管理页选中的插件已不在列表中，
 * 清空选中，避免右侧详情停留在已卸载插件的残留数据上。
 */
function withPluginList(ui: UiState, list: PluginInfo[]): UiState {
  if (!ui.activePluginId || list.some((p) => p.id === ui.activePluginId)) return ui
  return { ...ui, activePluginId: null }
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
}

function emptyAgentRun(): AgentRunState {
  return { streaming: false, requestId: null, error: null }
}

/** requestId -> conversationId：把 Agent 流式事件路由到发起对话的那个会话 */
const agentRequestConversations = new Map<string, string>()

/** 会话默认标题（用户没命名、也没发过消息时显示） */
const DEFAULT_CONVERSATION_TITLE = '新会话'

/** 由首条用户消息生成会话标题：取首行、截断到 30 字 */
function titleFromMessage(text: string): string {
  const firstLine = text.split('\n')[0].trim()
  if (!firstLine) return DEFAULT_CONVERSATION_TITLE
  return firstLine.length > 30 ? `${firstLine.slice(0, 30)}…` : firstLine
}

/** 新建一个内存态会话（落盘时机见 persistConversation） */
function newConversation(workspaceId: string): AgentConversation {
  const now = Date.now()
  return {
    id: crypto.randomUUID(),
    workspaceId,
    title: DEFAULT_CONVERSATION_TITLE,
    messages: [],
    createdAt: now,
    updatedAt: now
  }
}

/** 取某工作区最近更新的会话（没有则 null） */
function latestConversation(
  conversations: AgentConversation[],
  workspaceId: string
): AgentConversation | null {
  let best: AgentConversation | null = null
  for (const c of conversations) {
    if (c.workspaceId !== workspaceId) continue
    if (!best || c.updatedAt > best.updatedAt) best = c
  }
  return best
}

/**
 * 选中某工作区要展示的会话：优先最近更新的那个，一个都没有就现建一个空会话 ——
 * 保证「点开工作区就能直接输入」，不用先手动新建。
 */
function ensureConversation(
  conversations: AgentConversation[],
  workspaceId: string
): { conversations: AgentConversation[]; activeId: string | null } {
  if (!workspaceId) return { conversations, activeId: null }
  const latest = latestConversation(conversations, workspaceId)
  if (latest) return { conversations, activeId: latest.id }
  const created = newConversation(workspaceId)
  return { conversations: [...conversations, created], activeId: created.id }
}

/** 修改某个会话（浅合并），同时把 updatedAt 推到当前时刻 */
function patchConversation(
  conversations: AgentConversation[],
  id: string,
  patch: Partial<AgentConversation>
): AgentConversation[] {
  return conversations.map((c) => (c.id === id ? { ...c, ...patch, updatedAt: Date.now() } : c))
}

/**
 * 把会话当前内容写盘。
 *
 * 只写不读回：调用期间流式输出可能又追加了 part，用主进程的返回值覆盖本地会丢内容。
 */
async function persistConversation(
  conversations: AgentConversation[],
  id: string
): Promise<void> {
  const conversation = conversations.find((c) => c.id === id)
  if (!conversation) return
  await window.api.agent.saveConversation({
    id: conversation.id,
    workspaceId: conversation.workspaceId,
    title: conversation.title,
    messages: conversation.messages
  })
}

/** Agent 回复生成中的占位 assistant 消息尾部追加 part */
function appendAgentPart(parts: AgentChatMessage['parts'], event: AgentStreamEvent) {
  const next = [...parts]
  if (event.type === 'text-delta') {
    const last = next[next.length - 1]
    if (last?.type === 'text') {
      next[next.length - 1] = { type: 'text', text: last.text + event.delta }
    } else {
      next.push({ type: 'text', text: event.delta })
    }
  } else if (event.type === 'reasoning-delta') {
    const last = next[next.length - 1]
    if (last?.type === 'reasoning') {
      next[next.length - 1] = { type: 'reasoning', text: last.text + event.delta }
    } else {
      next.push({ type: 'reasoning', text: event.delta })
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
    next.push({
      type: 'text',
      text: `⚠️ ${event.message}`
    })
  }
  return next
}

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

/** 从所在组摘掉一个标签；若组因此变空则返回被移除的组 ID（连同其标签一起清理） */
function withoutTab(
  groups: Record<string, PanelGroup>,
  tabs: PanelTab[],
  tabId: string
): { groups: Record<string, PanelGroup>; tabs: PanelTab[]; removedGroupId: string | null } {
  const tab = tabs.find((t) => t.id === tabId)
  if (!tab) return { groups, tabs, removedGroupId: null }
  const nextTabs = tabs.filter((t) => t.id !== tabId)
  const g = groups[tab.groupId]
  if (!g) return { groups, tabs: nextTabs, removedGroupId: null }
  const tabIds = g.tabIds.filter((x) => x !== tabId)
  const next: Record<string, PanelGroup> = { ...groups }
  let removedGroupId: string | null = null
  if (tabIds.length === 0) {
    delete next[tab.groupId]
    removedGroupId = tab.groupId
  } else {
    next[tab.groupId] = {
      ...g,
      tabIds,
      activeTabId: g.activeTabId === tabId ? (tabIds[tabIds.length - 1] ?? null) : g.activeTabId
    }
  }
  return { groups: next, tabs: nextTabs, removedGroupId }
}

/**
 * 重算焦点：优先保留原焦点组，组已消失则回退到布局里的第一个组。
 * activeSessionId 只在激活标签是终端时改变（切到脚本/笔记标签不该让「当前终端」丢失）。
 */
function resolveFocus(
  layout: PaneNode | null,
  groups: Record<string, PanelGroup>,
  tabs: PanelTab[],
  preferGroupId: string | null,
  prevSessionId: string | null
): { activeGroupId: string | null; activeSessionId: string | null } {
  const activeGroupId =
    preferGroupId && groups[preferGroupId]
      ? preferGroupId
      : (firstGroupId(layout) ?? Object.keys(groups)[0] ?? null)
  const g = activeGroupId ? groups[activeGroupId] : undefined
  const tab = g?.activeTabId ? tabs.find((t) => t.id === g.activeTabId) : undefined
  return {
    activeGroupId,
    activeSessionId: tab?.type === 'terminal' ? (tab.sessionId ?? prevSessionId) : prevSessionId
  }
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
    | 'ui'
  >,
  id: string
): Partial<AppStore> {
  const sessions = s.sessions.filter((x) => x.id !== id)
  const tab = s.ui.panelTabs.find((t) => t.type === 'terminal' && t.sessionId === id)
  const { groups, tabs, removedGroupId } = tab
    ? withoutTab(s.groups, s.ui.panelTabs, tab.id)
    : { groups: s.groups, tabs: s.ui.panelTabs, removedGroupId: null }
  const layout = removedGroupId ? removeLeaf(s.layout, removedGroupId) : s.layout
  // 关掉的若是当前会话，焦点回落到原组（或布局里的第一个组）
  const focus = resolveFocus(
    layout,
    groups,
    tabs,
    s.activeGroupId,
    s.activeSessionId === id ? null : s.activeSessionId
  )
  const exited = new Set(s.exitedSessions)
  exited.delete(id)
  const monitors = { ...s.monitors }
  delete monitors[id]
  // 会话关闭，其独立的 AI 对话与 AI 面板开关随之清理
  const aiChats = { ...s.aiChats }
  delete aiChats[id]
  const aiOpenSessions = { ...s.ui.aiOpenSessions }
  delete aiOpenSessions[id]
  const aiMinimizedSessions = { ...s.ui.aiMinimizedSessions }
  delete aiMinimizedSessions[id]
  // 连接进度也随之清理
  const connectStages = { ...s.connectStages }
  delete connectStages[id]
  return {
    sessions,
    groups,
    layout,
    activeGroupId: focus.activeGroupId,
    activeSessionId: focus.activeSessionId,
    exitedSessions: exited,
    monitors,
    aiChats,
    connectStages,
    ui: { ...s.ui, panelTabs: tabs, aiOpenSessions, aiMinimizedSessions }
  }
}

/**
 * 新会话作为终端标签加入当前激活组（没有可用组时新建组并重置布局），并聚焦它。
 * 打开连接、新建本地终端都走这里，保证「打开 = 在 PanelView 里多一个标签」。
 */
function attachSessionTab(s: AppStore, info: SessionInfo): Partial<AppStore> {
  const tabs = [...s.ui.panelTabs]
  const groups = { ...s.groups }
  const base = {
    id: terminalTabId(info.id),
    type: 'terminal' as const,
    title: info.title || '终端',
    closable: true,
    sessionId: info.id
  }
  let activeGroupId =
    (s.activeGroupId && groups[s.activeGroupId] ? s.activeGroupId : null) ??
    firstGroupId(s.layout)
  if (!activeGroupId || !groups[activeGroupId]) {
    const gid = genPaneId()
    groups[gid] = { id: gid, tabIds: [base.id], activeTabId: base.id }
    tabs.push({ ...base, groupId: gid })
    return {
      sessions: [...s.sessions, info],
      groups,
      layout: makeLeaf(gid),
      activeGroupId: gid,
      activeSessionId: info.id,
      ui: { ...s.ui, panelTabs: tabs }
    }
  }
  const g = groups[activeGroupId]
  groups[activeGroupId] = { ...g, tabIds: [...g.tabIds, base.id], activeTabId: base.id }
  tabs.push({ ...base, groupId: activeGroupId })
  return {
    sessions: [...s.sessions, info],
    groups,
    activeGroupId,
    activeSessionId: info.id,
    ui: { ...s.ui, panelTabs: tabs }
  }
}

/** 聚焦一个已存在的标签（切换其所在组的激活标签 + 聚焦该组） */
function focusTabPatch(s: AppStore, tab: PanelTab): Partial<AppStore> {
  const g = s.groups[tab.groupId]
  return {
    activeGroupId: tab.groupId,
    activeSessionId: tab.type === 'terminal' ? (tab.sessionId ?? s.activeSessionId) : s.activeSessionId,
    groups:
      g && g.activeTabId !== tab.id
        ? { ...s.groups, [tab.groupId]: { ...g, activeTabId: tab.id } }
        : s.groups
  }
}

/** 关闭一个「非终端」标签（脚本/笔记/插件管理/插件视图）：摘掉标签与空组，并重算焦点 */
function closePlainTab(s: AppStore, tabId: string): Partial<AppStore> {
  const { groups, tabs, removedGroupId } = withoutTab(s.groups, s.ui.panelTabs, tabId)
  const layout = removedGroupId ? removeLeaf(s.layout, removedGroupId) : s.layout
  const focus = resolveFocus(layout, groups, tabs, s.activeGroupId, s.activeSessionId)
  return {
    groups,
    layout,
    activeGroupId: focus.activeGroupId,
    activeSessionId: focus.activeSessionId,
    ui: { ...s.ui, panelTabs: tabs }
  }
}

/**
 * 插件视图消失（卸载 / 禁用 / 重载）后，把指向它的插件标签一并关掉。
 *
 * 插件不再往活动栏挂条目，所以「插件没了」只剩标签这一处残留需要收拾：
 * 留着只会停在「插件视图未加载」上。与脚本 / 笔记的删除同理，标签生命周期
 * 跟着对象走。
 */
function closeMissingPluginTabs(
  s: AppStore,
  views: PluginViewInstance[]
): Partial<AppStore> {
  const alive = new Set(views.map((v) => v.viewId))
  const stale = new Set(
    s.ui.panelTabs
      .filter((t) => t.type === 'plugin' && (!t.pluginViewId || !alive.has(t.pluginViewId)))
      .map((t) => t.id)
  )
  if (stale.size === 0) return {}
  const tabs = s.ui.panelTabs.filter((t) => !stale.has(t.id))
  const groups: Record<string, PanelGroup> = {}
  let layout = s.layout
  for (const [id, g] of Object.entries(s.groups)) {
    const tabIds = g.tabIds.filter((x) => !stale.has(x))
    if (tabIds.length === 0) {
      layout = removeLeaf(layout, id)
      continue
    }
    groups[id] = {
      ...g,
      tabIds,
      activeTabId:
        g.activeTabId && stale.has(g.activeTabId)
          ? (tabIds[tabIds.length - 1] ?? null)
          : g.activeTabId
    }
  }
  const focus = resolveFocus(layout, groups, tabs, s.activeGroupId, s.activeSessionId)
  return {
    groups,
    layout,
    activeGroupId: focus.activeGroupId,
    activeSessionId: focus.activeSessionId,
    ui: { ...s.ui, panelTabs: tabs }
  }
}

/** 打开标签：已打开则聚焦，否则加入当前激活组（脚本/笔记/插件都走这里） */
function addOrFocusTab(s: AppStore, tab: Omit<PanelTab, 'groupId'>): Partial<AppStore> {
  const existing = s.ui.panelTabs.find((t) => t.id === tab.id)
  if (existing) return focusTabPatch(s, existing)

  let activeGroupId =
    (s.activeGroupId && s.groups[s.activeGroupId] ? s.activeGroupId : null) ??
    firstGroupId(s.layout)
  if (!activeGroupId || !s.groups[activeGroupId]) {
    const gid = genPaneId()
    return {
      groups: { ...s.groups, [gid]: { id: gid, tabIds: [tab.id], activeTabId: tab.id } },
      layout: makeLeaf(gid),
      activeGroupId: gid,
      ui: { ...s.ui, panelTabs: [...s.ui.panelTabs, { ...tab, groupId: gid }] }
    }
  }
  const g = s.groups[activeGroupId]
  return {
    groups: { ...s.groups, [activeGroupId]: { ...g, tabIds: [...g.tabIds, tab.id], activeTabId: tab.id } },
    activeGroupId,
    ui: { ...s.ui, panelTabs: [...s.ui.panelTabs, { ...tab, groupId: activeGroupId }] }
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

interface UiState {
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
   * 等待二次确认的关闭操作（null = 没有待确认的关闭）。
   * 只在 `Preferences.confirmCloseTab` 开启时才会被写入，弹框见 TabCloseConfirm。
   */
  pendingTabClose: PendingTabClose | null
  /**
   * 设置页是否正在录制快捷键。
   *
   * 录制时全局的 keydown 分发必须让路，否则按下的组合会**既被录进去、又把动作执行一遍**
   * （两边都监听 window 的捕获阶段，注册更早的分发会先跑）。所以录制期间用一个标志位挂起分发。
   */
  shortcutRecording: boolean
}

interface AppStore {
  // ---------- 终端 ----------
  sessions: SessionInfo[]
  activeSessionId: string | null
  exitedSessions: Set<string>
  /**主机中的会话阶段（key 为 sessionId；连接就绪/失败/关闭后移除） */
  connectStages: Record<string, SshConnectProgress>
  /** 分屏布局树：每个叶子承载一个面板组；null 表示还没有任何标签页 */
  layout: PaneNode | null
  /** 所有面板组，key 为组 ID */
  groups: Record<string, PanelGroup>
  /** 当前聚焦的组 ID（决定新建标签落在哪个组，以及监控/AI 的上下文） */
  activeGroupId: string | null

  // ---------- SSH ----------
  profiles: SshProfile[]
  /**主机分组（侧边栏归类用） */
  sshGroups: SshGroup[]

  // ---------- 用户脚本 ----------
  scripts: ScriptEntry[]
  /** 脚本分组（侧边栏里的分组节点，数组顺序即显示顺序） */
  scriptGroups: ScriptGroup[]

  // ---------- 笔记 ----------
  notes: NoteEntry[]
  /** 笔记分组（侧边栏里的分组节点，数组顺序即显示顺序） */
  noteGroups: NoteGroup[]

  // ---------- 接口请求 ----------
  /** 保存的接口请求（侧边栏列表；一个请求对应 PanelView 里的一个标签） */
  apiRequests: ApiRequestEntry[]
  /** 接口请求分组（侧边栏里的分组节点，数组顺序即显示顺序） */
  apiGroups: ApiGroup[]
  /** 请求历史（发送后自动记录，按时间倒序） */
  apiHistory: ApiHistoryEntry[]

  // ---------- 偏好 ----------
  preferences: Preferences
  /**
   * 应用内快捷键配置（动作 -> accelerator）。
   *
   * 由**渲染端**在 window 上监听 keydown 自行匹配分发（见 bootstrap 里的 shortcutWired），
   * 不用 Electron 的 globalShortcut —— 那是系统级的，会占用全局组合键、和别的程序抢。
   */
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

  // ---------- AI Agent（工作区编程助手） ----------
  agentWorkspaces: AgentWorkspace[]
  /** 当前选中的工作区 id */
  activeAgentWorkspaceId: string | null
  /**
   * 全部会话（含消息历史）。一个工作区下可以有多个会话，`workspaceId` 决定归属。
   *
   * 这是消息的唯一真源，也是落盘的那份；新建的空会话先只存在于内存，
   * 等真的发出第一条消息（或改标题）才写盘，避免留下一堆空记录。
   */
  agentConversations: AgentConversation[]
  /** 当前选中的会话 id（主区域 AgentPage 展示它） */
  activeAgentConversationId: string | null
  /** 各会话的运行时状态（key 为 conversationId） */
  agentRuns: Record<string, AgentRunState>
  /** Agent 确认模式下等待用户处理的命令执行请求（key 为确认 id） */
  agentPendingConfirms: Record<string, AgentConfirmRequest>

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
  /** 新建本地终端标签（不传 shellId 时用偏好设置的默认本地终端），落在当前激活组 */
  createLocalSession: (shellId?: string) => Promise<void>
  /** 连接一个已保存的主机（ssh 远程 / local 本地）：作为新标签打开，返回新会话信息 */
  connectHost: (profile: SshProfile) => Promise<SessionInfo>
  /** 连接指定主机并在其上执行脚本：连接就绪后把脚本写入该会话，返回是否执行成功 */
  runScriptOnHost: (profile: SshProfile, script: ScriptEntry) => Promise<boolean>
  closeSession: (id: string) => Promise<void>
  /** 会话结束后重连：按原类型/SSH 配置新建一个会话并替换旧的 */
  reconnectSession: (id: string) => Promise<void>
  setActiveSession: (id: string) => void
  /** 聚焦某个面板组 */
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
  /** 执行一个快捷键动作（应用内快捷键命中后调用） */
  runShortcutAction: (action: AppShortcutAction) => void
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
  /** 刷新笔记列表到 store */
  refreshNotes: () => Promise<void>
  /** 新建一篇空笔记并返回其 id（默认语言 markdown）；groupId 用于「在某分组内新建」 */
  createNote: (groupId?: string) => Promise<string>
  /** 保存笔记（upsert）：已有笔记原地更新 */
  saveNote: (note: NoteEntry) => Promise<void>
  /** 删除笔记，并关掉它的标签页 */
  deleteNote: (id: string) => Promise<void>
  /** 刷新笔记分组到 store */
  refreshNoteGroups: () => Promise<void>
  /** 新建（不传 id）或重命名（传 id）笔记分组 */
  saveNoteGroup: (input: { id?: string; name: string }) => Promise<void>
  /** 删除分组；deleteNotes=true 时连同组内笔记一起删除 */
  deleteNoteGroup: (id: string, deleteNotes?: boolean) => Promise<void>
  /** 拖拽排序 / 换组后的整体重排：数组顺序即显示顺序 */
  arrangeNotes: (payload: {
    groupIds: string[]
    notes: Array<{ id: string; groupId?: string }>
  }) => Promise<void>
  /** 选择要查看的插件（null 表示取消选择） */
  selectPlugin: (id: string | null) => void
  /** 在 PanelView 中打开脚本标签（已存在则激活） */
  openScriptTab: (scriptId: string) => void
  /** 在 PanelView 中打开笔记标签（已存在则激活） */
  openNoteTab: (noteId: string) => void
  /** 在 PanelView 中打开接口请求标签（已存在则激活） */
  openApiTab: (requestId: string) => void
  /**
   * 打开一个「未保存的新请求」草稿标签（不落盘，保存时才写进列表）。
   * `protocol` 决定草稿是 HTTP 还是 WebSocket（两者用不同的草稿标签 id）。
   */
  openNewApiDraft: (groupId?: string, protocol?: ApiProtocol) => void
  /** 在 PanelView 中打开插件管理标签（已存在则激活） */
  openPluginsTab: () => void
  /** 在 PanelView 中打开插件视图标签（已存在则激活） */
  openPluginTab: (viewId: string) => void
  /** 激活 PanelView 中的指定标签 */
  activatePanelTab: (id: string) => void
  /** 关闭 PanelView 中的指定标签 */
  closePanelTab: (id: string) => void
  /**
   * 请求关闭标签：**用户入口一律走这个**，别直接调 `closePanelTab`。
   * 开了「关闭标签前二次确认」时先挂起等弹框，否则立即关闭。
   * （`closePanelTab` 保留为「无条件关闭」，供保存草稿后关标签之类的程序化场景使用。）
   */
  requestClosePanelTab: (id: string) => void
  /** 请求关闭整个面板组：同 `requestClosePanelTab`，也走二次确认 */
  requestCloseGroup: (groupId: string) => void
  /** 取消待确认的关闭（弹框点「取消」） */
  cancelPendingTabClose: () => void
  /** 确认待确认的关闭；dontAskAgain=true 时顺手把「二次确认」设置关掉 */
  confirmPendingTabClose: (dontAskAgain: boolean) => Promise<void>
  /** 更新 PanelView 标签标题 */
  updatePanelTabTitle: (id: string, title: string) => void
  /** 上报某个编辑页（脚本 / 笔记）的保存状态（由状态栏的 EditorSaveStatus 读取，key 见 `editorSaveKey`） */
  setEditorSaveStatus: (key: string, state: EditorSaveState) => void
  /** 打开/关闭 SSH 配置弹窗（editing=null 为新建；groupId 预设新建时的分组） */
  setSshDialog: (open: boolean, editing?: SshProfile | null, groupId?: string) => void
  /** 打开/关闭「运行脚本」对话框（可预设要运行的脚本） */
  setRunScriptDialog: (open: boolean, scriptId?: string) => void
  refreshAiConfigs: () => Promise<void>
  /** 重新拉取 AI 设置（删除/新建配置后同步 activeConfigId，避免渲染端悬空） */
  refreshAiSettings: () => Promise<void>
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
  /** 关闭标签页前是否二次确认（持久化到偏好设置；确认框里勾「以后都不再提示」会把它关掉） */
  setConfirmCloseTab: (enabled: boolean) => Promise<void>
  /** 设置本地终端默认 shell（持久化到偏好设置） */
  setLocalShell: (shellId: string) => Promise<void>
  setTerminalFontSize: (size: number) => Promise<void>
  /** 设置服务器指标采集间隔（毫秒）：立即生效并持久化 */
  /**
   * 保存快捷键配置（持久化到主进程）。
   * 应用内快捷键是「每次按键现读 store 匹配」，所以落盘后无需任何重注册，立刻生效。
   */
  saveShortcuts: (shortcuts: ShortcutConfig[]) => Promise<void>
  setMonitorInterval: (ms: number) => Promise<void>
  sendAiMessage: (text: string, targetSessionId?: string | null) => Promise<void>
  abortAi: (sessionId: string) => Promise<void>
  clearAiMessages: (sessionId: string) => void
  handleAiEvent: (requestId: string, event: AiStreamEvent) => void
  /** 重新拉取 Agent 工作区列表 */
  loadAgentWorkspaces: () => Promise<void>
  /** 保存工作区（同名路径视为更新）；返回最新列表 */
  saveAgentWorkspace: (input: {
    id?: string
    name: string
    path: string
    backend?: AgentBackend
  }) => Promise<void>
  deleteAgentWorkspace: (id: string) => Promise<void>
  /** 切换工作区的 Agent 后端（内置 AI SDK / 外部 ACP agent），每会话独立 */
  setAgentWorkspaceBackend: (id: string, backend: AgentBackend) => Promise<void>
  /** 选中工作区：自动定位到它最近更新的会话（一个都没有则新建一个空会话） */
  selectAgentWorkspace: (id: string) => void
  /** 新建会话（默认建在当前工作区下）并选中；仅内存，发出首条消息后才落盘 */
  createAgentConversation: (workspaceId?: string) => void
  /** 选中会话（AgentPage 切换到它的消息） */
  selectAgentConversation: (id: string) => void
  /** 重命名会话（立即落盘） */
  renameAgentConversation: (id: string, title: string) => Promise<void>
  /** 删除会话；删的是当前会话时自动切到同工作区的下一个 */
  deleteAgentConversation: (id: string) => Promise<void>
  /** 清空当前会话的消息（保留会话本身） */
  clearAgentMessages: () => void
  /** 在当前选中的会话发起 Agent 对话 */
  sendAgentMessage: (text: string) => Promise<void>
  /** 中止对话；不传则中止当前选中的会话 */
  abortAgent: (conversationId?: string) => Promise<void>
  handleAgentEvent: (requestId: string, event: AgentStreamEvent) => void
  /** 回复 Agent 命令执行确认：approved=true 执行，false 取消 */
  resolveAgentConfirm: (id: string, approved: boolean) => Promise<void>
}

let listenersBound = false

export const useAppStore = create<AppStore>()((set, get) => {
/** 应用内快捷键的 keydown 监听器仅注册一次，避免 HMR / 重复 bootstrap 叠加 */
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
    // ---------- AI Agent 事件 ----------
    window.api.agent.onChatEvent(({ requestId, event }) => {
      get().handleAgentEvent(requestId, event)
    })
    window.api.agent.onConfirmRequest((req) => {
      set((s) => ({ agentPendingConfirms: { ...s.agentPendingConfirms, [req.id]: req } }))
    })
    // 确认已有结论（超时 / 中止等非用户路径）：移除对应卡片
    window.api.agent.onConfirmResolved(({ id }) => {
      set((s) => {
        if (!(id in s.agentPendingConfirms)) return {}
        const next = { ...s.agentPendingConfirms }
        delete next[id]
        return { agentPendingConfirms: next }
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
    scriptGroups: [],
    notes: [],
    noteGroups: [],
    apiRequests: [],
    apiGroups: [],
    apiHistory: [],

    preferences: { theme: 'system', colorTheme: 'neutral', customColor: '#3b82f6', terminalTheme: 'auto', copyOnSelect: true, rightClickPaste: true, commandPrediction: true, terminalFontSize: 13, localShell: 'default', minimizeToTray: true, monitorInterval: 2000, confirmCloseTab: true },

    shortcuts: DEFAULT_SHORTCUTS,

    shells: null,

    aiConfigs: [],
    aiSettings: { permissionMode: 'full' },
    aiChats: {},
    pendingConfirms: {},

    agentWorkspaces: [],
    activeAgentWorkspaceId: null,
    agentConversations: [],
    activeAgentConversationId: null,
    agentRuns: {},
    agentPendingConfirms: {},

    plugins: [],
    pluginList: [],
    pluginCommands: {},

    ui: {
      aiOpenSessions: {},
      aiMinimizedSessions: {},
      settingsOpen: false,
      sshDialog: { open: false, editing: null },
      runScriptDialog: { open: false },
      settingsTab: 'prefs',
      commandPaletteOpen: false,
      activeActivity: HOSTS_ACTIVITY_ID,
      collapsedActivities: {},
      collapsedSections: {},
      sectionHeights: {},
      activePluginId: null,
      panelTabs: [],
      sidebarWidth: 240,
      aiPanelWidth: 380,
      aiPanelHeight: 440,
      aiFloatingPos: null,
      editorSaveStatus: {},
      pendingTabClose: null,
      shortcutRecording: false
    },

    monitors: {},

    bootstrap: async () => {
      const [profiles, sshGroups, configs, settings, preferences, shells, scripts, scriptGroups, notes, noteGroups, apiRequests, apiGroups, apiHistory, shortcuts, agentWorkspaces, agentConversations] = await Promise.all([
        window.api.ssh.list(),
        window.api.ssh.listGroups(),
        window.api.ai.listConfigs(),
        window.api.ai.getSettings(),
        window.api.prefs.get(),
        window.api.terminal.listShells(),
        window.api.scripts.list(),
        window.api.scripts.listGroups(),
        window.api.notes.list(),
        window.api.notes.listGroups(),
        window.api.apiClient.list(),
        window.api.apiClient.listGroups(),
        window.api.apiClient.listHistory(),
        window.api.shortcuts.get(),
        window.api.agent.listWorkspaces(),
        window.api.agent.listConversations()
      ])
      // 配色必须在偏好写进 store 之前落到 html 上：antd 的 token 是在 store 更新引发的那次
      // 重渲染里从 CSS 变量读出来的，晚一步就会永远停在默认中性配色（直到用户手动切换）
      applyColorTheme(preferences.colorTheme, preferences.customColor)
      // 选中第一个工作区，并定位到它最近更新的会话（一个都没有就现建一个空会话）
      const initial = ensureConversation(agentConversations, agentWorkspaces[0]?.id ?? '')
      set({
        profiles,
        sshGroups,
        aiConfigs: configs,
        aiSettings: settings,
        preferences,
        shells,
        scripts,
        scriptGroups,
        notes,
        noteGroups,
        apiRequests,
        apiGroups,
        apiHistory,
        shortcuts,
        agentWorkspaces,
        agentConversations: initial.conversations,
        activeAgentWorkspaceId: agentWorkspaces[0]?.id ?? null,
        activeAgentConversationId: initial.activeId
      })
      // 运行时会加载外部插件（扫描 userData/plugins 并收集视图）
      const { loadPlugins } = await import('@/features/plugins/host')
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
      // 应用内快捷键：渲染端自己监听 keydown 匹配（不是系统级 globalShortcut，见 ShortcutConfig 的注释）
      if (!shortcutWired) {
        shortcutWired = true
        window.addEventListener(
          'keydown',
          (e) => {
            // 输入法组合中（如中文输入）不参与匹配，否则会误吞候选词按键
            if (e.isComposing) return
            // 长按的自动重复不触发：系统级热键本来只触发一次，按住不放不该连开十个终端
            if (e.repeat) return
            const s = get()
            // 设置页正在录制：让路，否则按下的组合会被录进去的同时把动作也跑一遍
            if (s.ui.shortcutRecording) return
            const hit = findShortcutByEvent(s.shortcuts, e)
            if (!hit) return
            // 捕获阶段拦下并阻止继续传播：让快捷键优先于 xterm / Monaco 自己的按键处理
            e.preventDefault()
            e.stopPropagation()
            s.runShortcutAction(hit.action)
          },
          true
        )
      }
    },

    setShortcutRecording: (recording) => set((s) => ({ ui: { ...s.ui, shortcutRecording: recording } })),

    runShortcutAction: (action) => {
      const s = get()
      if (action === 'open-settings') s.setSettingsOpen(true)
      else if (action === 'new-session') void s.createLocalSession()
      else if (action === 'open-command-palette') s.setCommandPaletteOpen(true)
    },

    createLocalSession: async (shellId) => {
      const info = await window.api.terminal.createLocal(80, 24, shellId)
      set((s) => attachSessionTab(s, info))
      // 新建终端后：切到主机侧边栏，方便继续挑主机
      get().selectActivity(HOSTS_ACTIVITY_ID)
    },

    connectHost: async (profile) => {
      const info = await openSession(profile.id)
      set((s) => attachSessionTab(s, info))
      // 连接后：切到主机侧边栏
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
        // 找到承载该会话的标签，原地替换会话 ID（保留组与标签位置）
        const nextTabId = terminalTabId(info.id)
        const tab = s.ui.panelTabs.find((t) => t.type === 'terminal' && t.sessionId === id)
        const tabs = tab
          ? s.ui.panelTabs.map((t) =>
              t.id === tab.id ? { ...t, id: nextTabId, sessionId: info.id } : t
            )
          : s.ui.panelTabs
        let groups = s.groups
        if (tab) {
          const g = s.groups[tab.groupId]
          if (g) {
            groups = {
              ...s.groups,
              [tab.groupId]: {
                ...g,
                tabIds: g.tabIds.map((x) => (x === tab.id ? nextTabId : x)),
                activeTabId: g.activeTabId === tab.id ? nextTabId : g.activeTabId
              }
            }
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
        return {
          sessions,
          groups,
          ui: { ...s.ui, panelTabs: tabs },
          activeGroupId: tab?.groupId ?? s.activeGroupId,
          activeSessionId: s.activeSessionId === id ? info.id : s.activeSessionId,
          exitedSessions: exited,
          monitors,
          aiChats
        }
      })
      reconnectingIds.delete(id)
    },

    splitActivePane: async (direction) => {
      // 只搬动标签：把当前激活标签拎到该方向的新组。
      // 组内只有这一个标签时不做事（拆了也还是同一个组，等于空操作）——
      // 这里不再「顺手新建一个终端」来凑分屏，标签操作不牵连其它功能。
      const s = get()
      const activeGroupId = s.activeGroupId
      if (!activeGroupId) return
      const g = s.groups[activeGroupId]
      if (!g || g.tabIds.length < 2) return
      const movingId = g.activeTabId ?? g.tabIds[0]
      get().splitTabToGroup(movingId, activeGroupId, direction)
    },

    moveTabToGroup: (tabId, targetGroupId, index) =>
      set((s) => {
        const tab = s.ui.panelTabs.find((t) => t.id === tabId)
        // 同组内拖动由 reorderTabs 处理；目标组必须存在
        if (!tab || tab.groupId === targetGroupId || !s.groups[targetGroupId]) return {}

        // 先从源组摘掉该标签（源组变空会被记录为 removedGroupId）
        const { groups: afterRemove, removedGroupId } = withoutTab(
          s.groups,
          s.ui.panelTabs,
          tabId
        )
        const target = afterRemove[targetGroupId]
        if (!target) return {}

        const tabIds = [...target.tabIds]
        const at = index === undefined ? tabIds.length : Math.max(0, Math.min(tabIds.length, index))
        tabIds.splice(at, 0, tabId)
        const groups = {
          ...afterRemove,
          [targetGroupId]: { ...target, tabIds, activeTabId: tabId }
        }
        const tabs = s.ui.panelTabs.map((t) =>
          t.id === tabId ? { ...t, groupId: targetGroupId } : t
        )
        const layout = removedGroupId ? removeLeaf(s.layout, removedGroupId) : s.layout
        return {
          groups,
          layout,
          ui: { ...s.ui, panelTabs: tabs },
          activeGroupId: targetGroupId,
          activeSessionId:
            tab.type === 'terminal' ? (tab.sessionId ?? s.activeSessionId) : s.activeSessionId
        }
      }),

    splitTabToGroup: (tabId, targetGroupId, direction) =>
      set((s) => {
        const tab = s.ui.panelTabs.find((t) => t.id === tabId)
        if (!tab || !s.groups[targetGroupId]) return {}

        // 先在目标组旁插入承载新组的叶子，再把标签挪进新组
        const gid = genPaneId()
        const layout0 = s.layout
          ? insertSibling(s.layout, targetGroupId, direction, makeLeaf(gid))
          : makeLeaf(gid)
        const groups: Record<string, PanelGroup> = {
          ...s.groups,
          [gid]: { id: gid, tabIds: [tabId], activeTabId: tabId }
        }
        // 从原组摘掉该标签；原组变空则连同叶子一起移除（若原组就是目标组，剩下的叶子仍留在布局里）
        const src = groups[tab.groupId]
        let removedGroupId: string | null = null
        if (src) {
          const tabIds = src.tabIds.filter((x) => x !== tabId)
          if (tabIds.length === 0) {
            delete groups[tab.groupId]
            removedGroupId = tab.groupId
          } else {
            groups[tab.groupId] = {
              ...src,
              tabIds,
              activeTabId:
                src.activeTabId === tabId ? (tabIds[tabIds.length - 1] ?? null) : src.activeTabId
            }
          }
        }
        const layout = removedGroupId ? removeLeaf(layout0, removedGroupId) : layout0
        return {
          groups,
          layout,
          ui: {
            ...s.ui,
            panelTabs: s.ui.panelTabs.map((t) =>
              t.id === tabId ? { ...t, groupId: gid } : t
            )
          },
          activeGroupId: gid,
          activeSessionId:
            tab.type === 'terminal' ? (tab.sessionId ?? s.activeSessionId) : s.activeSessionId
        }
      }),

    // 组内重排：toIndex 指重排前数组中的目标位，先取出后按移除偏移校正
    reorderTabs: (groupId, tabId, toIndex) =>
      set((s) => {
        const g = s.groups[groupId]
        if (!g) return {}
        const arr = [...g.tabIds]
        const from = arr.indexOf(tabId)
        if (from === -1) return {}
        arr.splice(from, 1)
        let idx = from < toIndex ? toIndex - 1 : toIndex
        idx = Math.max(0, Math.min(arr.length, idx))
        arr.splice(idx, 0, tabId)
        return { groups: { ...s.groups, [groupId]: { ...g, tabIds: arr } } }
      }),

    closeGroup: async (groupId) => {
      const s = get()
      const g = s.groups[groupId]
      if (!g) return
      // 组内终端会话一并结束（非终端标签只关标签）
      const sessionIds = g.tabIds
        .map((id) => s.ui.panelTabs.find((t) => t.id === id)?.sessionId)
        .filter((x): x is string => Boolean(x))
      await Promise.all(sessionIds.map((id) => window.api.terminal.kill(id)))
      set((st) => {
        const groups = { ...st.groups }
        delete groups[groupId]
        const tabs = st.ui.panelTabs.filter((t) => t.groupId !== groupId)
        const layout = removeLeaf(st.layout, groupId)
        const focus = resolveFocus(layout, groups, tabs, null, st.activeSessionId)
        // 组已移除：组内各终端页面的 AI 面板开关与最小化状态一并清理
        const aiOpenSessions = { ...st.ui.aiOpenSessions }
        const aiMinimizedSessions = { ...st.ui.aiMinimizedSessions }
        for (const id of sessionIds) {
          delete aiOpenSessions[id]
          delete aiMinimizedSessions[id]
        }
        return {
          groups,
          layout,
          activeGroupId: focus.activeGroupId,
          activeSessionId: focus.activeSessionId,
          ui: { ...st.ui, panelTabs: tabs, aiOpenSessions, aiMinimizedSessions }
        }
      })
    },

    resizeSplit: (splitId, sizes) =>
      set((s) => (s.layout ? { layout: updateSizes(s.layout, splitId, sizes) } : {})),

    setActiveSession: (id) =>
      set((s) => {
        // 终端标签 id 由会话 id 推导，直接定位并聚焦它
        const tab = s.ui.panelTabs.find((t) => t.type === 'terminal' && t.sessionId === id)
        if (!tab) return {}
        return { activeSessionId: id, ...focusTabPatch(s, tab) }
      }),

    setActiveGroup: (groupId) =>
      set((s) => {
        const g = s.groups[groupId]
        if (!g) return {}
        const tab = g.activeTabId ? s.ui.panelTabs.find((t) => t.id === g.activeTabId) : undefined
        return {
          activeGroupId: groupId,
          activeSessionId:
            tab?.type === 'terminal' ? (tab.sessionId ?? s.activeSessionId) : s.activeSessionId
        }
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

    setSessionAiOpen: (sessionId, open) =>
      set((s) => ({
        ui: { ...s.ui, aiOpenSessions: { ...s.ui.aiOpenSessions, [sessionId]: open } }
      })),

    setAiMinimized: (sessionId, minimized) =>
      set((s) => ({
        ui: { ...s.ui, aiMinimizedSessions: { ...s.ui.aiMinimizedSessions, [sessionId]: minimized } }
      })),

    setAiFloatingPos: (pos) =>
      set((s) => ({ ui: { ...s.ui, aiFloatingPos: pos } })),
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
      const { loadPlugins } = await import('@/features/plugins/host')
      const views = await loadPlugins()
      set((s) => ({ plugins: views, ...closeMissingPluginTabs(s, views) }))
    },

    refreshPluginList: async () => {
      const list = await window.api.plugins.list()
      set((s) => ({ pluginList: list, ui: withPluginList(s.ui, list) }))
    },

    togglePluginEnabled: async (id, enabled) => {
      const list = await window.api.plugins.setEnabled(id, enabled)
      const { loadPlugins } = await import('@/features/plugins/host')
      const plugins = await loadPlugins()
      set((s) => {
        // 禁用会让插件视图消失，它开着的标签一并关掉
        const closed = closeMissingPluginTabs(s, plugins)
        return {
          pluginList: list,
          plugins,
          ...closed,
          // 关标签与清选中都要落在同一个 ui 上（后写覆盖前写，必须显式合并）
          ui: withPluginList(closed.ui ?? s.ui, list)
        }
      })
    },

    uninstallPlugin: async (id) => {
      const list = await window.api.plugins.uninstall(id)
      const { loadPlugins } = await import('@/features/plugins/host')
      const plugins = await loadPlugins()
      set((s) => {
        const closed = closeMissingPluginTabs(s, plugins)
        return {
          pluginList: list,
          plugins,
          ...closed,
          ui: withPluginList(closed.ui ?? s.ui, list)
        }
      })
    },

    installPlugin: async (sourcePath) => {
      const list = await window.api.plugins.install(sourcePath)
      const { loadPlugins } = await import('@/features/plugins/host')
      const plugins = await loadPlugins()
      set((s) => ({ pluginList: list, plugins, ui: withPluginList(s.ui, list) }))
    },

    reloadPlugins: async (id) => {
      const list = await window.api.plugins.reload(id)
      const { loadPlugins } = await import('@/features/plugins/host')
      const plugins = await loadPlugins()
      set((s) => {
        const closed = closeMissingPluginTabs(s, plugins)
        return {
          pluginList: list,
          plugins,
          ...closed,
          ui: withPluginList(closed.ui ?? s.ui, list)
        }
      })
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

    // 分区按 id 记忆（而不是「当前分区」）：同一侧边栏里的几个分区互不影响
    setSectionCollapsed: (id, collapsed) =>
      set((s) => ({
        ui: { ...s.ui, collapsedSections: { ...s.ui.collapsedSections, [id]: collapsed } }
      })),

    // 拖动过程中每帧都会调用，只写这一格，避免拖拽引发整棵侧边栏之外的组件重渲染
    setSectionHeight: (id, height) =>
      set((s) => ({
        ui: { ...s.ui, sectionHeights: { ...s.ui.sectionHeights, [id]: Math.round(height) } }
      })),

    // 一次性把「主机功能区 + 侧边栏 + 脚本分区」三层展开打开，任何一层折叠都不至于点了没反应
    openScriptsSection: () =>
      set((s) => ({
        ui: {
          ...s.ui,
          activeActivity: HOSTS_ACTIVITY_ID,
          collapsedActivities: { ...s.ui.collapsedActivities, [HOSTS_ACTIVITY_ID]: false },
          collapsedSections: { ...s.ui.collapsedSections, [HOSTS_SCRIPTS_SECTION_ID]: false }
        }
      })),

    setAiPanelWidth: (width) =>
      set((s) => ({ ui: { ...s.ui, aiPanelWidth: width } })),

    setAiPanelHeight: (height) =>
      set((s) => ({ ui: { ...s.ui, aiPanelHeight: height } })),

    refreshScripts: async () => {
      set({ scripts: await window.api.scripts.list() })
    },

    deleteScript: async (id) => {
      const scripts = await window.api.scripts.remove(id)
      // 该脚本若正在标签页里打开，一并关掉（否则标签会停在已删除的脚本上，
      // 且未落盘的自动保存可能把脚本又写回去）
      set((s) => ({ scripts, ...closePlainTab(s, `script-${id}`) }))
    },

    refreshScriptGroups: async () => {
      set({ scriptGroups: await window.api.scripts.listGroups() })
    },

    saveScriptGroup: async (input) => {
      set({ scriptGroups: await window.api.scripts.saveGroup(input) })
    },

    deleteScriptGroup: async (id, deleteScripts) => {
      // 组内脚本可能被删除或回到「未分组」，两份数据一起刷新
      const { groups, scripts } = await window.api.scripts.removeGroup(id, deleteScripts)
      const alive = new Set(scripts.map((s) => s.id))
      set((s) => {
        let patch: Partial<AppStore> = { scriptGroups: groups, scripts }
        // 被删掉的脚本若正在标签页里打开，一并关掉（与单条删除一致）
        for (const tab of s.ui.panelTabs) {
          if (tab.type !== 'script' || !tab.scriptId || alive.has(tab.scriptId)) continue
          patch = { ...patch, ...closePlainTab({ ...s, ...patch } as AppStore, tab.id) }
        }
        return patch
      })
    },

    arrangeScripts: async (payload) => {
      const { groups, scripts } = await window.api.scripts.arrange(payload)
      set({ scriptGroups: groups, scripts })
    },

    refreshNotes: async () => {
      set({ notes: await window.api.notes.list() })
    },

    createNote: async (groupId) => {
      const prevIds = new Set(get().notes.map((n) => n.id))
      const list = await window.api.notes.save({
        id: '',
        title: '未命名笔记',
        content: '',
        language: 'markdown',
        groupId,
        createdAt: 0,
        updatedAt: 0
      })
      const created = list.find((n) => !prevIds.has(n.id))
      set({ notes: list })
      return created?.id ?? ''
    },

    saveNote: async (note) => {
      set({ notes: await window.api.notes.save(note) })
    },

    deleteNote: async (id) => {
      const notes = await window.api.notes.remove(id)
      // 该笔记若正在标签页里打开，一并关掉
      set((s) => ({ notes, ...closePlainTab(s, `note-${id}`) }))
    },

    refreshNoteGroups: async () => {
      set({ noteGroups: await window.api.notes.listGroups() })
    },

    saveNoteGroup: async (input) => {
      set({ noteGroups: await window.api.notes.saveGroup(input) })
    },

    deleteNoteGroup: async (id, deleteNotes) => {
      // 组内笔记可能被删除或回到「未分组」，两份数据一起刷新
      const { groups, notes } = await window.api.notes.removeGroup(id, deleteNotes)
      const alive = new Set(notes.map((n) => n.id))
      set((s) => {
        let patch: Partial<AppStore> = { noteGroups: groups, notes }
        // 被删掉的笔记若正在标签页里打开，一并关掉（与单条删除一致）
        for (const tab of s.ui.panelTabs) {
          if (tab.type !== 'note' || !tab.noteId || alive.has(tab.noteId)) continue
          patch = { ...patch, ...closePlainTab({ ...s, ...patch } as AppStore, tab.id) }
        }
        return patch
      })
    },

    arrangeNotes: async (payload) => {
      const { groups, notes } = await window.api.notes.arrange(payload)
      set({ noteGroups: groups, notes })
    },

    selectPlugin: (id) => {
      set((s) => ({ ui: { ...s.ui, activePluginId: id } }))
    },

    refreshApiRequests: async () => {
      set({ apiRequests: await window.api.apiClient.list() })
    },

    refreshApiGroups: async () => {
      set({ apiGroups: await window.api.apiClient.listGroups() })
    },

    saveApiGroup: async (input) => {
      set({ apiGroups: await window.api.apiClient.saveGroup(input) })
    },

    deleteApiGroup: async (id, deleteRequests) => {
      // 组内请求可能被删除或回到「未分组」，两份数据一起刷新
      const { groups, requests } = await window.api.apiClient.removeGroup(id, deleteRequests)
      const alive = new Set(requests.map((r) => r.id))
      set((s) => {
        let patch: Partial<AppStore> = { apiGroups: groups, apiRequests: requests }
        // 被删掉的请求若正在标签页里打开，一并关掉（与单条删除一致）
        for (const tab of s.ui.panelTabs) {
          if (tab.type !== 'api' || !tab.apiRequestId || alive.has(tab.apiRequestId)) continue
          patch = { ...patch, ...closePlainTab({ ...s, ...patch } as AppStore, tab.id) }
        }
        return patch
      })
    },

    arrangeApi: async (payload) => {
      const { groups, requests } = await window.api.apiClient.arrange(payload)
      set({ apiGroups: groups, apiRequests: requests })
    },

    createApiRequest: async (seed) => {
      const prevIds = new Set(get().apiRequests.map((r) => r.id))
      const list = await window.api.apiClient.save({
        id: '',
        name: '',
        method: 'GET',
        url: '',
        headers: [{ key: '', value: '' }],
        body: '',
        createdAt: 0,
        updatedAt: 0,
        ...seed
      })
      const created = list.find((r) => !prevIds.has(r.id))
      set({ apiRequests: list })
      return created?.id ?? ''
    },

    importCurlRequest: async (curlText) => {
      // 纯文本 → 解析 → 复用 createApiRequest 落盘（解析失败直接抛给调用方）
      const parsed = parseCurl(curlText)
      return get().createApiRequest({
        method: parsed.method,
        url: parsed.url,
        headers: parsed.headers.length ? parsed.headers : [{ key: '', value: '' }],
        body: parsed.body
      })
    },

    refreshApiHistory: async () => {
      set({ apiHistory: await window.api.apiClient.listHistory() })
    },

    saveApiRequest: async (entry) => {
      set({ apiRequests: await window.api.apiClient.save(entry) })
    },

    deleteApiRequest: async (id) => {
      const apiRequests = await window.api.apiClient.remove(id)
      // 该请求若正在标签页里打开，一并关掉（与脚本/笔记删除一致）
      set((s) => ({ apiRequests, ...closePlainTab(s, apiTabId(id)) }))
    },

    recordApiHistory: async (entry) => {
      const next = [entry, ...get().apiHistory].slice(0, API_HISTORY_LIMIT)
      // 先更新界面再落盘：历史是滑动窗口的覆盖式写入，落盘失败也不影响继续发送
      set({ apiHistory: next })
      await window.api.apiClient.saveHistory(next)
    },

    clearApiHistory: async () => {
      set({ apiHistory: await window.api.apiClient.clearHistory() })
    },

    openScriptTab: (scriptId) => {
      set((s) => {
        const script = s.scripts.find((sc) => sc.id === scriptId)
        return addOrFocusTab(s, {
          id: `script-${scriptId}`,
          type: 'script',
          title: script?.name ?? '未命名脚本',
          closable: true,
          scriptId
        })
      })
    },

    openNoteTab: (noteId) => {
      set((s) => {
        const note = s.notes.find((n) => n.id === noteId)
        return addOrFocusTab(s, {
          id: `note-${noteId}`,
          type: 'note',
          title: note?.title ?? '未命名笔记',
          closable: true,
          noteId
        })
      })
    },

    openApiTab: (requestId) => {
      set((s) => {
        const req = s.apiRequests.find((r) => r.id === requestId)
        return addOrFocusTab(s, {
          id: apiTabId(requestId),
          type: 'api',
          title: req ? apiTabTitle(req) : '接口请求',
          closable: true,
          apiRequestId: requestId,
          // 协议从请求上抄一份：标签渲染哪个页面只看它，不必再去 store 里查一遍
          apiProtocol: req?.protocol ?? 'http'
        })
      })
    },

    /** 打开一个未保存的「新建请求 / 新建 WebSocket」草稿：右侧只建一个标签，不写进请求列表；
     *  真正的落盘发生在用户按 Ctrl/Cmd+S 输入名称后（见 ApiPage / WsPage 的 saveNow）。 */
    openNewApiDraft: (groupId, protocol = 'http') => {
      const isWs = protocol === 'ws'
      const draftId = isWs ? NEW_WS_REQUEST_ID : NEW_API_REQUEST_ID
      set((s) =>
        addOrFocusTab(s, {
          id: apiTabId(draftId),
          type: 'api',
          title: isWs ? '新建 WebSocket' : '新建请求',
          closable: true,
          apiRequestId: draftId,
          apiProtocol: protocol,
          apiGroupId: groupId
        })
      )
    },

    openPluginsTab: () => {
      set((s) =>
        addOrFocusTab(s, {
          id: 'plugins',
          type: 'plugins',
          title: '插件管理',
          closable: true
        })
      )
    },

    openPluginTab: (viewId) => {
      set((s) => {
        const view = s.plugins.find((p) => p.viewId === viewId)
        return addOrFocusTab(s, {
          id: `plugin-${viewId}`,
          type: 'plugin',
          title: view?.name ?? '插件',
          closable: true,
          pluginViewId: viewId
        })
      })
    },

    activatePanelTab: (id) =>
      set((s) => {
        const tab = s.ui.panelTabs.find((t) => t.id === id)
        if (!tab) return {}
        return focusTabPatch(s, tab)
      }),

    closePanelTab: (id) => {
      const s = get()
      const tab = s.ui.panelTabs.find((t) => t.id === id)
      if (!tab) return
      // 终端标签：结束会话（applyTabClose 会同步摘掉标签与空组）
      if (tab.type === 'terminal' && tab.sessionId) {
        void get().closeSession(tab.sessionId)
        return
      }
      set((st) => closePlainTab(st, id))
    },

    requestClosePanelTab: (id) => {
      const s = get()
      const tab = s.ui.panelTabs.find((t) => t.id === id)
      if (!tab) return
      // 没开二次确认就直接关，保持原来的手感
      if (!s.preferences.confirmCloseTab) {
        get().closePanelTab(id)
        return
      }
      set((st) => ({
        ui: { ...st.ui, pendingTabClose: { kind: 'tab', tabId: id, label: tab.title } }
      }))
    },

    requestCloseGroup: (groupId) => {
      const s = get()
      const group = s.groups[groupId]
      if (!group) return
      if (!s.preferences.confirmCloseTab) {
        void get().closeGroup(groupId)
        return
      }
      set((st) => ({
        ui: {
          ...st.ui,
          pendingTabClose: { kind: 'group', groupId, count: group.tabIds.length }
        }
      }))
    },

    cancelPendingTabClose: () =>
      set((st) => (st.ui.pendingTabClose ? { ui: { ...st.ui, pendingTabClose: null } } : {})),

    confirmPendingTabClose: async (dontAskAgain) => {
      const pending = get().ui.pendingTabClose
      if (!pending) return
      // 先收起弹框再执行关闭：关闭会改 groups / panelTabs，别让弹框停在半途的状态上
      set((st) => ({ ui: { ...st.ui, pendingTabClose: null } }))
      if (dontAskAgain) await get().setConfirmCloseTab(false)
      if (pending.kind === 'tab') get().closePanelTab(pending.tabId)
      else await get().closeGroup(pending.groupId)
    },

    updatePanelTabTitle: (id, title) => {
      set((s) => ({
        ui: {
          ...s.ui,
          panelTabs: s.ui.panelTabs.map((t) => (t.id === id ? { ...t, title } : t))
        }
      }))
    },

    setEditorSaveStatus: (key, state) =>
      set((s) => {
        // 状态没变就不写，避免自动保存期间的无谓重渲染
        if (s.ui.editorSaveStatus[key] === state) return {}
        return { ui: { ...s.ui, editorSaveStatus: { ...s.ui.editorSaveStatus, [key]: state } } }
      }),

    refreshAiConfigs: async () => {
      set({ aiConfigs: await window.api.ai.listConfigs() })
    },

    refreshAiSettings: async () => {
      set({ aiSettings: await window.api.ai.getSettings() })
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

    setConfirmCloseTab: async (enabled) => {
      set((s) => ({ preferences: { ...s.preferences, confirmCloseTab: enabled } }))
      const preferences = await window.api.prefs.save({ confirmCloseTab: enabled })
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
      if (event.type === 'error') {
        // 报错即视为本轮对话结束：立刻复位 streaming，不依赖后续 finish 事件。
        // 否则遇到快速失败（如额度不足）且 finish 因竞态丢失时，输入会永久卡在生成中。
        aiRequestSessions.delete(requestId)
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
          return {
            aiChats: {
              ...s.aiChats,
              [sid]: {
                ...chat,
                messages,
                streaming: false,
                requestId: null,
                // 错误已内联到该条助手消息（⚠️），不再另设横幅，避免重复显示
                error: null
              }
            }
          }
        })
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
    },

    // ---------- AI Agent ----------

    loadAgentWorkspaces: async () => {
      const [workspaces, conversations] = await Promise.all([
        window.api.agent.listWorkspaces(),
        window.api.agent.listConversations()
      ])
      set((s) => {
        // 选中项失效（工作区被删）时回退到第一个
        const activeValid =
          s.activeAgentWorkspaceId && workspaces.some((w) => w.id === s.activeAgentWorkspaceId)
        const workspaceId = activeValid ? s.activeAgentWorkspaceId! : (workspaces[0]?.id ?? null)
        // 选中的会话仍存在就保留，否则重新定位到该工作区最近的会话
        const conversationValid =
          s.activeAgentConversationId !== null &&
          conversations.some((c) => c.id === s.activeAgentConversationId)
        const ensured = conversationValid
          ? { conversations, activeId: s.activeAgentConversationId }
          : ensureConversation(conversations, workspaceId ?? '')
        return {
          agentWorkspaces: workspaces,
          agentConversations: ensured.conversations,
          activeAgentWorkspaceId: workspaceId,
          activeAgentConversationId: ensured.activeId
        }
      })
    },

    saveAgentWorkspace: async (input) => {
      const workspaces = await window.api.agent.saveWorkspace(input)
      set((s) => {
        // 已经有选中的工作区就只更新列表，不动当前会话
        if (s.activeAgentWorkspaceId) return { agentWorkspaces: workspaces }
        // 首次添加时自动选中，并给它备好一个会话
        const first = workspaces[0]?.id ?? null
        const ensured = ensureConversation(s.agentConversations, first ?? '')
        return {
          agentWorkspaces: workspaces,
          activeAgentWorkspaceId: first,
          agentConversations: ensured.conversations,
          activeAgentConversationId: ensured.activeId
        }
      })
    },

    setAgentWorkspaceBackend: async (id, backend) => {
      const ws = get().agentWorkspaces.find((w) => w.id === id)
      if (!ws) return
      const workspaces = await window.api.agent.saveWorkspace({
        id,
        name: ws.name,
        path: ws.path,
        backend
      })
      set({ agentWorkspaces: workspaces })
    },

    deleteAgentWorkspace: async (id) => {
      // 该工作区下正在跑的会话先停掉，否则它们的主进程 agent 进程会变成孤儿
      for (const c of get().agentConversations) {
        if (c.workspaceId !== id) continue
        if ((get().agentRuns[c.id] ?? emptyAgentRun()).requestId) await get().abortAgent(c.id)
      }
      const workspaces = await window.api.agent.deleteWorkspace(id)
      set((s) => {
        // 主进程已级联删掉该工作区的会话，本地同步一份
        const conversations = s.agentConversations.filter((c) => c.workspaceId !== id)
        const workspaceId =
          s.activeAgentWorkspaceId === id ? (workspaces[0]?.id ?? null) : s.activeAgentWorkspaceId
        const ensured = ensureConversation(conversations, workspaceId ?? '')
        return {
          agentWorkspaces: workspaces,
          agentConversations: ensured.conversations,
          activeAgentWorkspaceId: workspaceId,
          activeAgentConversationId: ensured.activeId
        }
      })
    },

    selectAgentWorkspace: (id) =>
      set((s) => {
        const ensured = ensureConversation(s.agentConversations, id)
        return {
          activeAgentWorkspaceId: id,
          agentConversations: ensured.conversations,
          activeAgentConversationId: ensured.activeId
        }
      }),

    createAgentConversation: (workspaceId) =>
      set((s) => {
        const wid = workspaceId ?? s.activeAgentWorkspaceId
        if (!wid) return {}
        const created = newConversation(wid)
        // 新会话排在前面，符合「最近在用」的直觉
        return {
          activeAgentWorkspaceId: wid,
          agentConversations: [created, ...s.agentConversations],
          activeAgentConversationId: created.id
        }
      }),

    selectAgentConversation: (id) => set({ activeAgentConversationId: id }),

    renameAgentConversation: async (id, title) => {
      const next = title.trim() || DEFAULT_CONVERSATION_TITLE
      set((s) => ({
        agentConversations: patchConversation(s.agentConversations, id, { title: next })
      }))
      await persistConversation(get().agentConversations, id)
    },

    deleteAgentConversation: async (id) => {
      // 正在流式输出就先中止，否则主进程那个会话的 agent 进程会变成孤儿
      if ((get().agentRuns[id] ?? emptyAgentRun()).requestId) await get().abortAgent(id)
      await window.api.agent.deleteConversation(id)
      set((s) => {
        const conversations = s.agentConversations.filter((c) => c.id !== id)
        const { [id]: _removed, ...runs } = s.agentRuns
        if (s.activeAgentConversationId !== id) {
          return { agentConversations: conversations, agentRuns: runs }
        }
        // 删的正是当前会话：切到同工作区剩下的最近一个，没有就现建
        const ensured = ensureConversation(conversations, s.activeAgentWorkspaceId ?? '')
        return {
          agentConversations: ensured.conversations,
          agentRuns: runs,
          activeAgentConversationId: ensured.activeId
        }
      })
    },

    sendAgentMessage: async (text) => {
      const trimmed = text.trim()
      const wid = get().activeAgentWorkspaceId
      const cid = get().activeAgentConversationId
      if (!wid || !cid || !trimmed) return
      const conversation = get().agentConversations.find((c) => c.id === cid)
      if (!conversation) return
      if ((get().agentRuns[cid] ?? emptyAgentRun()).streaming) return

      const now = Date.now()
      const userMsg: AgentChatMessage = {
        id: `u-${now}`,
        role: 'user',
        parts: [{ type: 'text', text: trimmed }],
        createdAt: now
      }
      const assistantMsg: AgentChatMessage = {
        id: `a-${now}`,
        role: 'assistant',
        parts: [],
        createdAt: now + 1
      }
      const history = [...conversation.messages, userMsg]
      // 首条消息顺手定标题，省得用户手动命名（之后可在会话列表里改）
      const title =
        conversation.messages.length === 0 ? titleFromMessage(trimmed) : conversation.title

      set((s) => ({
        agentConversations: patchConversation(s.agentConversations, cid, {
          messages: [...history, assistantMsg],
          title
        }),
        agentRuns: { ...s.agentRuns, [cid]: { streaming: true, requestId: null, error: null } }
      }))
      // 用户消息与标题立刻落盘：这一轮即便失败 / 应用被关，输入也不会丢
      void persistConversation(get().agentConversations, cid)

      try {
        const { requestId } = await window.api.agent.chat({
          workspaceId: wid,
          conversationId: cid,
          history
        })
        agentRequestConversations.set(requestId, cid)
        set((s) => ({
          agentRuns: {
            ...s.agentRuns,
            [cid]: { ...(s.agentRuns[cid] ?? emptyAgentRun()), requestId }
          }
        }))
      } catch (err) {
        set((s) => ({
          agentRuns: {
            ...s.agentRuns,
            [cid]: {
              ...(s.agentRuns[cid] ?? emptyAgentRun()),
              streaming: false,
              requestId: null,
              error: err instanceof Error ? err.message : String(err)
            }
          }
        }))
      }
    },

    abortAgent: async (conversationId) => {
      // 不传时中止当前选中的那个；删除会话 / 工作区时会显式指定，避免留下孤儿请求
      const cid = conversationId ?? get().activeAgentConversationId
      if (!cid) return
      const requestId = (get().agentRuns[cid] ?? emptyAgentRun()).requestId
      if (!requestId) return
      agentRequestConversations.delete(requestId)
      // 只清属于本次请求的确认卡
      for (const c of Object.values(get().agentPendingConfirms)) {
        if (c.requestId === requestId) void get().resolveAgentConfirm(c.id, false)
      }
      await window.api.agent.abort(requestId)
      set((s) => ({
        agentRuns: {
          ...s.agentRuns,
          [cid]: { ...(s.agentRuns[cid] ?? emptyAgentRun()), streaming: false, requestId: null }
        }
      }))
    },

    clearAgentMessages: () => {
      const cid = get().activeAgentConversationId
      if (!cid) return
      const requestId = (get().agentRuns[cid] ?? emptyAgentRun()).requestId
      if (requestId) agentRequestConversations.delete(requestId)
      set((s) => ({
        agentConversations: patchConversation(s.agentConversations, cid, { messages: [] }),
        agentRuns: { ...s.agentRuns, [cid]: emptyAgentRun() }
      }))
      void persistConversation(get().agentConversations, cid)
    },

    handleAgentEvent: (requestId, event) => {
      // 路由到发起该对话的会话（不依赖当前选中）
      const cid = agentRequestConversations.get(requestId)
      if (!cid) return

      /** 把事件追加到会话最后一条 assistant 消息上 */
      const appendToLast = (
        messages: AgentChatMessage[],
        ev: AgentStreamEvent
      ): AgentChatMessage[] => {
        const next = [...messages]
        const last = next[next.length - 1]
        if (last?.role === 'assistant') {
          next[next.length - 1] = { ...last, parts: appendAgentPart(last.parts, ev) }
        }
        return next
      }

      if (event.type === 'finish') {
        agentRequestConversations.delete(requestId)
        set((s) => ({
          agentRuns: {
            ...s.agentRuns,
            [cid]: { ...(s.agentRuns[cid] ?? emptyAgentRun()), streaming: false, requestId: null }
          }
        }))
        // 整轮结束才落盘：中途每个 part 都写盘会让长回复反复序列化同一段历史
        void persistConversation(get().agentConversations, cid)
        // 兜底：该对话已结束但仍有其挂起确认时按取消处理，避免主进程工具悬挂
        for (const c of Object.values(get().agentPendingConfirms)) {
          if (c.requestId === requestId) void get().resolveAgentConfirm(c.id, false)
        }
        return
      }

      if (event.type === 'error') {
        // 报错即视为本轮对话结束：立刻复位 streaming，不依赖后续 finish 事件
        agentRequestConversations.delete(requestId)
        set((s) => {
          const conversation = s.agentConversations.find((c) => c.id === cid)
          if (!conversation) return {}
          return {
            agentConversations: patchConversation(s.agentConversations, cid, {
              messages: appendToLast(conversation.messages, event)
            }),
            agentRuns: {
              ...s.agentRuns,
              [cid]: {
                ...(s.agentRuns[cid] ?? emptyAgentRun()),
                streaming: false,
                requestId: null,
                error: null
              }
            }
          }
        })
        void persistConversation(get().agentConversations, cid)
        for (const c of Object.values(get().agentPendingConfirms)) {
          if (c.requestId === requestId) void get().resolveAgentConfirm(c.id, false)
        }
        return
      }

      set((s) => {
        const conversation = s.agentConversations.find((c) => c.id === cid)
        if (!conversation) return {}
        return {
          agentConversations: patchConversation(s.agentConversations, cid, {
            messages: appendToLast(conversation.messages, event)
          })
        }
      })
    },

    resolveAgentConfirm: async (id, approved) => {
      // 本地立即移除卡片（主进程也会广播 resolved，幂等无害）
      set((s) => {
        if (!(id in s.agentPendingConfirms)) return {}
        const next = { ...s.agentPendingConfirms }
        delete next[id]
        return { agentPendingConfirms: next }
      })
      await window.api.agent.resolveConfirm(id, approved)
    }
  }
})

// CDP 调试暴露（模块初始化完成后赋值，避免 TDZ）
if (typeof window !== 'undefined') {
  ;(window as unknown as Record<string, unknown>).__store = useAppStore
}
