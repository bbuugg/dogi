/**
 * 面板/标签操作的纯函数。
 *
 * 这些函数不依赖 `set`/`get`，只接收当前 state 的子集、返回 Partial<Store> patch。
 * 从 `app-store.ts` 抽出以减小体积；纯函数天然可测、也方便后续拆 slice 复用。
 */
import {
  firstGroupId,
  genPaneId,
  makeLeaf,
  removeLeaf,
  type PaneNode
} from '@/app/layout/pane-layout'
import type { AppStore, PanelGroup, PanelTab, SiblingTabsCloseMode } from './types'
import type { SessionInfo } from '@shared/types'

/** 重连中的旧会话 ID：其 onClosed 事件不应从布局摘掉面板（会被新会话原地替换） */
export const reconnectingIds = new Set<string>()

/** 打开一个已保存的主机会话：主进程按主机类型（ssh / local）决定启动方式 */
export function openSession(profileId: string, cols = 80, rows = 24): Promise<SessionInfo> {
  return window.api.terminal.createFromProfile(profileId, cols, rows)
}

/** 从所在组摘掉一个标签；若组因此变空则返回被移除的组 ID（连同其标签一起清理） */
export function withoutTab(
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
export function resolveFocus(
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
export function applyTabClose(
  s: Pick<
    AppStore,
    | 'sessions'
    | 'layout'
    | 'groups'
    | 'activeGroupId'
    | 'activeSessionId'
    | 'exitedSessions'
    | 'monitors'
    | 'monitorUnsupported'
    | 'activeTerminalConv'
    | 'terminalDrafts'
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
  // 「不支持监控」标记随会话关闭一并清理
  const monitorUnsupported = { ...s.monitorUnsupported }
  delete monitorUnsupported[id]
  // 会话关闭，其打开的终端助手会话指针 / 草稿与 AI 面板开关随之清理
  //（会话记录本身在独立的池里持久化，不随某个终端会话消失）
  const activeTerminalConv = { ...s.activeTerminalConv }
  delete activeTerminalConv[id]
  const terminalDrafts = { ...s.terminalDrafts }
  delete terminalDrafts[id]
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
    monitorUnsupported,
    activeTerminalConv,
    terminalDrafts,
    connectStages,
    ui: { ...s.ui, panelTabs: tabs, aiOpenSessions, aiMinimizedSessions }
  }
}

/**
 * 新会话作为终端标签加入当前激活组（没有可用组时新建组并重置布局），并聚焦它。
 * 打开连接、新建本地终端都走这里，保证「打开 = 在 PanelView 里多一个标签」。
 */
export function attachSessionTab(s: AppStore, info: SessionInfo): Partial<AppStore> {
  const tabs = [...s.ui.panelTabs]
  const groups = { ...s.groups }
  const base = {
    id: `terminal-${info.id}`,
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
export function focusTabPatch(s: AppStore, tab: PanelTab): Partial<AppStore> {
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
export function closePlainTab(s: AppStore, tabId: string): Partial<AppStore> {
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
 * 组内批量关闭要关掉哪些标签。
 *
 * 顺序取组内 `tabIds` 的排列（与标签条上的左右顺序一致），锚点标签自身始终排除 ——
 * 所以调用方不必担心「组被关空」，焦点也自然落在锚点标签上。
 */
export function siblingTabIds(
  s: Pick<AppStore, 'groups' | 'ui'>,
  tabId: string,
  mode: SiblingTabsCloseMode
): string[] {
  const tab = s.ui.panelTabs.find((t) => t.id === tabId)
  const g = tab ? s.groups[tab.groupId] : undefined
  if (!tab || !g) return []
  const at = g.tabIds.indexOf(tabId)
  if (at === -1) return []
  if (mode === 'others') return g.tabIds.filter((id) => id !== tabId)
  if (mode === 'left') return g.tabIds.slice(0, at)
  return g.tabIds.slice(at + 1)
}

/**
 * 一次摘掉一批标签（组内批量关闭）：组因此变空则连组（及其布局叶子）一并移除，最后重算焦点。
 *
 * 与 `closeMissingPluginTabs` / `closeMissingAgentTabs` 同一套路，区别只是待关集合来自
 * 用户操作而不是对象消失。调用方负责先把其中的终端会话 kill 掉；`sessions` / `exitedSessions`
 * 等会话级状态由主进程的 closed 事件经 `applyTabClose` 收尾（与 `closeGroup` 一致）。
 */
export function closeTabsPatch(s: AppStore, closing: Set<string>): Partial<AppStore> {
  if (closing.size === 0) return {}
  const tabs = s.ui.panelTabs.filter((t) => !closing.has(t.id))
  if (tabs.length === s.ui.panelTabs.length) return {}
  const groups: Record<string, PanelGroup> = {}
  let layout = s.layout
  for (const [id, g] of Object.entries(s.groups)) {
    const tabIds = g.tabIds.filter((x) => !closing.has(x))
    // 理论上走不到：有锚点标签兜底，组不会空。保险起见仍摘掉叶子，别留一个空组挂在布局上
    if (tabIds.length === 0) {
      layout = removeLeaf(layout, id)
      continue
    }
    groups[id] = {
      ...g,
      tabIds,
      // 激活标签被关掉就回落到组内最后一个标签（与 withoutTab 一致）
      activeTabId:
        g.activeTabId && closing.has(g.activeTabId)
          ? (tabIds[tabIds.length - 1] ?? null)
          : g.activeTabId
    }
  }
  const focus = resolveFocus(layout, groups, tabs, s.activeGroupId, s.activeSessionId)
  // 被关掉的终端标签：AI 面板开关与最小化状态一并清理（比等 closed 事件更即时，与 closeGroup 一致）
  const sessionIds: string[] = []
  for (const t of s.ui.panelTabs) {
    if (closing.has(t.id) && t.sessionId) sessionIds.push(t.sessionId)
  }
  const aiOpenSessions = { ...s.ui.aiOpenSessions }
  const aiMinimizedSessions = { ...s.ui.aiMinimizedSessions }
  for (const id of sessionIds) {
    delete aiOpenSessions[id]
    delete aiMinimizedSessions[id]
  }
  return {
    groups,
    layout,
    activeGroupId: focus.activeGroupId,
    activeSessionId: focus.activeSessionId,
    ui: { ...s.ui, panelTabs: tabs, aiOpenSessions, aiMinimizedSessions }
  }
}

/**
 * 插件视图消失（卸载 / 禁用 / 重载）后，把指向它的插件标签一并关掉。
 *
 * 插件不再往活动栏挂条目，所以「插件没了」只剩标签这一处残留需要收拾：
 * 留着只会停在「插件视图未加载」上。与脚本 / 笔记的删除同理，标签生命周期
 * 跟着对象走。
 */
export function closeMissingPluginTabs(
  s: AppStore,
  views: { viewId: string }[]
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

/**
 * 会话不存在了（删除会话 / 删除工作区）→ 把它对应的 Agent 标签一并关掉。
 *
 * 与脚本 / 笔记 / 插件视图同理：标签生命周期跟着对象走，留着只会停在「会话不存在」上。
 * 工作区被删时它的会话是级联删掉的，所以这里按「还活着的会话 id 集合」判定，一次覆盖两种删除。
 */
export function closeMissingAgentTabs(s: AppStore, aliveIds: Set<string>): Partial<AppStore> {
  const stale = new Set(
    s.ui.panelTabs
      .filter(
        (t) => t.type === 'agent' && (!t.agentConversationId || !aliveIds.has(t.agentConversationId))
      )
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
export function addOrFocusTab(s: AppStore, tab: Omit<PanelTab, 'groupId'>): Partial<AppStore> {
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
