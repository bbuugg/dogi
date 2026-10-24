/**
 * 会话浮窗（desktop `?window=conversation`）：**单窗口**，一次显示一条会话或某个项目的
 * 「新建会话页」，可在窗内切换项目 / 会话。Provider 组合是 `ChatPanel` 的真实依赖
 * （缺一即崩或失效），见 spec §5.5。
 *
 * `initialConversationId` 只是**首次打开**的种子；store 已在 `main.tsx` 模块作用域种好
 * （见那里的注释与 Global Constraints「Seed the store before render」）。
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  Archive,
  Check,
  ChevronRight,
  ExternalLink,
  Folder,
  MessageSquare,
  PanelLeft,
  Pencil,
  Pin,
  PinOff,
  SquarePen,
  X
} from 'lucide-react'
import { Toaster } from '@fizz/ui/sonner'
import { TooltipProvider } from '@fizz/ui/tooltip'
import { DndProvider } from 'react-dnd'
import { HTML5Backend } from 'react-dnd-html5-backend'
import { AppProvider } from '@fizz/agent-kit/shell/app-provider'
import { ConfirmProvider } from '@fizz/agent-kit/shared/components/ConfirmProvider'
import { ChatPanel } from '@fizz/agent-kit/features/chat/ChatPanel'
import {
  useAgentAppView,
  useAttachRemoteRun,
  type AgentApp
} from '@fizz/agent-kit/shared/hooks/useAgentApp'
import { useAgentStore } from '@fizz/agent-kit/shared/lib/stores/agent-store'
import {
  AppContext,
  useAppContext,
  type AppContextValue
} from '@fizz/agent-kit/shared/hooks/use-app-context'
import { draftPanelKey } from '@fizz/agent-kit/shared/lib/panel-session'
import { cn } from '@fizz/agent-kit/shared/lib/utils'
import {
  adoptSentConversation,
  floatProjectGroups,
  initialSelection,
  projectDisplayName,
  resolveContentKind,
  selectConversation,
  selectProject,
  type FloatContentKind,
  type FloatProjectGroup,
  type FloatSelection
} from './float-selection'

/** react-dnd 单例槽必须传，且必须是 window（见 app-shell.tsx 的 DND_CONTEXT 注释） */
const DND_CONTEXT: unknown = typeof window === 'undefined' ? {} : window

const IS_MAC = /mac/i.test(navigator.platform || navigator.userAgent)

export function ConversationWindow({ initialConversationId }: { initialConversationId?: string }) {
  return (
    <div className="flex h-full flex-col overflow-hidden">
      <TooltipProvider>
        <AppProvider>
          <ConfirmProvider>
            <DndProvider backend={HTML5Backend} context={DND_CONTEXT}>
              <FloatContextOverride>
                <FloatShell initialConversationId={initialConversationId} />
              </FloatContextOverride>
            </DndProvider>
          </ConfirmProvider>
        </AppProvider>
      </TooltipProvider>
    </div>
  )
}

/**
 * 浮窗没有外壳：把 ChatPanel 依赖的外壳能力就地改语义。
 * - 文档 chip 的「挂出文件面板」→ 浮窗无右侧面板，降级 no-op
 *
 * 设置入口**不用在这里覆盖**：desktop 的 `AppProvider` 已经把 `openSettingsTab` 实现成
 * 「开独立设置窗口（带分组）」，浮窗与主窗口共用同一份（模型齿轮照样落到「模型」分组）。
 */
function FloatContextOverride({ children }: { children: ReactNode }) {
  const ctx = useAppContext()
  const value: AppContextValue = {
    ...ctx,
    showSideTabOf: () => undefined
  }
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>
}

