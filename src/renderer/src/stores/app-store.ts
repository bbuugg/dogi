/**
 * 全局 zustand store —— 渲染端唯一状态真源。
 *
 * 类型、常量、纯函数已抽到 `types.ts`（按功能域分声明）和 `pane-helpers.ts` / `agent-helpers.ts`。
 * 这里只保留 `create<AppStore>()` 的实现体与 IPC 事件监听。消费方仍从这里 import 一切。
 */
import { HOSTS_ACTIVITY_ID } from '@/app/activity-ids'
import { HOSTS_SCRIPTS_SECTION_ID } from '@/app/section-ids'
import { parseCurl } from '@/features/api/api-client'
import { scriptToTerminalInput } from '@/features/scripts/script'
import { clampTerminalFontSize } from '@/features/terminal/terminal-font'
import { applyColorTheme } from '@/shared/lib/theme'
import { requestTabClose, setTabCloseExecutor } from '@/shared/lib/tab-event-bus'
import { DEFAULT_SHORTCUTS, findShortcutByEvent } from '@shared/shortcuts'
import { isUnderNoteRoot, sameNoteRoot } from '@shared/note-folders'
import { create } from 'zustand'

// ---- 从拆分文件 re-export 全部公开符号（消费方仍只 import `@/stores/app-store`） ----
export {
  type PanelTabType,
  type SettingsTab,
  type EditorSaveState,
  type SiblingTabsCloseMode,
  type PanelTab,
  type PanelGroup,
  type AiChatState,
  type AgentRunState,
  type QueuedAgentMessage,
  type TransferItem,
  type UiState,
  type AppStore,
  SETTINGS_TABS,
  normalizeSettingsTab,
  editorSaveKey,
  HOST_LOG_LIMIT,
  NEW_API_REQUEST_ID,
  NEW_WS_REQUEST_ID,
  API_HISTORY_LIMIT,
  terminalTabId,
  apiTabId,
  agentTabId,
  agentTab,
  apiTabTitle,
  groupTerminalSessionId,
  conversationKind,
  isDraftConversation,
  emptyAiChat,
  emptyAgentRun,
  withPluginList,
  DEFAULT_PREFERENCES
} from './types'

// ---- 导入实现所需的类型与纯函数 ----
// ⚠️ 顶部的 `export { … } from './types'` **不会**把符号带进本地作用域，
// 实现体里用到的值（常量 / 纯函数）必须在这里真正 import 一次。
import {
  agentTab,
  apiTabId,
  apiTabTitle,
  emptyAgentRun,
  emptyAiChat,
  isDraftConversation,
  normalizeSettingsTab,
  terminalTabId,
  withPluginList,
  API_HISTORY_LIMIT,
  DEFAULT_PREFERENCES,
  HOST_LOG_LIMIT,
  NEW_API_REQUEST_ID,
  NEW_WS_REQUEST_ID,
  type AppStore,
  type PanelGroup,
  type TransferItem
} from './types'
import {
  genPaneId,
  insertSibling,
  makeLeaf,
  removeLeaf,
  updateSizes
} from '@/app/layout/pane-layout'
import type {
  AgentBackend,
  AgentChatMessage,
  AgentConversation,
  AgentStreamEvent,
  AiChatMessage,
  NoteFileItem,
  Preferences,
  SessionInfo
} from '@shared/types'
import {
  reconnectingIds,
  openSession,
  withoutTab,
  resolveFocus,
  applyTabClose,
  attachSessionTab,
  focusTabPatch,
  closePlainTab,
  siblingTabIds,
  closeTabsPatch,
  closeMissingPluginTabs,
  closeMissingAgentTabs,
  addOrFocusTab
} from './pane-helpers'
import {
  aiRequestSessions,
  agentRequestConversations,
  DEFAULT_CONVERSATION_TITLE,
  titleFromMessage,
  newConversation,
  ensureConversation,
  patchConversation,
  persistConversation,
  persistConversationThrottled,
  notifyAgentFinished,
  appendAgentPart,
  appendAssistantPart
} from './agent-helpers'

/** 终端字号持久化写入的防抖句柄（Ctrl+滚轮会触发连续调整） */
let fontSizeSaveTimer: number | undefined

// 所有类型、常量、纯函数已抽到 types.ts / pane-helpers.ts / agent-helpers.ts，
// 此处通过顶部 export { ... } from './types' re-export。
// 下面直接进入 create<AppStore>() 实现体。

let listenersBound = false

