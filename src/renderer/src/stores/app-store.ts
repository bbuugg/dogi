import { create } from 'zustand'
import type {
  AiChatMessage,
  AiConfirmRequest,
  AiMessagePart,
  AiModelConfig,
  AiPermissionMode,
  AiSettings,
  AiStreamEvent,
  Preferences,
  ServerMetrics,
  SessionInfo,
  ShellDetectResult,
  ScriptEntry,
  SshProfile,
  TerminalThemeName,
  ThemeMode
} from '@shared/types'
import type { AppShortcutAction } from '@shared/types'
import { clampTerminalFontSize } from '@/lib/terminal-font'
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

/** 终端字号持久化写入的防抖句柄（Ctrl+滚轮会触发连续调整） */
let fontSizeSaveTimer: number | undefined

/** 重连中的旧会话 ID：其 onClosed 事件不应从布局摘掉面板（会被新会话原地替换） */
const reconnectingIds = new Set<string>()

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
  s: Pick<AppStore, 'sessions' | 'layout' | 'groups' | 'activeGroupId' | 'activeSessionId' | 'exitedSessions'>,
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
  return { sessions, groups, layout, activeGroupId, activeSessionId, exitedSessions: exited }
}

interface UiState {
  aiPanelOpen: boolean
  settingsOpen: boolean
  /** 编辑中的 SSH 配置（null=新建，undefined=关闭） */
  sshDialog: { open: boolean; editing?: SshProfile | null }
  settingsTab: 'ai' | 'terminal' | 'prefs'
  /** 是否展开服务器监控面板 */
  monitorOpen: boolean
  /** 是否打开脚本命令面板（Ctrl+Shift+P） */
  scriptPaletteOpen: boolean
  /** 主区域视图：终端 / 脚本管理页 */
  view: 'terminal' | 'scripts'
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
  /** 分屏布局树：每个叶子承载一个编辑器组；null 表示尚无任何会话 */
  layout: PaneNode | null
  /** 所有编辑器组，key 为组 ID */
  groups: Record<string, EditorGroup>
  /** 当前聚焦的组 ID（决定拆分/新建终端落在哪个组，以及监控/AI 的上下文） */
  activeGroupId: string | null

  // ---------- SSH ----------
  profiles: SshProfile[]

  // ---------- 用户脚本 ----------
  scripts: ScriptEntry[]

  // ---------- 偏好 ----------
  preferences: Preferences
  /** 本地可用 shell 检测结果（null = 尚未加载） */
  shells: ShellDetectResult | null

  // ---------- AI ----------
  aiConfigs: AiModelConfig[]
  aiSettings: AiSettings
  messages: AiChatMessage[]
  aiStreaming: boolean
  activeRequestId: string | null
  aiError: string | null
  /** 确认模式下等待用户处理的命令执行请求 */
  pendingConfirm: AiConfirmRequest | null

  // ---------- UI ----------
  ui: UiState

  // ---------- 服务器监控 ----------
  /** 各会话最新指标，key 为 sessionId */
  monitors: Record<string, ServerMetrics>

  toggleMonitor: () => void
  setMonitorData: (sessionId: string, metrics: ServerMetrics) => void

  bootstrap: () => Promise<void>
  /** 创建本地终端：不传 shellId 时使用偏好设置的默认本地终端 */
  createLocalSession: (shellId?: string) => Promise<void>
  connectSsh: (profile: SshProfile) => Promise<void>
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
  /** 关闭整个组（含其全部会话） */
  closeGroup: (groupId: string) => Promise<void>
  /** 拖拽分隔条时更新某分隔节点的权重 */
  resizeSplit: (splitId: string, sizes: number[]) => void
  refreshProfiles: () => Promise<void>