function FloatShell({ initialConversationId }: { initialConversationId?: string }) {
  const { theme } = useAppContext()
  // 种子在 main.tsx 的模块作用域已写进 store（openConversation(seed|null)），这里只读当前值
  const [selection, setSelection] = useState<FloatSelection>(() =>
    initialSelection(
      initialConversationId,
      useAgentStore.getState().conversations,
      useAgentStore.getState().activeWorkspaceId
    )
  )
  const [listOpen, setListOpen] = useState(false)

  const app = useAgentAppView(selection.conversationId) // 会话态订该会话；草稿态传 null
  useAttachRemoteRun(selection.conversationId)

  // 会话态：把 store 活跃会话设成它（发送 / 审批 / 插话都按活跃会话走）
  useEffect(() => {
    if (selection.conversationId) void useAgentStore.getState().openConversation(selection.conversationId)
  }, [selection.conversationId])

  // 草稿态：进某项目的「新建会话页」——复用主界面点项目行那条路
  useEffect(() => {
    if (selection.conversationId !== null || !selection.projectId) return
    useAgentStore.getState().selectWorkspace(selection.projectId, false)
    void useAgentStore.getState().openConversation(null)
  }, [selection.conversationId, selection.projectId])

  /**
   * 草稿页发出第一条消息后**跟过去**：`send` 会在 `newConversation` 里建出真实会话并把
   * store 的活跃会话设成它（`conversation.ts:2221`），而浮窗草稿态传给 `useAgentAppView`
   * 的恒是 `null`，不跟就会一直停在「新建会话」页（现象：「消息发出去了却没切过去」）。
   * 主界面那层由 `PanelView` 就地替换占位标签完成，浮窗没有标签层，得自己跟。
   */
  const storeActiveConversationId = useAgentStore((s) => s.activeConversationId)
  useEffect(() => {
    if (selection.conversationId !== null) return
    /**
     * 判「是不是刚发出了第一条消息」必须读**当前**活跃会话，不能读这一帧的快照：
     * 上面那条「进草稿页」的 effect 先跑（effect 按声明顺序执行）并把活跃会话清成 null，
     * 快照里却还是旧会话 —— 拿它判断就会把「用户点了新建会话」误认成「草稿页刚发出消息」，
     * 一进草稿页就被拽回旧会话。
     */
    const activeId = useAgentStore.getState().activeConversationId
    if (!activeId) return
    setSelection(
      (s) => adoptSentConversation(s, activeId, useAgentStore.getState().conversations) ?? s
    )
  }, [storeActiveConversationId, selection.conversationId])

  const kind = resolveContentKind(selection, {
    conversationsLoaded: app.conversationsLoaded,
    // 「有东西可看」= 有可用的项目 或 有任何会话（含无工作区会话）；虚拟项目（无 path）不算
    hasProjects: app.conversations.length > 0 || app.workspaces.some((w) => !!w.path),
    conversationExists: selection.conversationId
      ? app.conversations.some((c) => c.id === selection.conversationId)
      : true
  })
  const conv = selection.conversationId
    ? app.conversations.find((c) => c.id === selection.conversationId)
    : undefined
  // 顶部中央显示的项目名：会话态用会话自己的 workspace，草稿态用选中的项目
  const projectId = conv?.workspaceId ?? selection.projectId
  const projectName = projectDisplayName(app.workspaces, projectId)
  const groups = floatProjectGroups(app.workspaces, app.conversations)

  const pickConversation = (id: string, ws: string): void => {
    setSelection((s) => selectConversation(s, id, ws))
    setListOpen(false)
  }
  const pickProject = (pid: string): void => {
    /**
     * ⚠️ 清活跃会话与改选中必须落在**同一次点击**里。
     *
     * 只改 `selection` 的话，下面那条「跟去新会话」的 effect 会拿着**这一帧的旧活跃会话**
     * （用户刚看完的那条）跑一次：草稿态 + 活跃会话非空 = 它以为「草稿页刚发出第一条
     * 消息」，于是把选中项拽回旧会话 —— 现象就是「点新建会话没反应」。
     */
    void useAgentStore.getState().openConversation(null)
    setSelection((s) => selectProject(s, pid))
    setListOpen(false)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Toaster theme={theme} position="top-center" />
      <FloatTitleBar
        projectName={projectName}
        listOpen={listOpen}
        onToggleList={() => setListOpen((v) => !v)}
        canNew={!!projectId}
        onNewConversation={() => {
          if (projectId) pickProject(projectId)
        }}
        canOpenInMain={selection.conversationId !== null}
        onOpenInMain={() => {
          // 主进程把主窗口拉到前台、把 id 递过去；浮窗开着不管（用户可能还要对照着看）。
          // 草稿态没有会话可传，只把主窗口叫出来 —— 按钮此时是禁用的，这里只兜底。
          void window.fizzWindow.openInMainWindow(selection.conversationId ?? undefined)
        }}
      />
      {/* ⚠️ 这一层必须是 flex 列：`FloatContent` 的根用 `flex-1` 撑满，父级不是 flex 时
          `flex-1` 失效 → ChatPanel 拿不到受限高度（Review Focus #4）。 */}
      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden p-2 bg-background">
        <FloatContent
          kind={kind}
          app={app}
          selection={selection}
          onSelectConversation={pickConversation}
        />
        <FloatProjectList
          open={listOpen}
          groups={groups}
          selection={selection}
          projectId={projectId}
          onSelectConversation={pickConversation}
          onSelectProject={pickProject}
          onClose={() => setListOpen(false)}
        />
      </div>
    </div>
  )
}