export const useAppStore = create<AppStore>()((set, get) => {
  /** 应用内快捷键的 keydown 监听器仅注册一次，避免 HMR / 重复 bootstrap 叠加 */
  let shortcutWired = false
  /** 退出前落盘请求的监听器同样只注册一次 */
  let flushWired = false
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
    // SSH 隧道运行态：全量推送（启动 / 停止 / 出错 / 连接数变化）
    window.api.tunnels.onStatus((runtime) => {
      set({ tunnelRuntime: Object.fromEntries(runtime.map((r) => [r.id, r])) })
    })
    // 主机日志：增量推送（初始全量在 bootstrap / 打开日志面板时拉取）。
    // 同一 seq 会再次广播（终端命令的输出增量回填同一条目）→ 按 seq 覆盖，不要盲目追加
    window.api.logs.onEntry((entry) => {
      set((s) => {
        const index = s.hostLogs.findIndex((e) => e.seq === entry.seq)
        if (index >= 0) {
          const hostLogs = [...s.hostLogs]
          hostLogs[index] = entry
          return { hostLogs }
        }
        const hostLogs = [...s.hostLogs, entry]
        if (hostLogs.length > HOST_LOG_LIMIT) hostLogs.splice(0, hostLogs.length - HOST_LOG_LIMIT)
        return { hostLogs }
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
    // 确认已有结论（中止等非用户路径）：移除对应卡片
    window.api.ai.onConfirmResolved(({ id }) => {
      set((s) => {
        if (!(id in s.pendingConfirms)) return {}
        const next = { ...s.pendingConfirms }
        delete next[id]
        return { pendingConfirms: next }
      })
    })
    // ---------- AI Agent 事件 ----------
    window.api.agent.onChatEvent(({ requestId, conversationId, event }) => {
      // ⚠️ 事件可能**早于** `agent:chat` 的返回值到达（主进程无配置的失败分支用
      // setTimeout(0) 发事件，比 invoke 回包更快），此时本地这张表里还没有这个 requestId，
      // 事件会被整条丢掉（表现为「转圈不结束 + 不弹通知」）。所以主进程在广播里
      // 直接带上 conversationId，这里优先用它补登记。
      if (conversationId) agentRequestConversations.set(requestId, conversationId)
      get().handleAgentEvent(requestId, event)
    })
    /**
     * ACP 会话就绪（`session/new` 或 `session/load` 完成）后的状态推送：
     * agent 侧会话 id + 可切换的模型列表。
     *
     * **新建的 ACP 会话靠它回填 `acpSessionId`**（那条记录本来没有 id，是 agent 建的），
     * 回填后立刻落盘 —— 否则重启后这条会话就变成「没有绑定」的孤儿记录。
     */
    window.api.agent.acp.onState((state) => {
      const before = get().agentConversations.find((c) => c.id === state.conversationId)
      // 会话记录里的绑定与推送不一致 = 这次是「新建会话」的 id 回填，需要落盘
      const needsPersist = !!before && before.acpSessionId !== state.acpSessionId
      // 原来就有 id、现在换了一个 = agent 不支持 session/load 时的降级重绑，得让用户知道
      const rebound = !!before?.acpSessionId && before.acpSessionId !== state.acpSessionId
      set((s) => ({
        acpStates: { ...s.acpStates, [state.conversationId]: state },
        ...(needsPersist
          ? {
              agentConversations: patchConversation(
                s.agentConversations,
                state.conversationId,
                { acpSessionId: state.acpSessionId },
                // 绑定关系的变更不算「有活动」，不让会话跳到列表最前
                false
              )
            }
          : {})
      }))
      if (needsPersist) void persistConversation(get().agentConversations, state.conversationId)
      if (rebound) {
        void import('antd').then(({ message }) =>
          message.warning(
            '该 ACP agent 不支持加载已有会话（session/load），已在 agent 侧新建了一个会话，原历史无法显示'
          )
        )
      }
    })
    window.api.agent.onConfirmRequest((req) => {
      set((s) => ({ agentPendingConfirms: { ...s.agentPendingConfirms, [req.id]: req } }))
    })
    // 确认已有结论（中止等非用户路径）：移除对应卡片
    window.api.agent.onConfirmResolved(({ id }) => {
      set((s) => {
        if (!(id in s.agentPendingConfirms)) return {}
        const next = { ...s.agentPendingConfirms }
        delete next[id]
        return { agentPendingConfirms: next }
      })
    })
    // ---------- ask_followup_question 提问卡（Agent 页与终端 AI 助手共用一组通道） ----------
    window.api.followup.onRequest((req) => {
      set((s) => ({ followupRequests: { ...s.followupRequests, [req.toolCallId]: req } }))
    })
    window.api.followup.onResolved(({ toolCallId }) => {
      set((s) => {
        if (!(toolCallId in s.followupRequests)) return {}
        const next = { ...s.followupRequests }
        delete next[toolCallId]
        return { followupRequests: next }
      })
    })
    window.api.monitor.onData(({ sessionId, metrics }) => {
      set((s) => {
        const monitors = { ...s.monitors, [sessionId]: metrics }
        // 新鲜指标到手：清掉该会话的「不支持监控」标记（重连后平台可能已可采集）
        if (!(sessionId in s.monitorUnsupported)) return { monitors }
        const monitorUnsupported = { ...s.monitorUnsupported }
        delete monitorUnsupported[sessionId]
        return { monitors, monitorUnsupported }
      })
    })
    window.api.monitor.onUnsupported(({ sessionId, reason }) => {
      set((s) => ({
        monitorUnsupported: { ...s.monitorUnsupported, [sessionId]: reason }
      }))
    })
  }

  return {
    sessions: [],
    activeSessionId: null,
    exitedSessions: new Set(),
    connectStages: {},
    transfers: {},
    transferTrayOpen: false,
    layout: null,
    groups: {},
    activeGroupId: null,

    profiles: [],
    sshGroups: [],
    knownHosts: [],
    tunnels: [],
    tunnelRuntime: {},
    tunnelSeed: null,
    hostLogs: [],

    scripts: [],
    scriptGroups: [],
    noteRoots: [],
    noteTrees: {},
    apiRequests: [],
    apiGroups: [],
    apiHistory: [],
    apiDraftSeed: null,

    preferences: { ...DEFAULT_PREFERENCES },

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
    // ACP 会话的本地镜像 / 运行时状态 / 加载态：都只活在内存里（消息归 agent 自己管）
    agentAcpMessages: {},
    acpStates: {},
    acpLoading: {},
    agentPendingConfirms: {},
    followupRequests: {},
    // 待发送队列：会话进行中继续发的消息排在这里（只存内存，见 QueuedAgentMessage）
    agentQueues: {},
    workspaceConfigs: {},

    skills: [],
    skillRoots: [],
    skillSettings: null,

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
      activityOrder: null,
      collapsedActivities: {},
      collapsedSections: {},
      sectionHeights: {},
      activePluginId: null,
      panelTabs: [],
      sidebarWidth: 220,
      aiPanelWidth: 300,
      aiPanelHeight: 440,
      aiFloatingPos: null,
      editorSaveStatus: {},
      shortcutRecording: false,
      agentTerminalToggle: 0
    },

    monitors: {},
    monitorUnsupported: {},

    bootstrap: async () => {
      const [profiles, sshGroups, knownHosts, tunnelInit, configs, settings, preferences, shells, scripts, scriptGroups, apiRequests, apiGroups, apiHistory, shortcuts, agentWorkspaces, agentConversations, hostLogs] = await Promise.all([
        window.api.ssh.list(),
        window.api.ssh.listGroups(),
        window.api.ssh.knownHostsList(),
        window.api.tunnels.list(),
        window.api.ai.listConfigs(),
        window.api.ai.getSettings(),
        window.api.prefs.get(),
        window.api.terminal.listShells(),
        window.api.scripts.list(),
        window.api.scripts.listGroups(),
        window.api.apiClient.list(),
        window.api.apiClient.listGroups(),
        window.api.apiClient.listHistory(),
        window.api.shortcuts.get(),
        window.api.agent.listWorkspaces(),
        window.api.agent.listConversations(),
        window.api.logs.list()
      ])
      // 配色必须在偏好写进 store 之前落到 html 上：antd 的 token 是在 store 更新引发的那次
      // 重渲染里从 CSS 变量读出来的，晚一步就会永远停在默认中性配色（直到用户手动切换）
      // 磁盘存档可能缺少新增的偏好字段（如旧版本的 hiddenActivities），用默认值兜底，
      // 否则这些字段会变成 undefined，订阅处读到 undefined.xxx 直接崩（见 activities.tsx 过滤）。
      const safePreferences: Preferences = { ...DEFAULT_PREFERENCES, ...preferences }
      applyColorTheme(safePreferences.colorTheme, safePreferences.customColor)
      // 选中第一个工作区，并定位到它最近更新的会话（一个都没有就现建一个空会话）
      const initial = ensureConversation(agentConversations, agentWorkspaces[0]?.id ?? '')
      set({
        profiles,
        sshGroups,
        knownHosts,
        tunnels: tunnelInit.tunnels,
        tunnelRuntime: Object.fromEntries(tunnelInit.runtime.map((r) => [r.id, r])),
        hostLogs,
        aiConfigs: configs,
        aiSettings: settings,
        preferences: safePreferences,
        shells,
        scripts,
        scriptGroups,
        apiRequests,
        apiGroups,
        apiHistory,
        shortcuts,
        agentWorkspaces,
        agentConversations: initial.conversations,
        activeAgentWorkspaceId: agentWorkspaces[0]?.id ?? null,
        activeAgentConversationId: initial.activeId
      })
      // 退出前的落盘请求（主进程 before-quit 时发来）：把进行中的 Agent 会话立刻写盘。
      // 平时落盘是节流的（最多丢几秒），这一下把「最后几秒」也补上。
      if (!flushWired && typeof window !== 'undefined' && window.api) {
        flushWired = true
        window.api.app.onFlushRequest(() => {
          const streaming = Object.entries(get().agentRuns)
            .filter(([, run]) => run.streaming)
            .map(([cid]) => cid)
          void Promise.all(
            streaming.map((cid) => persistConversation(get().agentConversations, cid))
          )
            .catch(() => { })
            .finally(() => void window.api.app.flushDone())
        })
      }
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
            // 设置弹窗打开时同样让路：里面的输入框 / 下拉不该被主界面的快捷键抢键
            if (s.ui.settingsOpen) return
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

      // ---------- 恢复上次的笔记会话（打开的目录 + 文件标签） ----------
      // 文件内容永远以磁盘为准，这里只还原「打开状态」；已经被删掉的文件不再恢复，
      // 否则一启动就会开出一堆「文件不存在」的标签。
      const noteSession = await window.api.notes.getSession()
      const folders = (noteSession.folders ?? []).filter(Boolean)
      if (folders.length > 0) {
        const trees: Record<string, NoteFileItem[]> = {}
        for (const folder of folders) {
          trees[folder] = await window.api.notes.refreshFolder(folder)
        }
        set({ noteRoots: folders, noteTrees: trees })
        // scanDir 给的 path 只是相对父目录的一段，得拼成完整相对路径才好比对
        const flatten = (list: NoteFileItem[], parent = ''): string[] =>
          list.flatMap((item) => {
            const full = parent ? `${parent}/${item.path}` : item.path
            return item.isDir ? flatten(item.children ?? [], full) : [full]
          })
        const aliveByRoot = folders.map((folder) => ({ folder, alive: new Set(flatten(trees[folder])) }))
        for (const abs of noteSession.files) {
          // 归属取「最长的根」：父子目录同时打开时，同一个文件会出现在两棵树里，
          // 更深的那个才是它的所属目录
          let owner: { folder: string; alive: Set<string> } | null = null
          for (const entry of aliveByRoot) {
            if (!isUnderNoteRoot(abs, entry.folder)) continue
            if (!owner || entry.folder.length > owner.folder.length) owner = entry
          }
          if (!owner) continue
          const sep = owner.folder.includes('\\') ? '\\' : '/'
          const prefix = owner.folder.replace(/[\\/]+$/, '') + sep
          const rel = abs.slice(prefix.length).split(sep).join('/')
          if (owner.alive.has(rel)) get().openNoteTab(abs, abs.split(/[\\/]/).pop() ?? abs)
        }
      }
    },

    setShortcutRecording: (recording) => set((s) => ({ ui: { ...s.ui, shortcutRecording: recording } })),

    toggleAgentTerminal: () =>
      set((s) => ({ ui: { ...s.ui, agentTerminalToggle: s.ui.agentTerminalToggle + 1 } })),

    runShortcutAction: (action) => {
      const s = get()
      if (action === 'open-settings') s.setSettingsOpen(true)
      else if (action === 'new-session') void s.createLocalSession()
      else if (action === 'open-command-palette') s.setCommandPaletteOpen(true)
      // 内嵌终端属于 AgentPage，store 只广播请求，真正的开关在页面里做
      else if (action === 'toggle-agent-terminal') s.toggleAgentTerminal()
    },

    createLocalSession: async (shellId) => {
      const info = await window.api.terminal.createLocal(80, 24, shellId)
      set((s) => attachSessionTab(s, info))
      // 新建终端后：切到主机侧边栏，方便继续挑主机
      get().selectActivity(HOSTS_ACTIVITY_ID)
    },

    connectHost: async (profile) => {
      // 远程桌面是独立主机类型：聚焦 / 打开远程桌面标签，不建立终端会话
      if (profile.kind === 'rdp') {
        get().openRdpTab(profile.id)
        get().selectActivity(HOSTS_ACTIVITY_ID)
        return null
      }
      const info = await openSession(profile.id)
      set((s) => attachSessionTab(s, info))
      // 连接后：切到主机侧边栏
      get().selectActivity(HOSTS_ACTIVITY_ID)
      return info
    },

    runScriptOnHost: async (profile, script) => {
      // connectHost 内部已切回终端功能区
      const info = await get().connectHost(profile)
      // rdp 主机没有终端会话（入口层已过滤，这里兜底）
      if (!info) throw new Error('远程桌面主机不能执行脚本')
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
      try {
        // 按原会话重建：绑定了主机的（ssh 或 local 主机）沿用它，纯本地会话新建默认 shell
        let info: SessionInfo
        if (old.profileId) {
          if (!get().profiles.some((p) => p.id === old.profileId)) {
            // 主机配置已删除：退化为普通本地终端
            info = await window.api.terminal.createLocal(80, 24)
          } else {
            // 配置还在但连接前置条件不满足（如 Mosh 缺本地 mosh-client）会抛错：
            // 提示后保持原样。不能退化为本地终端 —— 那会「重连」出一个不相干的 shell
            info = await openSession(old.profileId)
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
          // 旧会话的「不支持监控」标记同样作废（新会话会重新探测平台）
          const monitorUnsupported = { ...s.monitorUnsupported }
          delete monitorUnsupported[id]
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
            monitorUnsupported,
            aiChats
          }
        })
      } catch (e) {
        // 失败必须显式提示：否则终端停在「会话已结束」却毫无反馈，用户只会以为重连按钮坏了
        const { message } = await import('antd')
        message.error(`重连失败：${e instanceof Error ? e.message : String(e)}`)
      } finally {
        // 无论成败都要摘掉屏蔽标记：留着会让该会话后续的 closed 事件被永久忽略
        reconnectingIds.delete(id)
      }
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

    refreshKnownHosts: async () => {
      set({ knownHosts: await window.api.ssh.knownHostsList() })
    },

    /** 重置某主机的指纹记录：下次连接重新 TOFU 记录 */
    resetHostKey: async (host, port) => {
      await window.api.ssh.knownHostsReset(host, port)
      await get().refreshKnownHosts()
    },

    refreshTunnels: async () => {
      const { tunnels, runtime } = await window.api.tunnels.list()
      set({ tunnels, tunnelRuntime: Object.fromEntries(runtime.map((r) => [r.id, r])) })
    },

    saveTunnel: async (input) => {
      const { tunnels, runtime } = await window.api.tunnels.save(input)
      set({ tunnels, tunnelRuntime: Object.fromEntries(runtime.map((r) => [r.id, r])) })
    },

    removeTunnel: async (id) => {
      const { tunnels, runtime } = await window.api.tunnels.remove(id)
      set({ tunnels, tunnelRuntime: Object.fromEntries(runtime.map((r) => [r.id, r])) })
    },

    /** 启动 / 停止：失败落在主进程的运行态里，经 tunnels:status 推送回来 */
    startTunnel: async (id) => {
      await window.api.tunnels.start(id)
    },

    stopTunnel: async (id) => {
      await window.api.tunnels.stop(id)
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
      // 设置就是主窗口里的一个 antd Modal：与主界面同一个渲染进程、同一个 store，
      // 改完立即生效，不再需要「独立窗口 + 跨窗口广播回填」那套同步。
      // 打开时按入口参数重置分组（未传 = 偏好），与旧独立窗口每次新开的行为一致。
      set((s) => ({
        ui: {
          ...s.ui,
          settingsOpen: open,
          ...(open ? { settingsTab: normalizeSettingsTab(tab) } : {})
        }
      })),
    setSshDialog: (open, editing = null, groupId) =>
      set((s) => ({ ui: { ...s.ui, sshDialog: { open, editing, groupId } } })),

    setRunScriptDialog: (open, scriptId) =>
      set((s) => ({ ui: { ...s.ui, runScriptDialog: { open, scriptId } } })),

    setCommandPaletteOpen: (open) =>
      set((s) => ({ ui: { ...s.ui, commandPaletteOpen: open } })),

    selectActivity: (id) => set((s) => ({ ui: { ...s.ui, activeActivity: id } })),

    setActivityOrder: (order) => set((s) => ({ ui: { ...s.ui, activityOrder: order } })),

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

    openNoteFolder: async () => {
      const result = await window.api.notes.openFolder()
      if (!result) return null
      return get().addNoteRoots(result.roots)
    },

    addNoteRoots: async (roots) => {
      // 同一目录（Windows / macOS 不区分大小写）只允许出现一次；父子目录不互斥
      const existing = get().noteRoots
      const fresh: string[] = []
      for (const root of roots) {
        if (!root) continue
        if (existing.some((r) => sameNoteRoot(r, root))) continue
        if (fresh.some((r) => sameNoteRoot(r, root))) continue
        fresh.push(root)
      }
      if (fresh.length === 0) return { added: 0, skipped: roots.length }
      const trees: Record<string, NoteFileItem[]> = {}
      for (const root of fresh) {
        trees[root] = await window.api.notes.refreshFolder(root)
      }
      set((s) => ({
        noteRoots: [...s.noteRoots, ...fresh],
        noteTrees: { ...s.noteTrees, ...trees }
      }))
      return { added: fresh.length, skipped: roots.length - fresh.length }
    },

    removeNoteRoot: (root) => {
      // 只从侧边栏移除，磁盘文件不动
      set((s) => {
        const noteRoots = s.noteRoots.filter((r) => !sameNoteRoot(r, root))
        const noteTrees: Record<string, NoteFileItem[]> = {}
        for (const [key, value] of Object.entries(s.noteTrees)) {
          if (noteRoots.includes(key)) noteTrees[key] = value
        }
        return { noteRoots, noteTrees }
      })
    },

    readNoteFile: async (root, filePath) => {
      return window.api.notes.readFile(root, filePath)
    },

    saveNoteFile: async (filePath, content) => {
      return window.api.notes.saveFile(filePath, content)
    },

    createNoteFile: async (root, dirPath) => {
      const result = await window.api.notes.newFile(root, dirPath ?? '')
      // 刷新该目录的文件树，新文件才能出现在侧边栏
      const items = await window.api.notes.refreshFolder(root)
      set((s) => ({ noteTrees: { ...s.noteTrees, [root]: items } }))
      return result
    },

    refreshNoteFolder: async (root) => {
      const targets = root ? [root] : get().noteRoots
      const results = await Promise.all(targets.map((r) => window.api.notes.refreshFolder(r)))
      set((s) => {
        const noteTrees = { ...s.noteTrees }
        targets.forEach((r, i) => {
          noteTrees[r] = results[i]
        })
        return { noteTrees }
      })
    },

    renameNoteFile: async (root, oldPath, newName) => {
      const newPath = await window.api.notes.renameFile(root, oldPath, newName)
      const items = await window.api.notes.refreshFolder(root)
      set((s) => ({ noteTrees: { ...s.noteTrees, [root]: items } }))
      return newPath
    },

    deleteNoteFile: async (root, filePath) => {
      await window.api.notes.deleteFile(root, filePath)
      const items = await window.api.notes.refreshFolder(root)
      set((s) => ({ noteTrees: { ...s.noteTrees, [root]: items } }))
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
        body: parsed.body,
        // `-F` 解析出来的是 form-data 字段（见 parseCurl）；其余情况保持缺省的 raw
        bodyType: parsed.bodyType,
        bodyFormFields: parsed.bodyFields
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

    exportData: async (kinds) => window.api.transfer.export(kinds),

    pickImportBundle: async () => window.api.transfer.pick(),

    applyImport: async (bundleId, kinds) => {
      const result = await window.api.transfer.import(bundleId, kinds)
      if (result.ok) {
        // 导入可能带分组、也可能把条目塞进已有分组 —— 涉及的**分组与列表**都要重新拉，
        // 否则侧边栏还停在旧数据上（分组名改了 / 条目归属变了都看不出来）
        const jobs: Array<Promise<void>> = []
        if (kinds.includes('hosts')) {
          jobs.push(get().refreshProfiles())
          jobs.push(
            window.api.ssh.listGroups().then((sshGroups) => set({ sshGroups }))
          )
        }
        if (kinds.includes('api')) {
          jobs.push(get().refreshApiRequests(), get().refreshApiGroups())
        }
        await Promise.all(jobs)
      }
      return result
    },

    cancelImport: async (bundleId) => window.api.transfer.cancel(bundleId),

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

    openNoteTab: (filePath, title) => {
      set((s) => {
        // 标签 id 用文件路径的 hash 来保证唯一性（同一文件只开一个标签）
        const tabId = `note-${btoa(unescape(encodeURIComponent(filePath))).replace(/[/+=]/g, '_')}`
        return addOrFocusTab(s, {
          id: tabId,
          type: 'note',
          title: title ?? filePath.split(/[\\/]/).pop() ?? '未命名笔记',
          closable: true,
          noteFilePath: filePath
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

    /** 从历史记录载入：先存种子再开草稿。草稿页在种子 effect 里消费（见 ApiPage）。
     *  无论草稿标签此前是否已打开/激活，种子引用变化都会触发草稿重新初始化。 */
    loadApiHistoryDraft: (entry) => {
      set({
        apiDraftSeed: {
          method: entry.method || 'GET',
          url: entry.url,
          headers: entry.headers,
          body: entry.body,
          // 请求体形态一起带过去：只载入正文、把 form-data 载成 raw 会让人以为「历史记错了」
          bodyType: entry.bodyType,
          bodyUrlencoded: entry.bodyUrlencoded,
          bodyFormFields: entry.bodyFormFields
        }
      })
      get().openNewApiDraft()
    },

    consumeApiDraftSeed: () => set({ apiDraftSeed: null }),

    /** 打开主机的 SFTP 文件管理标签：标签 id 按主机 id 推导，同一主机只开一个 */
    openSftpTab: (profileId) => {
      set((s) => {
        const profile = s.profiles.find((p) => p.id === profileId)
        return addOrFocusTab(s, {
          id: `sftp-${profileId}`,
          type: 'sftp',
          title: `${profile?.name || profile?.host || 'SFTP'} 文件`,
          closable: true,
          sftpProfileId: profileId
        })
      })
    },

    /**
     * 打开主机的远程桌面（RDP）标签：标签 id 按主机 id 推导，同一主机只开一个。
     * 标签 id 同时用作 RDP 本地桥的 connId（确定性、幂等）；凭据由页面从主机配置取。
     */
    openRdpTab: (profileId) => {
      set((s) => {
        const profile = s.profiles.find((p) => p.id === profileId)
        return addOrFocusTab(s, {
          id: `rdp-${profileId}`,
          type: 'rdp',
          title: `${profile?.name || profile?.host || 'RDP'} 桌面`,
          closable: true,
          rdpProfileId: profileId
        })
      })
    },

    /** 打开「隧道」管理标签：全局单例（同 id 复用）；profileId 供右键「隧道…」预选主机 */
    openTunnelsTab: (profileId) => {
      set((s) => {
        const patch = addOrFocusTab(s, {
          id: 'tunnels',
          type: 'tunnels',
          title: '隧道',
          closable: true
        })
        return profileId ? { ...patch, tunnelSeed: profileId } : patch
      })
    },

    consumeTunnelSeed: () => set({ tunnelSeed: null }),

    /** 打开「主机日志」标签：全局单例；顺手拉一次全量（跨重启保留的记录也进来） */
    openLogsTab: () => {
      set((s) =>
        addOrFocusTab(s, {
          id: 'logs',
          type: 'logs',
          title: '主机日志',
          closable: true
        })
      )
      void get().refreshHostLogs()
    },

    refreshHostLogs: async () => {
      set({ hostLogs: await window.api.logs.list() })
    },

    clearHostLogs: async () => {
      await window.api.logs.clear()
      set({ hostLogs: [] })
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

    requestClosePanelTab: async (id) => {
      // 确认框画在标签面板内部：先带到前台，再推 close-request 给页面确认
      await requestTabCloseVisible(id)
    },

    requestCloseGroup: async (groupId) => {
      const group = get().groups[groupId]
      if (!group) return
      // 快照后逐个推（关闭会实时改组）；任一标签取消即中止剩余
      for (const tid of [...group.tabIds]) {
        if (!(await requestTabCloseVisible(tid))) return
      }
    },

    requestCloseSiblingTabs: async (tabId, mode) => {
      const ids = siblingTabIds(get(), tabId, mode)
      // 该方向没有可关的标签（首/末标签的左侧/右侧）→ 什么也不做
      if (ids.length === 0) return
      // 逐个推 close-request 确认，任一取消即中止剩余
      for (const tid of ids) {
        if (!(await requestTabCloseVisible(tid))) return
      }
    },

    closeSiblingTabs: async (tabId, mode) => {
      const ids = siblingTabIds(get(), tabId, mode)
      if (ids.length === 0) return
      const closing = new Set(ids)
      // 其中的终端会话一并结束（与 closeGroup 一致：非终端标签只关标签）
      const sessionIds = get()
        .ui.panelTabs.filter((t) => closing.has(t.id))
        .map((t) => t.sessionId)
        .filter((x): x is string => Boolean(x))
      await Promise.all(sessionIds.map((id) => window.api.terminal.kill(id)))
      set((s) => closeTabsPatch(s, closing))
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

    setAiChatConfig: (sid, configId, modelId) => {
      if (!sid) return
      set((s) => ({
        aiChats: {
          ...s.aiChats,
          [sid]: { ...(s.aiChats[sid] ?? emptyAiChat()), configId, modelId }
        }
      }))
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

    setNotifyOnAgentFinish: async (enabled) => {
      set((s) => ({ preferences: { ...s.preferences, notifyOnAgentFinish: enabled } }))
      const preferences = await window.api.prefs.save({ notifyOnAgentFinish: enabled })
      set({ preferences })
    },

    setConfirmCloseTab: async (enabled) => {
      set((s) => ({ preferences: { ...s.preferences, confirmCloseTab: enabled } }))
      const preferences = await window.api.prefs.save({ confirmCloseTab: enabled })
      set({ preferences })
    },

    setNoteSaveMode: async (mode) => {
      set((s) => ({ preferences: { ...s.preferences, noteSaveMode: mode } }))
      const preferences = await window.api.prefs.save({ noteSaveMode: mode })
      set({ preferences })
    },

    setNoteAutoSaveDelay: async (seconds) => {
      // 夹到 1–60 秒：0 会让「延迟保存」退化成每敲一下写一次盘，太大则形同没保存
      const noteAutoSaveDelay = Math.min(60, Math.max(1, Math.round(seconds) || 2))
      set((s) => ({ preferences: { ...s.preferences, noteAutoSaveDelay } }))
      const preferences = await window.api.prefs.save({ noteAutoSaveDelay })
      set({ preferences })
    },

    setHiddenActivities: async (ids) => {
      set((s) => ({ preferences: { ...s.preferences, hiddenActivities: ids } }))
      const preferences = await window.api.prefs.save({ hiddenActivities: ids })
      set({ preferences })
    },

    upsertTransfer: (progress) => {
      set((s) => {
        const prev = s.transfers[progress.transferId]
        const now = Date.now()
        // 结束态速度归零；否则按「距上次采样的字节差 / 时间差」算瞬时速度，
        // 与上次速度 0.5 加权平滑（避免进度块状跳动导致速度忽大忽小）
        if (progress.done || progress.error) {
          return {
            transfers: {
              ...s.transfers,
              [progress.transferId]: { ...progress, speed: 0 }
            }
          }
        }
        if (prev && prev.lastAt !== undefined) {
          const dt = now - prev.lastAt
          const db = progress.bytes - (prev.lastBytes ?? prev.bytes)
          if (dt >= 400 && db >= 0) {
            const inst = (db / dt) * 1000
            const speed = prev.speed > 0 ? prev.speed * 0.5 + inst * 0.5 : inst
            return {
              transfers: {
                ...s.transfers,
                [progress.transferId]: { ...progress, speed, lastAt: now, lastBytes: progress.bytes }
              }
            }
          }
          // 采样间隔太短或没有新字节：沿用上一次的速度与采样点
          return {
            transfers: {
              ...s.transfers,
              [progress.transferId]: { ...progress, speed: prev.speed, lastAt: prev.lastAt, lastBytes: prev.lastBytes }
            }
          }
        }
        // 首个进度事件：只记采样点，速度先置 0
        return {
          transfers: {
            ...s.transfers,
            [progress.transferId]: { ...progress, speed: 0, lastAt: now, lastBytes: progress.bytes }
          }
        }
      })
    },

    removeTransfer: (transferId) => {
      set((s) => {
        const next = { ...s.transfers }
        delete next[transferId]
        return { transfers: next }
      })
    },

    clearFinishedTransfers: () => {
      set((s) => {
        const next: Record<string, TransferItem> = {}
        for (const [id, t] of Object.entries(s.transfers)) {
          if (!t.done && !t.error) next[id] = t
        }
        return { transfers: next }
      })
    },

    setTransferTrayOpen: (open) => set({ transferTrayOpen: open }),

    toggleTransferTray: () => set((s) => ({ transferTrayOpen: !s.transferTrayOpen })),

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
        // 主进程把工具绑定到该会话：切换激活终端不影响这段对话的作用目标；
        // configId/modelId 也按会话带过去（未选则主进程回退到默认模型/配置默认模型）
        const { requestId } = await window.api.ai.chat({
          history,
          targetSessionId: sid,
          configId: chat.configId,
          modelId: chat.modelId
        })
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
      // 清空的是消息，不是这个会话选的模型 —— 保留 configId / modelId
      set((s) => ({
        aiChats: {
          ...s.aiChats,
          [sid]: { ...emptyAiChat(), configId: chat?.configId, modelId: chat?.modelId }
        }
      }))
    },

    /** 删除某条消息及其之后的全部消息（终端 AI 助手的「从这里重新开始」） */
    deleteAiMessagesFrom: (sid, messageId) => {
      if (!sid) return
      set((s) => {
        const chat = s.aiChats[sid]
        if (!chat) return {}
        const index = chat.messages.findIndex((m) => m.id === messageId)
        if (index < 0) return {}
        return {
          aiChats: {
            ...s.aiChats,
            [sid]: { ...chat, messages: chat.messages.slice(0, index), error: null }
          }
        }
      })
    },

    resendAiMessage: async (sid, messageId, text) => {
      const trimmed = text.trim()
      if (!sid || !trimmed) return
      const chat = get().aiChats[sid]
      if (!chat || chat.streaming) return
      const index = chat.messages.findIndex((m) => m.id === messageId)
      if (index < 0) return
      // 先同步截断（set 是同步的），再交给 sendAiMessage —— 它读的是 store 里的历史
      set((s) => ({
        aiChats: {
          ...s.aiChats,
          [sid]: { ...chat, messages: chat.messages.slice(0, index), error: null }
        }
      }))
      await get().sendAiMessage(trimmed, sid)
    },

    handleAiEvent: (requestId, event) => {
      // 路由到发起该对话的会话（不依赖当前激活终端）
      const sid = aiRequestSessions.get(requestId)
      if (!sid) return
      if (event.type === 'usage') {
        set((s) => {
          const chat = s.aiChats[sid]
          if (!chat) return {}
          const messages = [...chat.messages]
          const last = messages[messages.length - 1]
          if (last?.role === 'assistant') {
            messages[messages.length - 1] = { ...last, usage: event.usage }
          }
          return { aiChats: { ...s.aiChats, [sid]: { ...chat, messages } } }
        })
        return
      }

      // 上下文压缩：只记一条通知供顶部提示，**不改历史**（屏幕上的原文始终保留）
      if (event.type === 'context-compressed') {
        set((s) => {
          const chat = s.aiChats[sid]
          if (!chat) return {}
          return { aiChats: { ...s.aiChats, [sid]: { ...chat, contextNotice: event.info } } }
        })
        return
      }

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

    setAgentConversationModel: async (id, patch) => {
      const conversation = get().agentConversations.find((c) => c.id === id)
      // ACP 会话的模型走 setAcpConversationModel（要下发到 agent），这里只管 mastra
      if (!conversation || conversation.kind === 'acp') return
      // 选了内置模型 = 这个会话就按内置（mastra）走：顺手清掉未定形态时可能预置的 ACP agent
      const next = { ...patch, acpAgentId: undefined }
      // 不动 updatedAt：这是配置变更，不该让会话在列表里跳到最前
      set((s) => ({ agentConversations: patchConversation(s.agentConversations, id, next, false) }))
      // 未定形态的会话不落盘（persistConversation 里统一拦掉，见那里的 ⚠️）
      await persistConversation(get().agentConversations, id)
    },

    /**
     * 会话模型下拉里选中「某个 ACP agent 的模型」。
     *
     * - 形态未定（新建会话）：这就是**定型**动作 —— 记下 `acpAgentId` + `modelId`，
     *   首条消息时按它落成 `kind: 'acp'`（先不落盘，与 setAgentConversationModel 同理）；
     * - 形态已是 acp：只换 `modelId` 并立即下发 `session/set_config_option`（不重建会话）；
     * - 形态已是 mastra：忽略（**形态不可互切**）。
     */
    setAcpConversationModel: async (id, { acpAgentId, modelId }) => {
      const conversation = get().agentConversations.find((c) => c.id === id)
      if (!conversation || conversation.kind === 'mastra') return
      // 已绑定的会话不许换 agent（换 agent 等于换会话，没意义）
      const agentId = acpAgentId ?? conversation.acpAgentId
      if (!agentId) return
      if (conversation.kind === 'acp' && agentId !== conversation.acpAgentId) return
      set((s) => ({
        agentConversations: patchConversation(
          s.agentConversations,
          id,
          { acpAgentId: agentId, modelId, configId: undefined },
          false
        )
      }))
      // 未定形态的会话不落盘（persistConversation 里统一拦掉）
      await persistConversation(get().agentConversations, id)
      // 立即下发到 agent；会话还没连上（没发过消息）时由下一轮提问前的 applyModel 兜底
      try {
        await window.api.agent.acp.setModel({ conversationId: id, modelId })
      } catch (err) {
        const { message } = await import('antd')
        message.warning(`切换模型失败：${err instanceof Error ? err.message : String(err)}`)
      }
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
        // 这些会话的待发送队列一并丢掉（会话没了，排着的消息无处可发）
        const agentQueues = Object.fromEntries(
          Object.entries(s.agentQueues).filter(([cid]) =>
            conversations.some((c) => c.id === cid)
          )
        )
        const workspaceId =
          s.activeAgentWorkspaceId === id ? (workspaces[0]?.id ?? null) : s.activeAgentWorkspaceId
        const ensured = ensureConversation(conversations, workspaceId ?? '')
        // 工作区没了，它那份跟着目录走的配置缓存也一并丢掉
        const { [id]: _removedConfig, ...workspaceConfigs } = s.workspaceConfigs
        return {
          agentWorkspaces: workspaces,
          agentConversations: ensured.conversations,
          workspaceConfigs,
          agentQueues,
          activeAgentWorkspaceId: workspaceId,
          activeAgentConversationId: ensured.activeId,
          // 级联删掉的会话，它们的标签也要跟着关（否则停在「会话不存在」上）
          ...closeMissingAgentTabs(s, new Set(ensured.conversations.map((c) => c.id)))
        }
      })
    },

    loadWorkspaceConfig: async (workspaceId, force = false) => {
      if (!force && get().workspaceConfigs[workspaceId]) return
      try {
        const snapshot = await window.api.agent.config.get(workspaceId)
        set((s) => ({
          workspaceConfigs: { ...s.workspaceConfigs, [workspaceId]: snapshot }
        }))
        // JSON 损坏之类的问题只在读取时暴露一次，别让它静默变成「配置丢了」
        if (snapshot.error) {
          const { message } = await import('antd')
          message.warning(snapshot.error)
        }
      } catch (err) {
        const { message } = await import('antd')
        message.error(`读取工作区配置失败：${err instanceof Error ? err.message : String(err)}`)
      }
    },

    saveWorkspaceConfig: async (workspaceId, config) => {
      const snapshot = await window.api.agent.config.save(workspaceId, config)
      set((s) => ({
        workspaceConfigs: { ...s.workspaceConfigs, [workspaceId]: snapshot }
      }))
    },

    loadSkills: async () => {
      try {
        const result = await window.api.skills.list(get().activeAgentWorkspaceId ?? undefined)
        set({ skills: result.skills, skillRoots: result.roots, skillSettings: result.settings })
      } catch (err) {
        const { message } = await import('antd')
        message.error(`扫描技能失败：${err instanceof Error ? err.message : String(err)}`)
      }
    },

    saveSkillSettings: async (patch) => {
      try {
        const settings = await window.api.skills.saveSettings(patch)
        // 额外目录变了会影响扫描结果，所以存完重新扫一遍（技能本身没有写操作）
        const result = await window.api.skills.list(get().activeAgentWorkspaceId ?? undefined)
        set({
          skillSettings: settings,
          skills: result.skills,
          skillRoots: result.roots
        })
      } catch (err) {
        const { message } = await import('antd')
        message.error(`保存技能设置失败：${err instanceof Error ? err.message : String(err)}`)
      }
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
        /**
         * 「新建会话」= 打开**这个工作区的新建会话页**（草稿，侧边栏不列它，见 isDraftConversation）。
         *
         * 该工作区已经有草稿就**复用它**：连点两次「新建会话」应当还是同一个空页，
         * 而不是攒出两条看不见的空会话（它们永远不会出现在列表里，只能算内存垃圾）。
         */
        const existing = s.agentConversations.find(
          (c) => c.workspaceId === wid && isDraftConversation(c)
        )
        const target = existing ?? newConversation(wid)
        return {
          activeAgentWorkspaceId: wid,
          // 新会话排在前面，符合「最近在用」的直觉（复用草稿时位置不动）
          agentConversations: existing ? s.agentConversations : [target, ...s.agentConversations],
          activeAgentConversationId: target.id,
          ...addOrFocusTab(s, agentTab(target))
        }
      }),

    importAcpConversations: async ({ workspaceId, acpAgentId, sessions }) => {
      if (sessions.length === 0) return
      const now = Date.now()
      // 已导入过的（同 agent + 同 agent 侧会话 id）不重复建，避免一份会话出现两条记录
      const existing = new Set(
        get()
          .agentConversations.filter(
            (c) => c.workspaceId === workspaceId && c.acpAgentId === acpAgentId
          )
          .map((c) => c.acpSessionId)
      )
      const created: AgentConversation[] = sessions
        .filter((s) => !existing.has(s.sessionId))
        .map((s, i) => ({
          id: crypto.randomUUID(),
          workspaceId,
          kind: 'acp' as const,
          // 标题优先用 agent 给的（没有就留给用户自己改）
          title: s.title?.trim() || DEFAULT_CONVERSATION_TITLE,
          messages: [],
          acpAgentId,
          acpSessionId: s.sessionId,
          createdAt: now + i,
          updatedAt: now + i
        }))
      if (created.length === 0) return
      const last = created[created.length - 1]
      set((s) => ({
        activeAgentWorkspaceId: workspaceId,
        agentConversations: [...created, ...s.agentConversations],
        activeAgentConversationId: last.id,
        ...addOrFocusTab(s, agentTab(last))
      }))
      for (const c of created) await persistConversation(get().agentConversations, c.id)
    },

    /**
     * 打开 ACP 会话时回放它的历史（`session/load`）。
     *
     * 幂等且按会话去重：主进程对同一会话只跑一次回放（会话标签反复挂载 / StrictMode 双跑
     * 都安全），这里只负责把加载态摆出来、把请求发出去。回放结果作为一条 `history` 事件
     * 整段替换本地镜像（见 handleAgentEvent）。
     */
    loadAcpHistory: async (conversationId) => {
      const conversation = get().agentConversations.find((c) => c.id === conversationId)
      if (!conversation || conversation.kind !== 'acp') return
      // 已经有回放在跑：不重复发
      if (get().acpLoading[conversationId]) return
      // 还没在 agent 侧建过会话（新建后还没发过消息）：没有历史可回放
      if (!conversation.acpSessionId) return
      if ((get().agentRuns[conversationId] ?? emptyAgentRun()).streaming) return
      set((s) => ({ acpLoading: { ...s.acpLoading, [conversationId]: true } }))
      try {
        const { requestId } = await window.api.agent.acp.load({
          workspaceId: conversation.workspaceId,
          conversationId,
          acpAgentId: conversation.acpAgentId,
          acpSessionId: conversation.acpSessionId,
          modelId: conversation.modelId
        })
        agentRequestConversations.set(requestId, conversationId)
      } catch (err) {
        // 加载失败：清掉加载态并提示（会话本身还能继续用，只是看不到历史）
        set((s) => {
          const { [conversationId]: _drop, ...acpLoading } = s.acpLoading
          return { acpLoading }
        })
        const { message } = await import('antd')
        message.error(`加载会话历史失败：${err instanceof Error ? err.message : String(err)}`)
      }
    },

    selectAgentConversation: (id) => {
      set((s) => {
        const conversation = s.agentConversations.find((c) => c.id === id)
        return {
          activeAgentConversationId: id,
          // 标签化之后「选中会话」= 把它的标签带到前台（侧边栏点击走的就是这条）
          ...(conversation ? addOrFocusTab(s, agentTab(conversation)) : {})
        }
      })
      // 切到一个已经跑完、但还排着消息的会话（比如上一轮是在别的会话里跑完的）→ 接着发
      get().pumpAgentQueue(id)
    },
    renameAgentConversation: async (id, title) => {
      const next = title.trim() || DEFAULT_CONVERSATION_TITLE
      set((s) => ({
        agentConversations: patchConversation(s.agentConversations, id, { title: next })
      }))
      await persistConversation(get().agentConversations, id)
    },

    deleteAgentConversation: async (id, options = {}) => {
      // 正在流式输出就先中止，否则主进程那个会话的 agent 进程会变成孤儿
      if ((get().agentRuns[id] ?? emptyAgentRun()).requestId) await get().abortAgent(id)
      const target = get().agentConversations.find((c) => c.id === id)
      // ACP 会话：默认只删本地绑定（agent 侧会话保留，下次还能导入回来）；
      // 用户显式勾了「同时删除」才连 agent 侧一起删 —— 失败只提示，本地记录照删。
      if (options.deleteRemoteSession && target?.kind === 'acp' && target.acpAgentId && target.acpSessionId) {
        try {
          await window.api.agent.acp.deleteSession({
            acpAgentId: target.acpAgentId,
            sessionId: target.acpSessionId
          })
        } catch (err) {
          const { message } = await import('antd')
          message.warning(
            `已删除本地会话，但 ACP agent 侧的会话未删除：${
              err instanceof Error ? err.message : String(err)
            }`
          )
        }
      }
      await window.api.agent.deleteConversation(id)
      set((s) => {
        const conversations = s.agentConversations.filter((c) => c.id !== id)
        const { [id]: _removed, ...runs } = s.agentRuns
        // ACP 的本地消息镜像 / 运行态 / 加载态一并清掉
        const { [id]: _removedAcp, ...agentAcpMessages } = s.agentAcpMessages
        const { [id]: _removedState, ...acpStates } = s.acpStates
        const { [id]: _removedLoading, ...acpLoading } = s.acpLoading
        // 待发送队列也跟着没（会话都没了，排着的消息无处可发）
        const { [id]: _removedQueue, ...agentQueues } = s.agentQueues
        // 删的正是当前会话时，切到同工作区剩下的最近一个，没有就现建
        const ensured =
          s.activeAgentConversationId === id
            ? ensureConversation(conversations, s.activeAgentWorkspaceId ?? '')
            : { conversations, activeId: s.activeAgentConversationId }
        return {
          agentConversations: ensured.conversations,
          agentRuns: runs,
          agentAcpMessages,
          acpStates,
          acpLoading,
          agentQueues,
          activeAgentConversationId: ensured.activeId,
          // 会话没了，它的标签也跟着关
          ...closeMissingAgentTabs(s, new Set(ensured.conversations.map((c) => c.id)))
        }
      })
    },

    sendAgentMessage: async (text, conversationId) => {
      const trimmed = text.trim()
      const cid = conversationId
      if (!cid || !trimmed) return
      const conversation = get().agentConversations.find((c) => c.id === cid)
      if (!conversation) return
      // 工作区从会话自身推导：会话归属哪个目录，工具就只能作用在哪个目录。
      // 不再读 activeAgentWorkspaceId —— 那个指针属于侧边栏的选中态，多标签并存时只能指向一个。
      const wid = conversation.workspaceId
      if (!wid) return
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
      /**
       * **首条消息定型**：会话形态在创建时是「未定」的，由这里选中的模型决定 ——
       * 选了某个 ACP agent 的模型（未定形态下会先写进 `acpAgentId`）就是 `acp`，
       * 否则按内置的 mastra 走（没选模型时回退到设置里的默认模型配置）。
       * 定型后立刻连 `kind` 一起落盘，之后不可再切（见 4.3）。
       */
      const kind: AgentBackend = conversation.kind ?? (conversation.acpAgentId ? 'acp' : 'mastra')
      // 本轮带过去的「已有消息」：ACP 会话的上下文由 agent 自己维护，本地镜像仅供展示；
      // mastra 则要把完整历史（含刚加的用户消息）交给模型。
      const isAcp = kind === 'acp'
      const existing = isAcp ? (get().agentAcpMessages[cid] ?? []) : conversation.messages
      const history = [...existing, userMsg]
      // 首条消息顺手定标题，省得用户手动命名（之后可在会话列表里改）
      const title = existing.length === 0 ? titleFromMessage(trimmed) : conversation.title

      set((s) =>
        isAcp
          ? {
            // ACP：消息只进本地镜像（**不落盘**，那部分归 agent 自己管）
            agentAcpMessages: { ...s.agentAcpMessages, [cid]: [...history, assistantMsg] },
            agentConversations: patchConversation(s.agentConversations, cid, { title, kind }),
            agentRuns: { ...s.agentRuns, [cid]: { streaming: true, requestId: null, error: null, retryable: false } }
          }
          : {
            agentConversations: patchConversation(s.agentConversations, cid, {
              messages: [...history, assistantMsg],
              title,
              kind
            }),
            agentRuns: { ...s.agentRuns, [cid]: { streaming: true, requestId: null, error: null, retryable: false } }
          }
      )
      // 会话元信息（标题 / 更新时刻；mastra 还含用户消息）立刻落盘：
      // 这一轮即便失败 / 应用被关，输入也不会丢
      void persistConversation(get().agentConversations, cid)

      try {
        const { requestId } = await window.api.agent.chat({
          workspaceId: wid,
          conversationId: cid,
          // 会话形态（上面刚定型）；模型配置 / 具体模型 / ACP 绑定都按会话带过去（未选则主进程回退）
          kind,
          history,
          configId: conversation.configId,
          modelId: conversation.modelId,
          acpAgentId: conversation.acpAgentId,
          acpSessionId: conversation.acpSessionId
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

    submitAgentMessage: async (text, conversationId) => {
      const trimmed = text.trim()
      const cid = conversationId
      if (!cid || !trimmed) return
      // 会话正在跑 → 排进队列，等本轮自然结束后接上；空闲则直接发一轮
      if ((get().agentRuns[cid] ?? emptyAgentRun()).streaming) {
        get().enqueueAgentMessage(trimmed, cid)
        return
      }
      await get().sendAgentMessage(trimmed, cid)
    },

    enqueueAgentMessage: (text, conversationId) => {
      const cid = conversationId
      const trimmed = text.trim()
      if (!cid || !trimmed) return
      set((s) => ({
        agentQueues: {
          ...s.agentQueues,
          [cid]: [
            ...(s.agentQueues[cid] ?? []),
            { id: `q-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, text: trimmed, createdAt: Date.now() }
          ]
        }
      }))
    },

    removeQueuedAgentMessage: (id, conversationId) => {
      const cid = conversationId
      if (!cid) return
      set((s) => {
        const current = s.agentQueues[cid]
        if (!current?.some((m) => m.id === id)) return {}
        // 最后一条删掉时直接丢整个 key（保持 `agentQueues` 干净，不留空数组）
        const { [cid]: _dropped, ...rest } = s.agentQueues
        return { agentQueues: current.length > 1 ? { ...rest, [cid]: current.filter((m) => m.id !== id) } : rest }
      })
    },

    sendQueuedAgentMessage: async (id, conversationId) => {
      const cid = conversationId
      if (!cid) return
      // 正在跑就点不了「现在发」：那时点下去也发不出去（只会重新入队），不如直接置灰
      if ((get().agentRuns[cid] ?? emptyAgentRun()).streaming) return
      const item = (get().agentQueues[cid] ?? []).find((m) => m.id === id)
      if (!item) return
      get().removeQueuedAgentMessage(id, cid)
      await get().sendAgentMessage(item.text, cid)
    },

    /**
     * 队列泵：会话空闲且队列非空时弹出第一条接着跑。
     * 由本轮自然结束（`handleAgentEvent` 的 finish）与切到空闲会话（`selectAgentConversation`）
     * 调用，形成「一条接一条」的链式执行。
     *
     * ⚠️ 报错与用户手动停止都**不**接续：队列留着，等用户自己再发或重试（与 fishwork 一致）。
     */
    pumpAgentQueue: (conversationId) => {
      const cid = conversationId
      if (!cid) return
      if ((get().agentRuns[cid] ?? emptyAgentRun()).streaming) return
      const next = (get().agentQueues[cid] ?? [])[0]
      if (!next) return
      get().removeQueuedAgentMessage(next.id, cid)
      void get().sendAgentMessage(next.text, cid)
    },

    abortAgent: async (conversationId) => {
      // 必传：删除会话 / 工作区时也显式指定，避免留下孤儿请求
      const cid = conversationId
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
          [cid]: {
            ...(s.agentRuns[cid] ?? emptyAgentRun()),
            streaming: false,
            requestId: null,
            retryable: false
          }
        }
      }))
    },

    clearAgentMessages: (conversationId) => {
      const cid = conversationId
      if (!cid) return
      const requestId = (get().agentRuns[cid] ?? emptyAgentRun()).requestId
      if (requestId) agentRequestConversations.delete(requestId)
      const conversation = get().agentConversations.find((c) => c.id === cid)
      // ACP 会话的「消息」只是本地镜像：清掉它并不影响 agent 侧的上下文，
      // 重新打开会话（session/load）历史还会回来 —— 所以这里只清镜像。
      if (conversation?.kind === 'acp') {
        set((s) => ({
          agentAcpMessages: { ...s.agentAcpMessages, [cid]: [] },
          agentRuns: { ...s.agentRuns, [cid]: emptyAgentRun() }
        }))
        return
      }
      set((s) => ({
        agentConversations: patchConversation(s.agentConversations, cid, { messages: [] }),
        agentRuns: { ...s.agentRuns, [cid]: emptyAgentRun() }
      }))
      void persistConversation(get().agentConversations, cid)
    },

    /**
     * 删除某条消息及其之后的全部消息（「从这里重新开始」）。
     *
     * **只对 mastra 会话生效**：ACP 会话的历史归 agent 管，本地删掉只会让画面与 agent 侧
     * 的上下文不一致（重新打开会话又会回放回来），所以 UI 侧也禁用了这个入口。
     */
    deleteAgentMessagesFrom: async (messageId, conversationId) => {
      const cid = conversationId
      if (!cid) return
      const conversation = get().agentConversations.find((c) => c.id === cid)
      if (!conversation || conversation.kind === 'acp') return
      const index = conversation.messages.findIndex((m) => m.id === messageId)
      if (index < 0) return
      set((s) => ({
        agentConversations: patchConversation(s.agentConversations, cid, {
          messages: conversation.messages.slice(0, index)
        }),
        // 顺带清掉上一轮留下的报错条：消息都删了还挂着旧错误会很怪
        agentRuns: {
          ...s.agentRuns,
          [cid]: { ...(s.agentRuns[cid] ?? emptyAgentRun()), error: null }
        }
      }))
      await persistConversation(get().agentConversations, cid)
    },

    /** 编辑后重发：只对 mastra 会话生效（理由同 deleteAgentMessagesFrom） */
    resendAgentMessage: async (messageId, text, conversationId) => {
      const trimmed = text.trim()
      const cid = conversationId
      if (!cid || !trimmed) return
      const conversation = get().agentConversations.find((c) => c.id === cid)
      if (!conversation || conversation.kind === 'acp') return
      if ((get().agentRuns[cid] ?? emptyAgentRun()).streaming) return
      const index = conversation.messages.findIndex((m) => m.id === messageId)
      if (index < 0) return
      // 先同步截断（set 是同步的），再交给 sendAgentMessage —— 它读的是 store 里的历史，
      // 顺序反了就会把旧消息一起带进去，模型会看到「编辑前 + 编辑后」两条
      set((s) => ({
        agentConversations: patchConversation(s.agentConversations, cid, {
          messages: conversation.messages.slice(0, index)
        }),
        agentRuns: {
          ...s.agentRuns,
          [cid]: { ...(s.agentRuns[cid] ?? emptyAgentRun()), error: null }
        }
      }))
      await get().sendAgentMessage(trimmed, cid)
    },

    /** 断流重试：找到该 assistant 消息前一条用户消息，删掉它及其之后、用原文本重发这一轮。
     *  复用 resendAgentMessage 的「截断 + 重发」语义，避免同一句话在历史里出现两遍。 */
    retryAgentTurn: async (conversationId, assistantMessageId) => {
      const cid = conversationId
      const conversation = get().agentConversations.find((c) => c.id === cid)
      if (!conversation || conversation.kind === 'acp') return
      if ((get().agentRuns[cid] ?? emptyAgentRun()).streaming) return
      const idx = conversation.messages.findIndex((m) => m.id === assistantMessageId)
      if (idx < 1) return
      const userMsg = conversation.messages[idx - 1]
      if (userMsg?.role !== 'user') return
      const text = userMsg.parts
        .filter((p) => p.type === 'text')
        .map((p) => (p.type === 'text' ? p.text : ''))
        .join('')
      if (!text.trim()) return
      await get().resendAgentMessage(userMsg.id, text, cid)
    },

    handleAgentEvent: (requestId, event) => {
      // 路由到发起该对话的会话（不依赖当前选中）
      const cid = agentRequestConversations.get(requestId)
      if (!cid) return
      /**
       * ACP 会话的消息落在**本地镜像**（`agentAcpMessages`，不落盘）；
       * mastra 会话落在自己的 `messages` 上。两者只有存放位置不同，渲染完全一致。
       */
      const isAcp = get().agentConversations.find((c) => c.id === cid)?.kind === 'acp'

      /** 把事件追加到最后一条 assistant 消息上 */
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

      /** 就地更新「这个会话的消息列表」（按形态落到镜像或会话上） */
      const updateMessages = (
        transform: (messages: AgentChatMessage[]) => AgentChatMessage[]
      ): void => {
        set((s) => {
          if (isAcp) {
            const current = s.agentAcpMessages[cid] ?? []
            return { agentAcpMessages: { ...s.agentAcpMessages, [cid]: transform(current) } }
          }
          const conversation = s.agentConversations.find((c) => c.id === cid)
          if (!conversation) return {}
          return {
            agentConversations: patchConversation(
              s.agentConversations,
              cid,
              { messages: transform(conversation.messages) },
              // 流式 token（text/reasoning/tool-call/tool-result）高频追加：不 bump updatedAt，
              // 否则会话列表（按 updatedAt 降序）会被持续重排、闪烁
              false
            )
          }
        })
      }

      /** 清掉该会话的「历史回放中」标记（回放结束 / 失败时） */
      const clearLoading = (): void => {
        if (!isAcp) return
        set((s) => {
          if (!(cid in s.acpLoading)) return {}
          const { [cid]: _drop, ...acpLoading } = s.acpLoading
          return { acpLoading }
        })
      }

      // ACP 的历史回放（打开会话时由 session/load 产出）：整段替换本地镜像
      if (event.type === 'history') {
        set((s) => ({ agentAcpMessages: { ...s.agentAcpMessages, [cid]: event.messages } }))
        return
      }

      if (event.type === 'usage') {
        updateMessages((messages) => {
          const next = [...messages]
          const last = next[next.length - 1]
          if (last?.role === 'assistant') {
            next[next.length - 1] = { ...last, usage: event.usage }
          }
          return next
        })
        return
      }

      // 上下文压缩：只记一条通知供顶部提示，**不改历史也不落盘**
      // （压缩改的是「这一次请求怎么带上下文」，屏幕上的原文始终可翻 / 可复制 / 可编辑重发）
      if (event.type === 'context-compressed') {
        set((s) => ({
          agentRuns: {
            ...s.agentRuns,
            [cid]: { ...(s.agentRuns[cid] ?? emptyAgentRun()), contextNotice: event.info }
          }
        }))
        return
      }

      if (event.type === 'finish') {
        agentRequestConversations.delete(requestId)
        // 这次是「打开会话时回放历史」还是「真的跑了一轮」？回放不该发系统通知
        const wasReplay = isAcp && !!get().acpLoading[cid]
        clearLoading()
        set((s) => ({
          agentRuns: {
            ...s.agentRuns,
            [cid]: { ...(s.agentRuns[cid] ?? emptyAgentRun()), streaming: false, requestId: null }
          }
        }))
        // 应用不在前台时发系统通知（是否真弹由主进程按窗口状态 + 偏好决定）
        if (!wasReplay) notifyAgentFinished(cid, event.finishReason)
        // 整轮结束才落盘：中途每个 part 都写盘会让长回复反复序列化同一段历史。
        // ACP 会话没有消息要落盘（标题 / updatedAt 也只在发消息时写）。
        if (!isAcp) void persistConversation(get().agentConversations, cid)
        // 兜底：该对话已结束但仍有其挂起确认时按取消处理，避免主进程工具悬挂
        for (const c of Object.values(get().agentPendingConfirms)) {
          if (c.requestId === requestId) void get().resolveAgentConfirm(c.id, false)
        }
        // 自然收尾：把队列里的下一条顶上来接着跑（被中止 / 报错的那条不会走到这里，
        // 队列留着等用户自己处理 —— 见 pumpAgentQueue）
        get().pumpAgentQueue(cid)
        return
      }

      if (event.type === 'error') {
        // 报错即视为本轮对话结束：立刻复位 streaming，不依赖后续 finish 事件
        agentRequestConversations.delete(requestId)
        clearLoading()
        if (isAcp) {
          // ACP：错误（含「agent 不支持 session/load」这类回放失败）走会话页顶部的错误条 ——
          // 历史还没回放出来时镜像可能是空的，塞进消息流会看不见
          set((s) => ({
            agentRuns: {
              ...s.agentRuns,
              [cid]: {
                ...(s.agentRuns[cid] ?? emptyAgentRun()),
                streaming: false,
                requestId: null,
                error: event.message
              }
            }
          }))
        } else {
          updateMessages((messages) => appendToLast(messages, event))
          set((s) => ({
            agentRuns: {
              ...s.agentRuns,
              [cid]: {
                ...(s.agentRuns[cid] ?? emptyAgentRun()),
                streaming: false,
                requestId: null,
                error: null,
                retryable: event.retryable ?? false
              }
            }
          }))
          void persistConversation(get().agentConversations, cid)
        }
        for (const c of Object.values(get().agentPendingConfirms)) {
          if (c.requestId === requestId) void get().resolveAgentConfirm(c.id, false)
        }
        return
      }

      updateMessages((messages) => appendToLast(messages, event))
      // 流式期间增量落盘：中途关掉应用也不至于丢掉这一轮已有的产出
      // （ACP 会话没有消息要落盘，跳过）
      if (!isAcp) persistConversationThrottled(cid)
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
    },

    resolveFollowup: async (toolCallId, answer) => {
      const req = get().followupRequests[toolCallId]
      if (!req) return
      // 本地立即移除卡片（主进程也会广播 resolved，幂等无害）
      set((s) => {
        if (!(toolCallId in s.followupRequests)) return {}
        const next = { ...s.followupRequests }
        delete next[toolCallId]
        return { followupRequests: next }
      })
      await window.api.followup.resolve(req.id, answer)
    }
  }
})

// ---- 标签关闭回执：「真正执行关闭」由本 store 提供（见 shared/lib/tab-event-bus.ts） ----
setTabCloseExecutor((id) => useAppStore.getState().closePanelTab(id))

/**
 * 把标签带到前台再推关闭请求。
 *
 * 确认框画在标签面板内部（InlineConfirm），背景标签处于 `hidden` 面板里，
 * 不先激活的话确认框渲染出来也不可见、也无法点击 —— 先 setActiveGroup +
 * activatePanelTab，等 React 摘掉 hidden 再推 close-request。
 */
async function requestTabCloseVisible(id: string): Promise<boolean> {
  const s = useAppStore.getState()
  const tab = s.ui.panelTabs.find((t) => t.id === id)
  if (!tab) return true
  const group = s.groups[tab.groupId]
  if (group && group.activeTabId !== id) {
    s.setActiveGroup(tab.groupId)
    s.activatePanelTab(id)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return requestTabClose(id)
}

/**
 * 笔记会话落盘：打开的文件夹或笔记标签一变，就把当前状态写回主进程，
 * 下次启动据此恢复（恢复逻辑见 bootstrap 的「恢复上次的笔记会话」）。
 *
 * 用订阅 + 节流统一处理，而不是在 openNoteTab / 关标签等每处挂钩子：
 * 标签能从很多路径变化（新建 / 打开 / 关闭 / 关闭其他 / 关闭整组），
 * 逐个去挂，漏一个就再也存不对了。
 */
if (typeof window !== 'undefined' && window.api?.notes?.saveSession) {
  let noteSessionTimer: ReturnType<typeof setTimeout> | null = null
  let lastNoteSession = ''
  useAppStore.subscribe((s) => {
    const files = s.ui.panelTabs
      .filter((t) => t.type === 'note' && t.noteFilePath)
      .map((t) => t.noteFilePath as string)
    const key = JSON.stringify({ folders: s.noteRoots, files })
    if (key === lastNoteSession) return
    lastNoteSession = key
    if (noteSessionTimer) clearTimeout(noteSessionTimer)
    noteSessionTimer = setTimeout(() => {
      noteSessionTimer = null
      void window.api.notes.saveSession({ folders: s.noteRoots, files })
    }, 400)
  })
}

// CDP 调试暴露（模块初始化完成后赋值，避免 TDZ）
if (typeof window !== 'undefined') {
  ; (window as unknown as Record<string, unknown>).__store = useAppStore
}