  setAiPanelOpen: (open: boolean) => void
  setSettingsOpen: (open: boolean, tab?: UiState['settingsTab']) => void
  setScriptPaletteOpen: (open: boolean) => void
  setView: (view: 'terminal' | 'scripts') => void
  setSidebarWidth: (width: number) => void
  setAiPanelWidth: (width: number) => void
  refreshScripts: () => Promise<void>
  setSshDialog: (open: boolean, editing?: SshProfile | null) => void
  refreshAiConfigs: () => Promise<void>
  setActiveAiConfig: (id: string) => Promise<void>
  saveAiSettings: (patch: Partial<AiSettings>) => Promise<void>
  setAiPermissionMode: (mode: AiPermissionMode) => Promise<void>
  resolveAiConfirm: (approved: boolean) => Promise<void>
  setTheme: (mode: ThemeMode) => Promise<void>
  setTerminalTheme: (name: TerminalThemeName) => Promise<void>
  setCopyOnSelect: (enabled: boolean) => Promise<void>
  setCommandPrediction: (enabled: boolean) => Promise<void>
  /** 关闭窗口时是否最小化到系统托盘（持久化到偏好设置） */
  setMinimizeToTray: (enabled: boolean) => Promise<void>
  /** 设置本地终端默认 shell（持久化到偏好设置） */
  setLocalShell: (shellId: string) => Promise<void>
  setTerminalFontSize: (size: number) => Promise<void>
  sendAiMessage: (text: string, targetSessionId?: string | null) => Promise<void>
  abortAi: () => Promise<void>
  clearAiMessages: () => void
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
        return { exitedSessions: exited }
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
      // 同一时刻只可能有一个待确认命令
      set({ pendingConfirm: req })
    })
    window.api.monitor.onData(({ sessionId, metrics }) => {
      set((s) => ({ monitors: { ...s.monitors, [sessionId]: metrics } }))
    })
  }

  return {
    sessions: [],
    activeSessionId: null,
    exitedSessions: new Set(),
    layout: null,
    groups: {},
    activeGroupId: null,

    profiles: [],

    scripts: [],

    preferences: { theme: 'system', terminalTheme: 'auto', copyOnSelect: true, commandPrediction: true, terminalFontSize: 13, localShell: 'default', minimizeToTray: true },

    shells: null,

    aiConfigs: [],
    aiSettings: { permissionMode: 'full' },
    messages: [],
    aiStreaming: false,
    activeRequestId: null,
    aiError: null,
    pendingConfirm: null,

    ui: {
      aiPanelOpen: false,
      settingsOpen: false,
      sshDialog: { open: false, editing: null },
      settingsTab: 'prefs',
      monitorOpen: false,
      scriptPaletteOpen: false,
      view: 'terminal',
      sidebarWidth: 240,
      aiPanelWidth: 350
    },

    monitors: {},

    bootstrap: async () => {
      const [profiles, configs, settings, preferences, shells, scripts] = await Promise.all([
        window.api.ssh.list(),
        window.api.ai.listConfigs(),
        window.api.ai.getSettings(),
        window.api.prefs.get(),
        window.api.terminal.listShells(),
        window.api.scripts.list()
      ])
      set({ profiles, aiConfigs: configs, aiSettings: settings, preferences, shells, scripts })

      // 全局快捷键：主进程触发后在此分发到具体 UI 动作
      if (!shortcutWired) {
        shortcutWired = true
        window.api.app.onShortcut((action: AppShortcutAction) => {
          const s = get()
          if (action === 'open-settings') s.setSettingsOpen(true)
          else if (action === 'new-session') void s.createLocalSession()
          else if (action === 'open-script-palette') s.setScriptPaletteOpen(true)
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
    },

    connectSsh: async (profile) => {
      const info = await window.api.terminal.createSsh(profile.id, 80, 24)
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
      // 按原会话类型创建新会话：SSH 沿用原 profileId，本地则新建本地 Shell
      const info: SessionInfo =
        old.type === 'ssh' && old.profileId
          ? await window.api.terminal.createSsh(old.profileId, 80, 24)
          : await window.api.terminal.createLocal(80, 24)
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
        const activeGroupId = targetGid ?? s.activeGroupId
        const activeSessionId = targetGid ? groups[targetGid].activeSessionId : s.activeSessionId
        return { sessions, groups, activeGroupId, activeSessionId, exitedSessions: exited }
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
      // 镜像当前组激活会话的类型：SSH 沿用原 profileId，本地则新建本地 Shell
      const info: SessionInfo =
        src?.type === 'ssh' && src.profileId
          ? await window.api.terminal.createSsh(src.profileId, 80, 24)
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
        return { groups, layout, activeGroupId, activeSessionId }
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

    setAiPanelOpen: (open) => set((s) => ({ ui: { ...s.ui, aiPanelOpen: open } })),
    setSettingsOpen: (open, tab) =>
      set((s) => ({
        ui: {
          ...s.ui,
          settingsOpen: open,
          ...(tab ? { settingsTab: tab } : {})
        }
      })),
    setSshDialog: (open, editing = null) =>
      set((s) => ({ ui: { ...s.ui, sshDialog: { open, editing } } })),

    setScriptPaletteOpen: (open) =>
      set((s) => ({ ui: { ...s.ui, scriptPaletteOpen: open } })),

    setView: (view) =>
      set((s) => ({ ui: { ...s.ui, view } })),

    setSidebarWidth: (width) =>
      set((s) => ({ ui: { ...s.ui, sidebarWidth: width } })),

    setAiPanelWidth: (width) =>
      set((s) => ({ ui: { ...s.ui, aiPanelWidth: width } })),

    refreshScripts: async () => {
      set({ scripts: await window.api.scripts.list() })
    },

    toggleMonitor: () =>
      set((s) => ({ ui: { ...s.ui, monitorOpen: !s.ui.monitorOpen } })),

    setMonitorData: (sessionId, metrics) =>
      set((s) => ({ monitors: { ...s.monitors, [sessionId]: metrics } })),

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

    resolveAiConfirm: async (approved) => {
      const pending = get().pendingConfirm
      if (!pending) return
      set({ pendingConfirm: null })
      await window.api.ai.resolveConfirm(pending.id, approved)
    },

    setTheme: async (mode) => {
      const preferences = await window.api.prefs.save({ theme: mode })
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

    sendAiMessage: async (text, targetSessionId) => {
      const trimmed = text.trim()
      if (!trimmed || get().aiStreaming) return
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
      const history = [...get().messages, userMsg]
      set({ messages: [...history, assistantMsg], aiStreaming: true, aiError: null })

      // 附加当前目标终端上下文，便于 AI 定位会话
      const activeId = targetSessionId ?? get().activeSessionId
      const contextNote = activeId
        ? `\n\n（用户当前正在查看的终端会话 ID：${activeId}）`
        : ''
      const payload: AiChatMessage[] = [
        ...history.slice(0, -1),
        {
          ...userMsg,
          parts: [{ type: 'text', text: trimmed + contextNote }]
        }
      ]

      try {
        const { requestId } = await window.api.ai.chat(payload)
        set({ activeRequestId: requestId })
      } catch (err) {
        set((s) => ({
          aiStreaming: false,
          aiError: err instanceof Error ? err.message : String(err)
        }))
      }
    },

    abortAi: async () => {
      const requestId = get().activeRequestId
      set({ pendingConfirm: null })
      if (requestId) {
        await window.api.ai.abort(requestId)
        set({ aiStreaming: false, activeRequestId: null })
      }
    },

    clearAiMessages: () => set({ messages: [], pendingConfirm: null }),

    handleAiEvent: (requestId, event) => {
      if (requestId !== get().activeRequestId) return
      if (event.type === 'finish') {
        set({ aiStreaming: false, activeRequestId: null })
        // 兜底：对话已结束但仍有挂起确认时按取消处理，避免主进程工具悬挂
        if (get().pendingConfirm) void get().resolveAiConfirm(false)
        return
      }
      set((s) => {
        const messages = [...s.messages]
        const last = messages[messages.length - 1]
        if (last?.role === 'assistant') {
          messages[messages.length - 1] = {
            ...last,
            parts: appendAssistantPart(last.parts, event)
          }
        }
        return { messages }
      })
    }
  }
})

// CDP 调试暴露（模块初始化完成后赋值，避免 TDZ）
if (typeof window !== 'undefined') {
  ;(window as unknown as Record<string, unknown>).__store = useAppStore
}