/**
 * 浮窗标题栏：拖拽区 + 项目列表 / 置顶（左）+ 项目名（中）+ 在主窗口打开 / 新会话 / 关闭（右）。
 *
 * 「在主窗口打开」放最右一排的**第一个**（新会话左边）：它与关闭同属「这条会话去哪」，
 * 但比「新建」更接近「把当前这个带走」，挨着标题正文更好找。
 */
function FloatTitleBar({
  projectName,
  listOpen,
  onToggleList,
  canNew,
  onNewConversation,
  canOpenInMain,
  onOpenInMain
}: {
  projectName: string
  listOpen: boolean
  onToggleList: () => void
  canNew: boolean
  onNewConversation: () => void
  /** 有会话才可跳主窗口：草稿页在主窗口里没有对应的东西可打开 */
  canOpenInMain: boolean
  onOpenInMain: () => void
}) {
  const [pinned, setPinned] = useState(() => window.fizzWindow.loadAlwaysOnTop())

  return (
    <header className="app-drag flex h-9 shrink-0 items-center gap-1 bg-background px-2">
      {IS_MAC && <div className="w-[76px] shrink-0" />}
      <div className="app-no-drag flex items-center">
        <FloatButton
          title={pinned ? '取消置顶' : '置顶'}
          onClick={() => {
            const next = !pinned
            setPinned(next)
            void window.fizzWindow.setAlwaysOnTop(next)
          }}
        >
          {pinned ? <Pin className="size-3.5" /> : <PinOff className="size-3.5" />}
        </FloatButton>
        <FloatButton title="会话列表" active={listOpen} onClick={onToggleList}>
          <PanelLeft className="size-3.5" />
        </FloatButton>
      </div>
      <span className="min-w-0 flex-1 truncate text-center text-sm text-muted-foreground font-bold" title={projectName}>
        {projectName}
      </span>
      <div className="app-no-drag flex items-center">
        {/*
          在主窗口打开：浮窗适合「随手问一句 + 一直摆着」，要正经看长回答 / 开终端时
          还是主窗口。只在**有会话**时可用 —— 草稿页在主窗口没有对应物。
          点完不关浮窗：用户常常是想两边对照着看。
        */}
        <FloatButton
          title={canOpenInMain ? '在主窗口打开' : '在主窗口打开（先选一条会话）'}
          disabled={!canOpenInMain}
          onClick={onOpenInMain}
        >
          <ExternalLink className="size-3.5" />
        </FloatButton>
        <FloatButton title="新建会话" disabled={!canNew} onClick={onNewConversation}>
          <SquarePen className="size-3.5" />
        </FloatButton>
        <FloatButton title="关闭" destructive onClick={() => void window.fizzWindow.close()}>
          <X className="size-3.5" />
        </FloatButton>
      </div>
    </header>
  )
}

