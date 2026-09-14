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
  SshProfile,
  TerminalThemeName,
  ThemeMode
} from '@shared/types'
import type { AppShortcutAction } from '@shared/types'

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

interface UiState {
  aiPanelOpen: boolean
  settingsOpen: boolean
  /** 编辑中的 SSH 配置（null=新建，undefined=关闭） */
  sshDialog: { open: boolean; editing?: SshProfile | null }
  settingsTab: 'ai' | 'terminal' | 'prefs'
  /** 是否展开服务器监控面板 */
  monitorOpen: boolean
}

interface AppStore {
  // ---------- 终端 ----------
  sessions: SessionInfo[]
  activeSessionId: string | null
  exitedSessions: Set<string>

  // ---------- SSH ----------
  profiles: SshProfile[]

  // ---------- 偏好 ----------
  preferences: Preferences

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
  createLocalSession: () => Promise<void>
  connectSsh: (profile: SshProfile) => Promise<void>
  closeSession: (id: string) => Promise<void>
  /** 会话结束后重连：按原类型/SSH 配置新建一个会话并替换旧的 */
  reconnectSession: (id: string) => Promise<void>
  setActiveSession: (id: string) => void
  refreshProfiles: () => Promise<void>

  setAiPanelOpen: (open: boolean) => void
  setSettingsOpen: (open: boolean, tab?: UiState['settingsTab']) => void
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
      set((s) => {
        const sessions = s.sessions.filter((x) => x.id !== sessionId)
        const exited = new Set(s.exitedSessions)
        exited.delete(sessionId)
        const activeSessionId =
          s.activeSessionId === sessionId
            ? (sessions[sessions.length - 1]?.id ?? null)
            : s.activeSessionId
        return { sessions, exitedSessions: exited, activeSessionId }
      })
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

    profiles: [],

    preferences: { theme: 'system', terminalTheme: 'auto', copyOnSelect: true, commandPrediction: true },

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
      settingsTab: 'ai',
      monitorOpen: false
    },

    monitors: {},

    bootstrap: async () => {
      const [profiles, configs, settings, preferences] = await Promise.all([
        window.api.ssh.list(),
        window.api.ai.listConfigs(),
        window.api.ai.getSettings(),
        window.api.prefs.get()
      ])
      set({ profiles, aiConfigs: configs, aiSettings: settings, preferences })

      // 全局快捷键：主进程触发后在此分发到具体 UI 动作
      if (!shortcutWired) {
        shortcutWired = true
        window.api.app.onShortcut((action: AppShortcutAction) => {
          const s = get()
          if (action === 'open-settings') s.setSettingsOpen(true)
          else if (action === 'new-session') void s.createLocalSession()
        })
      }
    },

    createLocalSession: async () => {
      const info = await window.api.terminal.createLocal(80, 24)
      set((s) => ({
        sessions: [...s.sessions, info],
        activeSessionId: info.id
      }))
    },

    connectSsh: async (profile) => {
      const info = await window.api.terminal.createSsh(profile.id, 80, 24)
      set((s) => ({
        sessions: [...s.sessions, info],
        activeSessionId: info.id
      }))
    },

    closeSession: async (id) => {
      await window.api.terminal.kill(id)
      // closed 事件会同步状态，双保险
      set((s) => ({
        sessions: s.sessions.filter((x) => x.id !== id),
        activeSessionId:
          s.activeSessionId === id
            ? (s.sessions.filter((x) => x.id !== id).slice(-1)[0]?.id ?? null)
            : s.activeSessionId
      }))
    },

    reconnectSession: async (id) => {
      const old = get().sessions.find((x) => x.id === id)
      if (!old) return
      // 按原会话类型创建新会话：SSH 沿用原 profileId，本地则新建本地 Shell
      const info: SessionInfo =
        old.type === 'ssh' && old.profileId
          ? await window.api.terminal.createSsh(old.profileId, 80, 24)
          : await window.api.terminal.createLocal(80, 24)
      // 关闭已退出的旧会话
      await window.api.terminal.kill(id)
      set((s) => {
        const sessions = s.sessions.filter((x) => x.id !== id)
        const exited = new Set(s.exitedSessions)
        exited.delete(id)
        return {
          sessions: [...sessions, info],
          activeSessionId: info.id,
          exitedSessions: exited
        }
      })
    },

    setActiveSession: (id) => set({ activeSessionId: id }),

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