function FloatButton({
  title,
  active,
  disabled,
  destructive,
  onClick,
  children
}: {
  title: string
  active?: boolean
  disabled?: boolean
  destructive?: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'flex size-7 items-center justify-center rounded transition-colors',
        destructive
          ? 'text-muted-foreground hover:bg-destructive hover:text-white'
          : active
            ? 'bg-secondary text-foreground'
            : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
        disabled && 'pointer-events-none opacity-40'
      )}
    >
      {children}
    </button>
  )
}

/** 内容区：loading / empty / missing 提示，其余交给 ChatPanel（会话态或草稿态） */
function FloatContent({
  kind,
  app,
  selection,
  onSelectConversation
}: {
  kind: FloatContentKind
  app: AgentApp
  selection: FloatSelection
  onSelectConversation: (id: string, ws: string) => void
}) {
  if (kind === 'loading') return <FloatNotice>正在加载…</FloatNotice>
  if (kind === 'empty') return <FloatNotice>还没有项目</FloatNotice>
  if (kind === 'missing')
    return <FloatNotice>这个会话已不存在（可能已被删除）。</FloatNotice>
  // kind === 'draft' | 'conversation'
  // ⚠️ 必须给 `ChatPanel` 一个**弹性列**父容器：`ChatSurface` / `MessageList` 的根都是
  // `flex min-h-0 flex-1 flex-col`，靠父级 flex 分配高度。若父级是普通 block（只写
  // `flex-1` 而不带 `flex`），`flex-1` 不生效 → 面板按内容撑高、输入框被顶到视口外、
  // 消息区没有受限高度可滚（用户实测）。与 `ConversationTab` 同一口径。
  const panelKey = selection.conversationId ?? draftPanelKey(selection.projectId)
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ChatPanel app={app} panelKey={panelKey} />
    </div>
  )
}

function FloatNotice({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
      {children}
    </div>
  )
}

/**
 * 左侧浮出的项目 / 会话列表（覆盖在内容区左边，点选即切内容并收起）。
 * 分组口径由 `floatProjectGroups` 决定（无 path 的虚拟项目不列；无工作区会话单独一组）。
 *
 * ## 版式对齐主侧栏（`AgentSidebar`），别在这里另起一套
 *
 * 浮窗是同一个应用的第二个窗口，用户对「项目 → 会话」这套树的印象来自主侧栏 ——
 * 两边长得不一样（这边原来是 12px 灰字、`bg-secondary` 方块、缩进靠 `pl-4` 硬推），
 * 一打开就显出「临时拼的」。所以行高 / 圆角 / 字号 / 选中态全部沿用主侧栏那一套：
 * - 行：`rounded-md px-1.5 py-1.5 text-sm`，行首一颗类型图标（`size-4`）；
 * - 选中：`bg-primary-subtle`；hover：`bg-primary-soft`（主题色深浅度，随强调色走，
 *   不用中性 `secondary` —— 那在暗色下几乎看不出选中）；
 * - 缩进：会话列表整体缩进一层（`pl-3`），行内不再写 `pl-*`，标题与项目名错开一格
 *   显出从属关系（主侧栏那条注释讲的就是这件事）。
 *
 * ## 折叠
 *
 * 每个项目可折叠（含「临时会话」合成组）。状态只放组件里 —— 面板关掉再开还是原样
 * （`if (!open) return null` 不会卸载组件本身），换窗口才重置。
 * 记录的是**已折叠**的 id 集合：新出现的工作区默认展开，符合「刚建的项目想直接看到会话」。
 * 箭头紧跟在项目名右边（与主窗口同款），行尾留给操作按钮。
 *
 * ## 会话行的行尾操作
 *
 * 归档 + 重命名，与主窗口会话行同一套：平时透明，hover 整行才浮现（绝对定位，不占标题宽度）；
 * 归档点两次就地确认，移开该行即反悔；重命名把标题就地换成输入框（Enter 提交 / Esc 取消）。
 * 归档后该会话由 `floatProjectGroups` 过滤掉，浮窗没有「已归档」分区可放。
 */
function FloatProjectList({
  open,
  groups,
  selection,
  projectId,
  onSelectConversation,
  onSelectProject,
  onClose
}: {
  open: boolean
  groups: ReadonlyArray<FloatProjectGroup>
  selection: FloatSelection
  projectId: string | null
  onSelectConversation: (id: string, ws: string) => void
  onSelectProject: (pid: string) => void
  onClose: () => void
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  /** 已折叠的项目 id（默认全展开，所以存「折叠了谁」而不是「展开了谁」） */
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())
  const toggleCollapsed = (id: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  /** 正在重命名的会话 id（null = 未在编辑）；输入框只在那一行替换标题，不弹窗 */
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameTitle, setRenameTitle] = useState('')
  /** 待确认归档的会话 id：第一次点 = 进入确认态，再点 = 真归档，鼠标移开该行 = 反悔 */
  const [confirmArchiveId, setConfirmArchiveId] = useState<string | null>(null)

  /**
   * 进场 / 退场两侧都要能播，所以**不卸载**（`open` 为假时靠 `visibility` + 位移藏起来）。
   *
   * 之前那版用 mounted + closing + rAF 双帧：一挂上就带进场类名。但 React 对
   * 「同一帧里新插入 + 类名已在终态」**不会**补播 transition —— 元素首帧就是最终样式，
   * 于是「出现」看着是硬切（用户反馈过）。这里改成 `entered`：先挂上、下一帧才加进场类名，
   * 保证有起始帧可对齐；关的时候直接摘掉 → transition 反向播，opacity 到 0 后由
   * `invisible` 收尾（`visibility` 不参与 transition 的插值，到点才切，不会闪）。
   */
  const [entered, setEntered] = useState(false)
  const rafRef = useRef<number | null>(null)
  useEffect(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
    if (!open) {
      // 关：立即摘掉进场类名（transition 反向播），但组件留着
      setEntered(false)
      return
    }
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null
      setEntered(true)
    })
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
    }
  }, [open])

  /** 进场态：位移归零 + 不透明 + 可见；其余都是退场 / 初始态 */
  const shown = open && entered
  return (
    <>
      {/*
        点内容区空白 = 收起（抽屉的常规预期；原来只有 Esc 与那颗 ×）。
        只铺**内容区**（`inset-0`，父级是内容容器），不盖标题栏 —— 否则想点标题栏那颗
        「会话列表」按钮切换时，第一下会先被这层吃掉，看着像点了没反应。
        `tabIndex={-1}`：它是块「点外面」，不该进 Tab 序列。
        退场时只淡出、且 `pointer-events-none`：这一下已经点过了，别再挡后续点击。
      */}
      <button
        type="button"
        tabIndex={-1}
        aria-label="关闭项目列表"
        onClick={onClose}
        className={cn(
          'absolute inset-0 z-[9] cursor-default bg-black/[0.03] transition-opacity duration-200 ease-out',
          shown ? 'visible opacity-100' : 'pointer-events-none invisible opacity-0'
        )}
      />
      {/*
        面板本体：从左边沿滑入 + 淡入，退场反向。`will-change-transform` 让这 16px 位移
        全程走合成层，不牵动内容区重排（浮窗一直开着，抖一下很显眼）。
        藏起来用 `invisible` 而不是卸载：展开 / 折叠 / 滚动位置 / 重命名中的输入框都留着
        （关面板不再打断用户手头的事），退场期间也不清任何 state。
      */}
      <div
        aria-hidden={!shown}
        className={cn(
          'absolute inset-y-0 left-0 z-10 flex w-64 flex-col overflow-hidden rounded-r-lg border-r bg-surface-1 shadow-xl backdrop-blur-xl transition-[transform,opacity] duration-200 ease-out will-change-transform',
          shown ? 'visible translate-x-0 opacity-100' : 'invisible -translate-x-3 opacity-0'
        )}>
        {/* 头部：标题 + 分组数（数量让人一眼知道下面有多少项目，窄面板尤其有用） */}
        <div className="flex h-9 shrink-0 items-center gap-2 pl-3 pr-1">
          <span className="text-xs font-medium text-muted-foreground">项目</span>
          <span className="text-[11px] tabular-nums text-muted-foreground/70">
            {groups.length}
          </span>
          <div className="min-w-0 flex-1" />
          <FloatButton title="收起" onClick={onClose}>
            <X className="size-3.5" />
          </FloatButton>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2 no-scrollbar">
          <div className="flex flex-col gap-1">
            {groups.length === 0 && (
              <div className="px-1.5 py-6 text-center text-xs leading-5 text-muted-foreground">
                还没有项目
              </div>
            )}
            {groups.map((g) => {
              const expanded = !collapsed.has(g.id)
              const count = g.conversations.length
              return (
                <div key={g.id} className="flex flex-col gap-0.5">
                  <div
                    className={cn(
                      'flex items-center rounded-md pr-1 transition-colors',
                      g.synthetic
                        ? 'text-muted-foreground'
                        : g.id === projectId
                          ? 'bg-primary-subtle text-foreground'
                          : 'text-foreground hover:bg-primary-soft'
                    )}
                  >
                    <div className="flex min-w-0 flex-1 items-center gap-1.5 py-1.5 pl-1.5">
                      {g.synthetic ? (
                        <MessageSquare className="size-4 shrink-0" />
                      ) : (
                        <Folder
                          className={cn(
                            'size-4 shrink-0',
                            g.id === projectId ? 'text-primary' : 'text-muted-foreground'
                          )}
                        />
                      )}
                      {g.synthetic ? (
                        // 合成组（「临时会话」）= 一堆互不相关的工作区合集，没有「这个项目的草稿页」
                        // 可进 —— 点了只能选一个不存在的项目 id。当标题用，不可点。
                        <span className="min-w-0 truncate text-sm">{g.name}</span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => onSelectProject(g.id)}
                          className="min-w-0 truncate text-left text-sm"
                          title={g.name}
                        >
                          {g.name}
                        </button>
                      )}
                      {/*
                        箭头**跟着名字走**（与主窗口同款），不占行尾 —— 行尾留给操作按钮。
                        独立的一颗按钮：点它只折叠 / 展开，点名字才是「进这个项目」；
                        不能用 `<button>` 套 `<button>`（HTML 不允许），所以这一层是 div。
                      */}
                      <button
                        type="button"
                        onClick={() => toggleCollapsed(g.id)}
                        aria-expanded={expanded}
                        aria-label={expanded ? `收起 ${g.name}` : `展开 ${g.name}`}
                        className="shrink-0 rounded hover:bg-foreground/10"
                      >
                        <ChevronRight
                          className={cn(
                            'size-4 transition-transform duration-200',
                            expanded && 'rotate-90'
                          )}
                        />
                      </button>
                    </div>
                  </div>
                  {/* 会话列表缩进一层（与主侧栏同款），标题与项目名错开一格显出从属关系 */}
                  {expanded && (
                    <div className="flex flex-col gap-0.5 pl-3">
                      {count === 0 ? (
                        <span className="px-1.5 py-1 text-xs leading-5 text-muted-foreground/70">
                          还没有会话
                        </span>
                      ) : (
                        g.conversations.map((c) => {
                          const renaming = renamingId === c.id
                          const confirmingArchive = confirmArchiveId === c.id
                          return (
                            <div
                              key={c.id}
                              // 移开该行 = 反悔（与主窗口会话行同一套交互）
                              onMouseLeave={() => {
                                if (confirmingArchive) setConfirmArchiveId(null)
                              }}
                              className={cn(
                                'group relative flex items-center rounded-md transition-colors',
                                c.id === selection.conversationId
                                  ? 'bg-primary-subtle text-foreground'
                                  : 'text-foreground hover:bg-primary-soft'
                              )}
                            >
                              {renaming ? (
                                <>
                                  <MessageSquare className="ml-1.5 size-4 shrink-0 text-muted-foreground" />
                                  <input
                                    autoFocus
                                    value={renameTitle}
                                    onChange={(e) => setRenameTitle(e.target.value)}
                                    onKeyDown={(e) => {
                                      if (e.key === 'Enter') {
                                        void useAgentStore
                                          .getState()
                                          .renameConversation(c.id, renameTitle)
                                        setRenamingId(null)
                                      } else if (e.key === 'Escape') {
                                        setRenamingId(null)
                                      }
                                    }}
                                    onBlur={() => setRenamingId(null)}
                                    className="h-7 min-w-0 flex-1 bg-transparent px-1 text-sm outline-none"
                                  />
                                </>
                              ) : (
                                <button
                                  type="button"
                                  onClick={() => onSelectConversation(c.id, g.id)}
                                  // hover 时右侧让出两颗按钮的宽度，标题不至于被压住
                                  className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md py-1.5 pl-1.5 pr-1 text-left text-sm transition-[padding] group-hover:pr-14 max-md:pr-14"
                                  title={c.title}
                                >
                                  <MessageSquare className="size-4 shrink-0 text-muted-foreground" />
                                  <span className="min-w-0 flex-1 truncate">{c.title}</span>
                                </button>
                              )}
                              {/*
                                行尾两颗按钮：**绝对定位**浮在右侧，平时透明、hover 整行才浮现 ——
                                留在 flex 流里即使 `opacity-0` 也照样占宽度，窄面板会把标题截短。
                                重命名中不渲染：输入框要那整行宽度。
                                归档走「点两次就地确认」（第一次变勾），移开该行即反悔。
                              */}
                              {!renaming && (
                                <div className="absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100 max-md:opacity-100">
                                  <button
                                    type="button"
                                    aria-label={confirmingArchive ? '确认归档' : '归档会话'}
                                    title={confirmingArchive ? '再点一次归档' : '归档'}
                                    onClick={() => {
                                      if (!confirmingArchive) {
                                        setConfirmArchiveId(c.id)
                                        return
                                      }
                                      setConfirmArchiveId(null)
                                      void useAgentStore
                                        .getState()
                                        .archiveConversation(c.id, true)
                                      // 正在看这条 → 别把内容区留在一条已归档的会话上
                                      if (c.id === selection.conversationId) {
                                        if (g.synthetic) onClose()
                                        else onSelectProject(g.id)
                                      }
                                    }}
                                    className={cn(
                                      'flex size-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground',
                                      confirmingArchive &&
                                        'bg-amber-500/10 text-amber-500 hover:bg-amber-500/20'
                                    )}
                                  >
                                    {confirmingArchive ? (
                                      <Check className="size-3.5" />
                                    ) : (
                                      <Archive className="size-3.5" />
                                    )}
                                  </button>
                                  <button
                                    type="button"
                                    aria-label="重命名会话"
                                    title="重命名"
                                    onClick={() => {
                                      setConfirmArchiveId(null)
                                      setRenamingId(c.id)
                                      setRenameTitle(c.title)
                                    }}
                                    className="flex size-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
                                  >
                                    <Pencil className="size-3.5" />
                                  </button>
                                </div>
                              )}
                            </div>
                          )
                        })
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </>
  )
}
