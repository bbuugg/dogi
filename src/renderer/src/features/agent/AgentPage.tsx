import { AgentFilesPanel } from '@/features/agent/AgentFilesPanel'
import { AiMarkdown } from '@/features/agent/AiMarkdown'
import { AskFollowupCard } from '@/features/agent/AskFollowupCard'
import { MessageCopyButton } from '@/features/agent/MessageCopyButton'
import { MessageOutline } from '@/features/agent/MessageOutline'
import { MessageDeleteButton } from '@/features/agent/MessageDeleteButton'
import { MessageEditButton } from '@/features/agent/MessageEditButton'
import { ReasoningPanel } from '@/features/agent/ReasoningPanel'
import { TOOL_LABELS, ToolCallRow, toolRunStatus } from '@/features/agent/ToolCallRow'
import { TypingDots } from '@/features/agent/TypingDots'
import { WorkspaceQuickActions } from '@/features/agent/WorkspaceQuickActions'
import { useMessageListScroll } from '@/features/agent/useMessageListScroll'
import { TerminalView } from '@/features/terminal/TerminalView'
import { ResizeHandle } from '@/shared/components/ResizeHandle'
import { useAppStore } from '@/stores/app-store'
import { ASK_FOLLOWUP_TOOL } from '@shared/ask-followup'
import type {
  AgentChatMessage,
  AgentConfirmRequest,
  AgentMessagePart,
  AiPermissionMode,
  IdeInfo,
  OpenResult,
  SessionInfo,
  ShellProfile
} from '@shared/types'
import type { MenuProps } from 'antd'
import { Button, Dropdown, Input, Select, Tooltip, message } from 'antd'
import { cn } from 'cn'
import {
  ArrowDown,
  Ban,
  Bot,
  Check,
  ChevronDown,
  ChevronUp,
  Code2,
  ExternalLink,
  Files,
  FolderOpen,
  Pencil,
  Send,
  Settings,
  ShieldCheck,
  Square,
  Terminal,
  X
} from 'lucide-react'
import {
  type ComponentRef,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState
} from 'react'

/** 模型下拉里 ACP 后端的特殊选项值 */
const ACP_OPTION = '__acp__'
const ACP_MANAGE_OPTION = '__acp-manage__'

/** 命令执行权限模式（与终端 AI 助手同一份配置 aiSettings.permissionMode） */
const AGENT_PERMISSION_MODES: Array<{
  value: AiPermissionMode
  label: string
  icon: typeof ShieldCheck
  hint: string
}> = [
    {
      value: 'full',
      label: '自动执行',
      icon: Terminal,
      hint: '无需确认'
    },
    {
      value: 'confirm',
      label: '变更前确认',
      icon: ShieldCheck,
      hint: '改之前问我'
    }
  ]

type ToolCallPart = Extract<AgentMessagePart, { type: 'tool-call' }>
type ToolResultPart = Extract<AgentMessagePart, { type: 'tool-result' }>

/** 工具渲染单元：一次调用及其结果合为一处展示 */
interface ToolUnit {
  kind: 'tool'
  call: ToolCallPart
  result?: ToolResultPart
}

type RenderUnit =
  | ToolUnit
  | { kind: 'text'; text: string }
  | { kind: 'reasoning'; text: string }

/** 把消息 parts 整理为渲染单元：文本独立成块；reasoning 连续合并为一块；tool-call 与对应 tool-result 按 toolCallId 合并 */
function buildRenderUnits(parts: AgentMessagePart[]): RenderUnit[] {
  const units: RenderUnit[] = []
  const toolsById = new Map<string, ToolUnit>()
  for (const part of parts) {
    if (part.type === 'text') {
      units.push({ kind: 'text', text: part.text })
    } else if (part.type === 'reasoning') {
      const last = units[units.length - 1]
      if (last?.kind === 'reasoning') {
        last.text += part.text
      } else {
        units.push({ kind: 'reasoning', text: part.text })
      }
    } else if (part.type === 'tool-call') {
      const unit: ToolUnit = { kind: 'tool', call: part }
      toolsById.set(part.toolCallId, unit)
      units.push(unit)
    } else if (part.type === 'tool-result') {
      const unit = toolsById.get(part.toolCallId)
      if (unit) {
        unit.result = part
      } else {
        // 无对应调用的孤儿结果：兜底成完整工具单元，保证结果不丢
        units.push({
          kind: 'tool',
          call: {
            type: 'tool-call',
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            input: null
          },
          result: part
        })
      }
    }
  }
  return units
}

/**
 * 待批准的确认区（插在工具横条的展开体里）。
 *
 * 只在「需确认」模式下出现：Agent 执行命令 / 删除文件等危险操作前先请示，
 * 用户点了允许才真正执行。文案里带上工作区名，避免误批到别的目录。
 */
function AgentConfirmActions({ confirm }: { confirm: AgentConfirmRequest }) {
  const resolveAgentConfirm = useAppStore((s) => s.resolveAgentConfirm)
  return (
    <div className="flex flex-wrap items-center gap-2 pt-0.5">
      <span className="text-xs text-muted-foreground">
        是否允许在工作区「{confirm.workspaceName}」
        {TOOL_LABELS[confirm.toolName] ?? '执行该操作'}？
      </span>
      <div className="ml-auto flex gap-1.5">
        <Button
          type="text"
          size="small"
          danger
          icon={<Ban className="size-3.5" />}
          onClick={() => void resolveAgentConfirm(confirm.id, false)}
        >
          拒绝
        </Button>
        <Button
          type="primary"
          size="small"
          icon={<Check className="size-3.5" />}
          onClick={() => void resolveAgentConfirm(confirm.id, true)}
        >
          允许
        </Button>
      </div>
    </div>
  )
}

/** 取消息里的文本段拼成字符串（sep 用于把多段隔开：用户原文不留空行，Markdown 留空行） */
function textOf(parts: AgentChatMessage['parts'], sep: string): string {
  return parts
    .filter((p) => p.type === 'text')
    .map((p) => (p.type === 'text' ? p.text : ''))
    .join(sep)
}

/**
 * 单条消息：用户气泡 / 助手（Markdown + 工具横条），两者都可选中、都可一键复制。
 * 消息下方（hover 才露出）带「复制 / 编辑（仅用户消息）/ 删除」。
 */
function MessageBubble({
  conversationId,
  message,
  streaming,
  canEdit,
  editing,
  onEdit,
  canDelete,
  tailCount,
  pendingConfirm
}: {
  /** 本消息所属会话：删除要显式指定会话，不能靠 store 的「当前选中」兜底 */
  conversationId: string | null
  message: AgentChatMessage
  streaming?: boolean
  /** 整轮对话是否已结束（生成中不允许改，否则会把正在流式的消息一起截掉） */
  canEdit: boolean
  /** 这条正在被编辑（内容已灌进底部输入框） */
  editing: boolean
  onEdit: (message: AgentChatMessage) => void
  canDelete: boolean
  /** 含本条在内、会被一起删掉的消息条数 */
  tailCount: number
  pendingConfirm: AgentConfirmRequest | null
}) {
  const deleteAgentMessagesFrom = useAppStore((s) => s.deleteAgentMessagesFrom)
  const del =
    canDelete && conversationId ? (
      <MessageDeleteButton
        count={tailCount}
        onConfirm={() => void deleteAgentMessagesFrom(message.id, conversationId)}
      />
    ) : null

  if (message.role === 'user') {
    const text = textOf(message.parts, '')
    return (
      <div data-message-id={message.id} className="group/msg flex flex-col items-end gap-1">
        {/* 选中态用半透明白：主色底 + 白字下，浏览器的默认蓝色选区会把字压得看不清 */}
        <div
          className={cn(
            'max-w-[85%] selection:bg-white/25 whitespace-pre-wrap rounded-lg rounded-br-sm bg-primary px-3 py-2 text-[15px] text-white',
            // 正在编辑：压暗 + 描边，一眼能看出「改的是这条」，和参考实现一个路子
            editing && 'opacity-50 ring-2 ring-border ring-offset-2 ring-offset-background'
          )}
        >
          {text}
        </div>
        {/* invisible 而不是不渲染：保留占位，hover 时不会把消息挤动 */}
        <div className="invisible flex items-center gap-1 group-hover/msg:visible">
          <MessageCopyButton text={text} />
          {canEdit && <MessageEditButton onEdit={() => onEdit(message)} />}
          {del}
        </div>
      </div>
    )
  }

  const units = buildRenderUnits(message.parts)
  // 复制的是 Markdown 源码而不是渲染后的文本：代码块、链接等结构才能保留
  const rawText = textOf(message.parts, '\n\n').trim()
  const last = units[units.length - 1]
  // 空档期（还没吐出任何内容，或最后一步是已完成的工具、正文尚未开始）显示三点，
  // 否则「点了发送却什么都没有」的那几秒看起来像卡住了
  const showDots = !!streaming && (units.length === 0 || (last?.kind === 'tool' && !!last.result))

  return (
    <div data-message-id={message.id} className="group/msg space-y-3">
      {units.map((unit, i) =>
        unit.kind === 'text' ? (
          <div key={i}>
            <AiMarkdown content={unit.text} />
            {streaming && i === units.length - 1 && (
              <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse bg-primary align-middle" />
            )}
          </div>
        ) : unit.kind === 'reasoning' ? (
          <ReasoningPanel
            key={i}
            text={unit.text}
            streaming={!!streaming && i === units.length - 1}
          />
        ) : unit.call.toolName === ASK_FOLLOWUP_TOOL ? (
          // 提问工具：待回答时是一张可交互的卡片，答完收成一条横条
          <AskFollowupCard
            key={i}
            toolCallId={unit.call.toolCallId}
            input={unit.call.input}
            output={unit.result?.output}
            isError={unit.result?.isError}
            streaming={streaming}
          />
        ) : (
          <ToolCallRow
            key={i}
            toolName={unit.call.toolName}
            input={unit.call.input}
            output={unit.result?.output}
            isError={unit.result?.isError}
            status={toolRunStatus({
              confirming: pendingConfirm?.toolCallId === unit.call.toolCallId,
              hasResult: !!unit.result,
              isError: unit.result?.isError,
              streaming
            })}
            confirm={
              pendingConfirm?.toolCallId === unit.call.toolCallId ? (
                <AgentConfirmActions confirm={pendingConfirm} />
              ) : undefined
            }
          />
        )
      )}
      {showDots && <TypingDots />}
      {/* 生成中就露出复制按钮没有意义（内容还在变），一轮结束再显示；
          invisible 而不是不渲染：保留占位，hover 时不会把消息挤动 */}
      <div className="invisible flex items-center gap-1 group-hover/msg:visible">
        {!streaming && <MessageCopyButton text={rawText} title="复制原文（Markdown）" />}
        {del}
      </div>
    </div>
  )
}

/** 稳定的空消息数组：避免每次渲染新引用导致滚动 effect 误触发 */
const NO_MESSAGES: AgentChatMessage[] = []

/** 文件视图抽屉：滑入/滑出时长（ms），需与 className 里的 duration-200 一致 */
const DRAWER_ANIM_MS = 200
/** 文件视图抽屉：最小 / 默认宽度（px） */
const FILES_DRAWER_MIN_WIDTH = 360
const FILES_DRAWER_DEFAULT_WIDTH = 720
/** 文件视图抽屉：展开时给左侧对话预留的宽度（px）—— 免得一拖就变成铺满整屏 */
const FILES_DRAWER_GUTTER = 320

/**
 * 文件视图抽屉：最大宽度（px）。
 *
 * 正常情况下给左侧对话留 `FILES_DRAWER_GUTTER`，别一拖就铺满整屏。
 * 但分屏之后单块内容区可能只有几百像素，「留 320px」根本留不出来 ——
 * 算出来比最小宽度还小，硬留只会让抽屉顶出内容区左缘被裁掉（左缘的拖拽条一并消失，
 * 再也拖不回来）。所以容器过窄时直接允许抽屉铺满整块内容区。
 *
 * 宽度按内容区实测宽度算（抽屉嵌在内容区里，用窗口宽度会偏大导致被裁）。
 */
function filesDrawerMaxWidth(containerWidth?: number): number {
  const available = containerWidth && containerWidth > 0 ? containerWidth : window.innerWidth
  const withGutter = available - FILES_DRAWER_GUTTER
  return withGutter >= FILES_DRAWER_MIN_WIDTH ? withGutter : available
}

/**
 * 右侧抽屉（antd Drawer 的观感）：从右边缘滑出，宽度可拖拽，**不是全屏**。
 *
 * 两个动画上的细节：
 * - 关闭后延迟卸载，让滑出动画播完再摘掉 DOM；
 * - 打开时先以屏幕外状态挂载、两帧后再位移到 0 —— 挂载即到位的话浏览器不会为
 *   「初始状态」补过渡，首次展开就没动画（所以不能把 mounted/shown 一次设完）。
 */
function RightDrawer({
  open,
  width,
  minWidth,
  maxWidth,
  onResize,
  onClose,
  children
}: {
  open: boolean
  width: number
  minWidth: number
  maxWidth: number
  onResize: (width: number) => void
  /** 点击抽屉外部时关闭（外部点击会穿透到下面的对话区，只能在事件里判定） */
  onClose: () => void
  children: ReactNode
}) {
  const [mounted, setMounted] = useState(open)
  /** 是否已位移到最终位置（false = 停在屏幕外） */
  const [shown, setShown] = useState(false)
  /** 抽屉本体（含左缘拖拽条）：用来判定「点击落在抽屉内还是外」 */
  const bodyRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) {
      setShown(false)
      const timer = window.setTimeout(() => setMounted(false), DRAWER_ANIM_MS)
      return () => window.clearTimeout(timer)
    }
    setMounted(true)
    let inner = 0
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => setShown(true))
    })
    return () => {
      cancelAnimationFrame(outer)
      cancelAnimationFrame(inner)
    }
  }, [open])

  /**
   * 展开期间点击抽屉外部就关闭（不是全屏遮罩式抽屉，点外面本来就该退出）。
   * 监听挂在 document 的捕获阶段：抽屉外层是 pointer-events-none，外部点击会直接
   * 落到下面的对话区，只能在全局事件里按「目标是否在抽屉内」判定。
   */
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      const target = e.target as HTMLElement | null
      if (!target) return
      // 抽屉内（含左缘拖拽条）不关
      if (bodyRef.current?.contains(target)) return
      // 顶栏的开关按钮自己会切换开关，交给它处理（否则这里先关、按钮再切成开）
      if (target.closest?.('[data-outside-ignore]')) return
      // 抽屉里弹出的下拉 / 浮层 portal 挂在 body 上，按组件树判不出来，按容器类名兜住
      if (
        target.closest?.(
          '.ant-dropdown, .ant-select-dropdown, .ant-popover, .ant-tooltip, .ant-modal-wrap, .ant-image-preview-wrap'
        )
      ) {
        return
      }
      onClose()
    }
    document.addEventListener('mousedown', onDown, true)
    return () => document.removeEventListener('mousedown', onDown, true)
  }, [open, onClose])

  if (!mounted) return null

  return (
    // 外层只负责裁剪与不挡点击（关闭态整个抽屉在容器右边缘之外）
    <div className="pointer-events-none absolute inset-0 z-20 overflow-hidden">
      <div
        ref={bodyRef}
        style={{ transform: shown ? 'translateX(0)' : 'translateX(100%)' }}
        className="pointer-events-auto absolute inset-y-0 right-0 flex transition-transform duration-200 ease-out"
      >
        {/* 抽屉左缘的拖拽条：面板在其右侧，所以 invert（向左拖才是变宽） */}
        <ResizeHandle invert width={width} min={minWidth} max={maxWidth} onResize={onResize} />
        <div
          style={{ width }}
          // 供回归脚本量「抽屉有没有超出内容区」（见 scripts/verify-agent-tabs.mjs）
          data-agent-files-drawer
          className="flex min-h-0 flex-col border-l border-border/70 bg-background shadow-2xl"
        >
          {children}
        </div>
      </div>
    </div>
  )
}

/** Agent 工作区内嵌终端：标题栏（路径 + 折叠/关闭），主体复用 TerminalView，高度可拖拽调整 */
function EmbeddedTerminal({
  session,
  path,
  onClose
}: {
  session: SessionInfo
  path: string
  onClose: () => void
}) {
  const [collapsed, setCollapsed] = useState(false)
  const [height, setHeight] = useState(200)

  // 拖拽标题栏上方的分隔条调整终端高度（TerminalView 的 ResizeObserver 会自动重新 fit）；
  // 终端位于页面底部，向上拖 = 面板变高，所以高度增量取 deltaY 的相反数。
  // 收起态不渲染这个条（见下面 JSX），这里再兜一层：折叠后不再支持调整高度
  const startDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (collapsed) return
    e.preventDefault()
    const startY = e.clientY
    const startHeight = height
    const move = (ev: PointerEvent) => {
      const next = startHeight - (ev.clientY - startY)
      setHeight(Math.max(96, Math.min(480, next)))
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    document.body.style.cursor = 'row-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  return (
    <div className="shrink-0 border-t border-border/70 bg-background">
      {/* 高度拖拽条：位于终端标题栏（横条）上方。
          收起后终端主体不可见，高度调整没有意义 —— 整条不再渲染，也就不能拖动 */}
      {!collapsed && (
        <div
          onPointerDown={startDrag}
          title="拖动调整高度"
          className="group/resize relative z-10 -my-1 h-2 shrink-0 cursor-row-resize"
        >
          <div className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-border transition-colors group-hover/resize:bg-primary" />
        </div>
      )}
      <div className="flex h-8 shrink-0 items-center gap-1.5 px-3">
        <Terminal className="size-3.5 shrink-0 text-muted-foreground" />
        <span
          className="min-w-0 truncate font-mono text-xs text-muted-foreground"
          title={path}
        >
          终端 · {path}
        </span>
        <div className="ml-auto flex items-center gap-0.5">
          <Tooltip title={collapsed ? '展开终端' : '收起终端'}>
            <Button
              type="text"
              size="small"
              className="px-1.5 text-muted-foreground"
              icon={collapsed ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
              onClick={() => setCollapsed((v) => !v)}
            />
          </Tooltip>
          <Tooltip title="关闭终端">
            <Button
              type="text"
              size="small"
              className="px-1.5 text-muted-foreground"
              icon={<X className="size-3.5" />}
              onClick={onClose}
            />
          </Tooltip>
        </div>
      </div>
      {/* 折叠用 hidden 而非卸载：xterm 重建会丢会话输出（terminal:data 无回放） */}
      <div
        className={cn('px-2 pb-2', collapsed && 'hidden')}
        style={collapsed ? undefined : { height }}
      >
        <TerminalView session={session} isActive />
      </div>
    </div>
  )
}

/**
 * Agent 会话的界面：类 Claude Code 的工作区编程助手。
 * 上方是对话流（文本 + 工具卡），底部大输入框，Enter 发送 / Shift+Enter 换行。
 * 对话绑定会话所属的工作区，工具（读写文件 / 搜索 / 执行命令）只能作用于该目录。
 *
 * **只认 `conversationId` 这一个入参**，不读 store 里的「当前选中」指针 ——
 * 那是侧边栏的选中态，多标签并存时它只能指向其中一个。因此它可以同时挂在多处
 * （PanelView 里一个会话一个标签、甚至分屏并排）而互不串台。
 * 「标签什么时候出现在 PanelView 里」由侧边栏点击（`selectAgentConversation`）决定，
 * 这里只负责「给定一个会话，把它画出来」。
 */
export function AgentPage({ conversationId }: { conversationId: string | null }) {
  const workspaces = useAppStore((s) => s.agentWorkspaces)
  // 消息来自本会话（唯一真源），流式/错误等运行时状态另存 agentRuns
  const conversation = useAppStore((s) =>
    conversationId ? s.agentConversations.find((c) => c.id === conversationId) : undefined
  )
  const run = useAppStore((s) => (conversationId ? s.agentRuns[conversationId] : undefined))
  /**
   * 工作区由会话自身推导，而不是读 store 的「当前选中工作区」：
   * 会话归属哪个目录，工具就只作用在哪个目录；多标签并存时也不会跟着侧边栏漂移。
   */
  const activeId = conversation?.workspaceId ?? null
  const active = activeId ? workspaces.find((w) => w.id === activeId) : undefined
  const aiSettings = useAppStore((s) => s.aiSettings)
  const aiConfigs = useAppStore((s) => s.aiConfigs)
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen)
  const acpAgents = aiSettings.acpAgents ?? []
  const setAgentConversationModel = useAppStore((s) => s.setAgentConversationModel)
  const setAiPermissionMode = useAppStore((s) => s.setAiPermissionMode)
  /** 设置里选的本地终端（'default' 表示平台默认） */
  const preferredShellId = useAppStore((s) => s.preferences.localShell)
  const permissionMode: AiPermissionMode =
    aiSettings.permissionMode === 'confirm' ? 'confirm' : 'full'
  const permissionMeta =
    AGENT_PERMISSION_MODES.find((m) => m.value === permissionMode) ?? AGENT_PERMISSION_MODES[0]
  const PermissionIcon = permissionMeta.icon
  const messages = conversation?.messages ?? NO_MESSAGES
  const streaming = run?.streaming ?? false
  const error = run?.error ?? null

  // ---------- 后端与模型：**按会话独立** ----------
  // 会话自己在下拉里选过的值优先；没选过才回退到工作区设置 / 设置页的默认模型。
  // 这样在 A 会话切模型不会波及 B 会话。
  const ownChoice = conversation?.configId
  const backend = conversation?.backend ?? active?.backend ?? 'ai-sdk'
  // ACP 后端无需模型配置（agent 自带模型），只需有可用的预置配置
  const activeAcp =
    (backend === 'acp' ? acpAgents.find((a) => a.id === ownChoice) : undefined) ??
    acpAgents.find((a) => a.id === aiSettings.activeAcpId) ??
    acpAgents[0]
  /** 本会话实际使用的模型配置：会话自己的选择优先，回退到设置里的默认模型 */
  const effectiveConfigId =
    backend !== 'acp' && ownChoice && aiConfigs.some((c) => c.id === ownChoice)
      ? ownChoice
      : aiConfigs.some((c) => c.id === aiSettings.activeConfigId)
        ? aiSettings.activeConfigId
        : undefined
  const hasConfig = backend === 'acp' ? Boolean(activeAcp) : Boolean(effectiveConfigId)

  const pendingConfirm = useAppStore((s) => {
    if (!activeId) return null
    for (const c of Object.values(s.agentPendingConfirms)) {
      if (c.workspaceId === undefined || c.workspaceId === activeId) return c
    }
    return null
  })
  const sendAgentMessage = useAppStore((s) => s.sendAgentMessage)
  const resendAgentMessage = useAppStore((s) => s.resendAgentMessage)
  const abortAgent = useAppStore((s) => s.abortAgent)
  const setSidebarCollapsed = useAppStore((s) => s.setSidebarCollapsed)

  const [input, setInput] = useState('')
  /** 正在编辑的用户消息（内容已灌进输入框；发送时先删这条及其之后，再重发） */
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null)
  const textareaRef = useRef<ComponentRef<typeof Input.TextArea> | null>(null)
  // 滚动定位（尾部跟随 / 滚动到底部按钮）与终端 AI 助手共用
  const { scrollRef, onScroll, showJump, jumpToBottom } = useMessageListScroll({
    conversationId,
    messages,
    streaming
  })

  /** 消息目录点击：把那条消息滚到可视区顶部（消息上的 `scroll-mt` 由 CSS 留上边距） */
  const jumpToMessage = (messageId: string): void => {
    const node = scrollRef.current?.querySelector(
      `[data-message-id="${CSS.escape(messageId)}"]`
    )
    node?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  // 文件视图抽屉的开关与宽度（页面本地状态；标签保持挂载，切走再回来不重置）
  const [filesOpen, setFilesOpen] = useState(false)
  /** 用户拖到的宽度 —— **不是**最终渲染宽度，最终还要按内容区上限收敛（见 filesRenderWidth） */
  const [filesWidth, setFilesWidth] = useState(() =>
    Math.min(FILES_DRAWER_DEFAULT_WIDTH, filesDrawerMaxWidth())
  )
  /** 关闭文件视图：面板内的关闭按钮与「点击抽屉外部」共用（useCallback 保证
      抽屉里的全局监听不会因为内联函数每次渲染重新挂） */
  const closeFiles = useCallback(() => setFilesOpen(false), [])
  /** 抽屉所在的内容区：宽度上限按它的实测宽度算 */
  const contentRef = useRef<HTMLDivElement | null>(null)
  /**
   * 内容区实测宽度（0 = 还没量到，退回窗口宽度兜底）。
   *
   * 必须跟着尺寸变化走：分屏、拖侧边栏、切标签都会改变它，而抽屉宽度上限是按它算的 ——
   * 只在挂载时算一次的话，容器变窄后抽屉仍按老宽度渲染，就会顶出分屏之外被裁。
   */
  const [contentWidth, setContentWidth] = useState(0)
  useEffect(() => {
    const el = contentRef.current
    if (!el) return
    const sync = (): void => setContentWidth(el.clientWidth)
    sync()
    const ro = new ResizeObserver(sync)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  /** 抽屉宽度上限（内容区还没量到时按窗口宽度算） */
  const filesMaxWidth = filesDrawerMaxWidth(contentWidth)
  /**
   * 实际渲染宽度：容器变窄时把已有宽度一起收下来，别溢出到分屏之外。
   * 存的是「用户拖到过多少」（filesWidth），渲染时再按上限收敛 —— 容器重新变宽会自动还回去。
   */
  const filesRenderWidth = Math.min(filesWidth, filesMaxWidth)

  // 内嵌终端（在输入框下方）：绑定打开时的工作区目录，切换工作区不影响已开的终端
  // shellId 记下用的是哪个 shell，终端按钮的下拉据此标出当前项
  const [term, setTerm] = useState<{ session: SessionInfo; path: string; shellId?: string } | null>(
    null
  )
  const closeEmbeddedTerminal = useCallback(() => {
    setTerm((cur) => {
      if (cur) void window.api.terminal.kill(cur.session.id)
      return null
    })
  }, [])

  // 已探测到的 IDE 列表（打开下拉里展示；探测失败仅静默降级）
  const [ides, setIdes] = useState<IdeInfo[]>([])
  const [idesLoaded, setIdesLoaded] = useState(false)
  useEffect(() => {
    if (idesLoaded) return
    let alive = true
    void window.api.shell.listIdes().then((list) => {
      if (!alive) return
      setIdes(list)
      setIdesLoaded(true)
    })
    return () => {
      alive = false
    }
  }, [idesLoaded])

  // 可用终端列表（终端按钮的下拉里展示；另一种是没有下拉、点了直接开）
  const [shells, setShells] = useState<ShellProfile[]>([])
  /** 平台默认 shell 的 id（偏好是 'default' 时用它） */
  const [defaultShellId, setDefaultShellId] = useState('')
  const [shellsLoaded, setShellsLoaded] = useState(false)
  useEffect(() => {
    if (shellsLoaded) return
    let alive = true
    void window.api.terminal.listShells().then((res) => {
      if (!alive) return
      setShells(res.shells)
      setDefaultShellId(res.defaultId)
      setShellsLoaded(true)
    })
    return () => {
      alive = false
    }
  }, [shellsLoaded])

  const handleOpen = useCallback(
    async (action: () => Promise<OpenResult>, successText: string) => {
      const r = await action()
      if (r.ok) {
        message.success(successText)
      } else {
        message.error(r.error ?? '打开失败')
      }
    },
    []
  )

  /** 「打开」下拉菜单：文件管理器 / 已探测到的 IDE（终端是独立按钮，见顶栏） */
  const openMenuItems: MenuProps['items'] = [
    {
      key: 'file-manager',
      icon: <FolderOpen className="size-3.5" />,
      label: '打开文件管理器'
    },
    ...(ides.length > 0
      ? [
        { type: 'divider' as const },
        ...ides.map((ide) => ({
          key: `ide:${ide.id}`,
          icon: <Code2 className="size-3.5" />,
          label: `用 ${ide.name} 打开`
        }))
      ]
      : [])
  ]

  const handleOpenMenuClick: MenuProps['onClick'] = async ({ key, domEvent }) => {
    if (!active) return
    domEvent.stopPropagation()
    const dir = active.path
    if (key === 'file-manager') {
      await handleOpen(() => window.api.shell.openFileManager(dir), `已打开：${dir}`)
    } else if (key.startsWith('ide:')) {
      const ide = ides.find((i) => i.id === key.slice(4))
      if (!ide) return
      await handleOpen(() => window.api.shell.openIde(ide.id, dir), `已用 ${ide.name} 打开：${dir}`)
    }
  }

  /** 不带 shellId 打开时主进程实际会用的 shell（偏好多是 'default'，即平台默认）。
   *  只用来给下拉标出当前项 —— 启动参数仍然传 undefined，显式传 id 会盖掉设置里的偏好 */
  const effectiveShellId =
    !preferredShellId || preferredShellId === 'default' ? defaultShellId : preferredShellId

  /** 打开内嵌终端（在当前工作区目录启动）；已有终端就先换掉旧的。
   *  shellId 缺省 = 交给主进程按偏好/平台默认选。
   *  返回新会话（失败返回 null）—— 快捷功能的「执行命令」要拿到它才能写命令进去 */
  const openEmbeddedTerminal = useCallback(
    async (shellId?: string): Promise<SessionInfo | null> => {
      if (!active) return null
      const current = term
      if (current) void window.api.terminal.kill(current.session.id)
      try {
        const session = await window.api.terminal.createLocal(
          undefined,
          undefined,
          shellId,
          active.path
        )
        setTerm({ session, path: active.path, shellId: shellId ?? effectiveShellId })
        return session
      } catch (err) {
        // 旧会话已经杀掉了，别把 term 留在指向死会话的状态
        setTerm(null)
        message.error(err instanceof Error ? err.message : '终端打开失败')
        return null
      }
    },
    [active, term, effectiveShellId]
  )

  /**
   * 工作区快捷功能里的「执行命令」：复用当前工作区的内嵌终端（没开就现开一个），
   * 再用 runScript 写入 —— 它会等 shell 就绪，刚建好的会话也能立刻收到命令。
   */
  const runQuickCommand = useCallback(
    async (command: string) => {
      if (!active) throw new Error('没有选中的工作区')
      const existing = term && term.path === active.path ? term.session : null
      const session = existing ?? (await openEmbeddedTerminal())
      if (!session) throw new Error('终端打开失败')
      const ok = await window.api.terminal.runScript(session.id, `${command}\r`)
      if (!ok) throw new Error('命令写入失败，请检查终端是否已退出')
    },
    [active, term, openEmbeddedTerminal]
  )

  /** 终端按钮：在一个按钮上合并了「开/关」与「选 shell」——
   *  只有一种 shell（或还没探测完）时直接开/关，多选时点开菜单挑一个 */
  const handleTerminalClick = useCallback(() => {
    if (term) {
      closeEmbeddedTerminal()
      return
    }
    void openEmbeddedTerminal()
  }, [term, closeEmbeddedTerminal, openEmbeddedTerminal])

  /**
   * 快捷键「开关 AI Agent 终端」（默认 Ctrl/Cmd+Shift+`）的落地。
   *
   * 终端会话绑定「打开时的工作区目录」，作为页面内状态更合适，所以动作只在 store 里
   * 广播一次请求（`ui.agentTerminalToggle` 自增），真正的开/关在这里做。
   * 不传 shellId —— 用设置里配的默认终端（主进程按 preferences.localShell 选）。
   * ref 记住已处理到的值：挂载前攒下的旧请求不会在挂载时误触发一次。
   */
  const agentTerminalToggle = useAppStore((s) => s.ui.agentTerminalToggle)
  const handledToggleRef = useRef(agentTerminalToggle)
  useEffect(() => {
    if (agentTerminalToggle === handledToggleRef.current) return
    handledToggleRef.current = agentTerminalToggle
    handleTerminalClick()
  }, [agentTerminalToggle, handleTerminalClick])

  /** 终端按钮的下拉菜单：检出多个 shell 时才出现 */
  const shellMenuItems: MenuProps['items'] = shells.map((s) => ({
    key: s.id,
    icon: <Terminal className="size-3.5" />,
    label: s.name
  }))

  const handleShellSelect: MenuProps['onClick'] = ({ key, domEvent }) => {
    domEvent.stopPropagation()
    // 选中的就是当前在用的那个：不重启终端
    if (key === term?.shellId) return
    void openEmbeddedTerminal(key)
  }

  /** 模型下拉选中值：ACP 后端显示预置配置，内置后端显示本会话实际使用的模型配置 */
  /**
   * 模型下拉的选中值编码（解析见 handleModelSelect）：
   * - `cfg:<配置id>:<模型id>`：内置 AI SDK，配置下的具体模型
   * - `<配置id>`：内置 AI SDK，配置默认模型（兼容旧值）
   * - `acp:<agentid>:<模型value>`：ACP agent 的具体模型
   * - `acp:<agentid>`：ACP agent 默认模型
   */
  const modelSelectValue = (() => {
    if (backend === 'acp') {
      if (!activeAcp) return ACP_OPTION
      // 只有 modelId 仍在 agent 上报的模型列表里才用编码值；否则回退到 agent 默认
      //（Select 的 value 匹配不到任何选项时会原样显示 value 字符串——看起来就是一串 uuid）
      const mid = conversation?.modelId
      if (mid && activeAcp.models?.includes(mid)) return `acp:${activeAcp.id}:${mid}`
      return `acp:${activeAcp.id}`
    }
    if (!effectiveConfigId) return undefined
    const config = aiConfigs.find((c) => c.id === effectiveConfigId)
    if (!config) return undefined
    const models = config.models?.length ? config.models : [config.model]
    if (conversation?.modelId && models.includes(conversation.modelId)) {
      return `cfg:${config.id}:${conversation.modelId}`
    }
    return `cfg:${config.id}:${models[0]}`
  })()

  const handleModelSelect = (value?: string) => {
    if (!activeId || !conversationId || !value) return
    if (value === ACP_MANAGE_OPTION) {
      // 预置配置在设置页统一维护
      setSettingsOpen(true, 'ai')
      return
    }
    if (value === ACP_OPTION) {
      void setAgentConversationModel(conversationId, {
        backend: 'acp',
        configId: undefined,
        modelId: undefined
      })
      return
    }
    if (value.startsWith('acp:')) {
      const [, acpId, acpModel] = value.split(':')
      void setAgentConversationModel(conversationId, {
        backend: 'acp',
        configId: acpId,
        modelId: acpModel
      })
      return
    }
    if (value.startsWith('cfg:')) {
      const [, cfgId, cfgModel] = value.split(':')
      void setAgentConversationModel(conversationId, {
        backend: 'ai-sdk',
        configId: cfgId,
        modelId: cfgModel
      })
      return
    }
    // 旧格式兜底：纯配置 id
    void setAgentConversationModel(conversationId, {
      backend: 'ai-sdk',
      configId: value,
      modelId: undefined
    })
  }

  /**
   * 下拉选项：**只能有一层分组**。
   *
   * ⚠️ antd 6 的 Select（@rc-component/select）在 flattenOptions 里把「组的子项」一律当成
   * 可选 option（取 data.value），不再继续下钻 —— 写两层嵌套分组时，内层分组会变成一个
   * `value: undefined` 的选项：模型/agent 列表整个不渲染，点它也没有任何反应。
   * 所以「配置 / 模型 id」的从属关系用组内条目的 label 前缀表达，不再嵌套分组。
   */
  const acpIcon = <Bot className="size-3.5" />
  const modelOptions = [
    ...(aiConfigs.length > 0
      ? [
        {
          label: 'AI 模型',
          options: aiConfigs.flatMap((c) => {
            const models = c.models?.length ? c.models : [c.model]
            return models.map((m) => ({ value: `cfg:${c.id}:${m}`, label: `${c.name} · ${m}` }))
          })
        }
      ]
      : []),
    {
      label: 'Agent',
      options: [
        ...acpAgents.flatMap((a) => {
          const fallback = {
            value: `acp:${a.id}`,
            label: a.models?.length ? `${a.name}（默认）` : a.name,
            icon: acpIcon
          }
          // agent 默认模型选项必须常驻：会话未选具体模型时选中值是 `acp:<id>`
          return a.models?.length
            ? [
              fallback,
              ...a.models.map((m) => ({
                value: `acp:${a.id}:${m}`,
                label: `${a.name} · ${m}`,
                icon: acpIcon
              }))
            ]
            : [fallback]
        }),
        ...(activeAcp ? [] : [{ value: ACP_OPTION, label: '外部 ACP agent', icon: acpIcon }]),
        {
          value: ACP_MANAGE_OPTION,
          label: acpAgents.length ? '管理 ACP agent…' : '配置 ACP agent…',
          icon: <Settings className="size-3.5" />
        }
      ]
    }
  ]

  /** 点「编辑」：把这条的内容灌进输入框并进入编辑态（发送时走重发，先删这条及其之后） */
  const startEdit = useCallback((target: AgentChatMessage) => {
    setEditing({ id: target.id, text: textOf(target.parts, '') })
    setInput(textOf(target.parts, ''))
    // 受控输入框要等这一帧的值写进去再聚焦，否则光标会停在旧文本末尾
    requestAnimationFrame(() => textareaRef.current?.focus())
  }, [])

  const cancelEdit = useCallback(() => {
    setEditing(null)
    setInput('')
  }, [])

  const handleSend = () => {
    if (streaming || !input.trim() || !hasConfig || !conversationId) return
    const text = input
    setInput('')
    if (editing) {
      const id = editing.id
      setEditing(null)
      void resendAgentMessage(id, text, conversationId)
    } else {
      void sendAgentMessage(text, conversationId)
    }
  }

  // 换了工作区或会话后清空草稿与编辑态，避免把上一段的输入带进新对话
  // （滚动状态由 useMessageListScroll 按 conversationId 自行重置）
  useEffect(() => {
    setInput('')
    setEditing(null)
  }, [activeId, conversationId])

  return (
    <div className="flex h-full min-h-0 flex-col bg-background rounded-lg overflow-hidden">
      {/* 顶栏：当前工作区 + 操作 */}
      <div className="flex h-12 shrink-0 items-center gap-2 px-3">
        {active ? (
          <>
            {conversation && (
              <span
                className="ml-2 max-w-44 shrink-0 truncate text-base font-bold"
                title={conversation.title}
              >
                {conversation.title}
              </span>
            )}
            {/* 当前工作目录：分屏后同一屏可能并排好几个会话，光看标题分不清各自作用在哪个目录。
                长路径截断，完整路径走 title 悬浮提示 */}
            <span
              data-agent-cwd
              className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground"
              title={active.path}
            >
              {active.path}
            </span>
          </>
        ) : (
          <>
            <Bot className="size-4 shrink-0 text-muted-foreground" />
            <span className="text-sm text-muted-foreground">AI Agent</span>
          </>
        )}
        {/* 右侧操作区靠右（shrink-0：左侧那行路径再长也不许挤压按钮） */}
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          {active && (
            <>
              <Tooltip title={filesOpen ? '收起文件视图' : '展开文件视图'}>
                <Button
                  type="text"
                  // 抽屉按「点击外部」关闭，这个按钮自己会切换开关 ——
                  // 标记后抽屉不再抢先把它判成外部点击（否则会先关再开，点了没反应）
                  data-outside-ignore
                  className={cn('px-1.5', filesOpen ? 'text-primary' : 'text-muted-foreground')}
                  icon={<Files className="size-4" />}
                  onClick={() => setFilesOpen((v) => !v)}
                />
              </Tooltip>
              {/* 终端：一个按钮搞定「开/关」与「选 shell」——
                  只有一种 shell 时点了直接开（再点关闭），多选时弹出菜单挑 */}
              {shells.length > 1 ? (
                <Tooltip title={term ? '切换终端' : '选择终端'}>
                  <Dropdown
                    trigger={['click']}
                    placement="bottomRight"
                    menu={{
                      items: shellMenuItems,
                      onClick: handleShellSelect,
                      selectedKeys: term?.shellId ? [term.shellId] : []
                    }}
                  >
                    <Button
                      type="text"
                      className={cn('px-1.5', term ? 'text-primary' : 'text-muted-foreground')}
                      icon={<Terminal className="size-4" />}
                    />
                  </Dropdown>
                </Tooltip>
              ) : (
                <Tooltip title={term ? '关闭终端' : '打开终端'}>
                  <Button
                    type="text"
                    className={cn('px-1.5', term ? 'text-primary' : 'text-muted-foreground')}
                    icon={<Terminal className="size-4" />}
                    onClick={handleTerminalClick}
                  />
                </Tooltip>
              )}
              <Tooltip title="打开工作区目录">
                <Dropdown
                  trigger={['click']}
                  placement="bottomRight"
                  menu={{ items: openMenuItems, onClick: handleOpenMenuClick }}
                >
                  <Button
                    type="text"
                    className="px-1.5 text-muted-foreground"
                    icon={<ExternalLink className="size-4" />}
                  />
                </Dropdown>
              </Tooltip>
              {/* 快捷功能：与终端 / 打开同一排，下拉列 `<工作区>/.dogi/workspace.json`
                  里配好的条目（另见 WorkspaceQuickActions） */}
              <WorkspaceQuickActions workspace={active} onRunCommand={runQuickCommand} />
            </>
          )}
        </div>
      </div>

      {/* 内容区：左侧对话（对话流 + 输入框 + 内嵌终端），文件视图作为右侧抽屉覆盖在其上。
          下面三个块刻意保持原缩进没有重排 —— 只多包一层容器，
          免得整段 JSX 的缩进 diff 淹掉真正的改动。 */}
      <div ref={contentRef} className="relative flex min-h-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {/* 对话流 + 底部的「滚动到底部」按钮。这一层 relative 只为给按钮做定位上下文，
          按钮浮在对话流底部正中央，不参与布局、不挤压消息 */}
          <div className="relative flex min-h-0 flex-1 flex-col">
            <div
              ref={scrollRef}
              onScroll={onScroll}
              className="agent-scroll min-h-0 flex-1 select-text overflow-y-auto p-4"
            >
              {!active ? (
                <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
                  <Bot className="size-12 opacity-30" />
                  <div className="text-sm text-muted-foreground">
                    在左侧「工作区」面板添加一个本地目录，即可让 Agent 在该目录内
                    <br />
                    阅读 / 编辑文件、搜索代码并执行命令。
                  </div>
                  <Button type="primary" onClick={() => setSidebarCollapsed(false)}>
                    打开工作区面板
                  </Button>
                </div>
              ) : messages.length === 0 && !streaming ? (
                <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
                  <Bot className="size-10 opacity-30" />
                  <div className="text-sm text-muted-foreground">
                    在下方输入你想在「{active.name}」里完成的任务。
                  </div>
                  <div className="text-xs text-muted-foreground/60">
                    例如：列出项目结构，帮我加一个 /health 接口，然后跑一遍测试
                  </div>
                </div>
              ) : (
                <>
                  <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-2">
                    {messages.map((m, i) => (
                      <MessageBubble
                        key={m.id}
                        conversationId={conversationId}
                        message={m}
                        streaming={streaming && i === messages.length - 1 && m.role === 'assistant'}
                        canEdit={!streaming && m.role === 'user'}
                        editing={editing?.id === m.id}
                        onEdit={startEdit}
                        canDelete={!streaming}
                        tailCount={messages.length - i}
                        pendingConfirm={pendingConfirm}
                      />
                    ))}
                    {error && !streaming && (
                      <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                        {error}
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>
            {/* 右侧「消息目录」：用户消息各占一段，悬停预览、点击跳转 */}
            <MessageOutline messages={messages} onJump={jumpToMessage} />
            {/* 不在底部时才出现：一键回到最新内容（往上翻历史之后不用一路滚回去） */}
            {showJump && (
              <button
                type="button"
                onClick={jumpToBottom}
                title="滚动到底部"
                aria-label="滚动到底部"
                className="absolute bottom-3 left-1/2 flex size-8 -translate-x-1/2 items-center justify-center rounded-full border border-border bg-background text-muted-foreground shadow-md transition-colors hover:bg-secondary hover:text-foreground"
              >
                <ArrowDown className="size-4" />
              </button>
            )}
          </div>

          {/* 底部大输入框：外层外壳是唯一的边框（内层输入区无边框，避免双重 border）；
          左下角是命令执行权限，右下角是模型选择与发送/停止（模型紧贴发送按钮左侧） */}
          {active && (
            <div className="shrink-0 p-4">
              <div className="mx-auto w-full max-w-3xl">
                {/* 编辑态提示条：说清「发送会连带删掉后面的消息」，也给了退路（Esc / 叉） */}
                {editing && (
                  <div className="mb-1.5 flex items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-xs text-amber-600 dark:text-amber-400">
                    <Pencil className="size-3.5 shrink-0" />
                    <span className="min-w-0 flex-1 truncate">
                      正在编辑这条消息 · 发送后会删除它及其之后的全部消息
                    </span>
                    <button
                      type="button"
                      title="取消编辑（Esc）"
                      aria-label="取消编辑"
                      onClick={cancelEdit}
                      className="shrink-0 rounded p-0.5 transition-colors hover:bg-amber-500/20"
                    >
                      <X className="size-3.5" />
                    </button>
                  </div>
                )}
                <div
                  className={cn(
                    'overflow-hidden rounded-xl border border-transparent bg-muted/50 transition-colors',
                    'focus-within:border-primary/50 focus-within:bg-muted/70'
                  )}
                >
                  <Input.TextArea
                    ref={textareaRef}
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape' && editing) {
                        e.preventDefault()
                        cancelEdit()
                        return
                      }
                      if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                        e.preventDefault()
                        handleSend()
                      }
                    }}
                    placeholder={
                      editing
                        ? '改完按 Enter 重新发送（会先删除这条及其之后的全部消息）'
                        : hasConfig
                          ? `在「${active.name}」中描述你的任务…（Enter 发送 · Shift+Enter 换行）`
                          : backend === 'acp'
                            ? '请先在设置中配置 ACP agent（AI 配置页）'
                            : '请先在设置中配置 AI 模型'
                    }
                    autoSize={{ minRows: 2, maxRows: 8 }}
                    variant="borderless"
                    className="agent-input max-h-52 w-full border-none bg-transparent px-3 py-2.5 text-[13px] shadow-none"
                  />
                  {/* 工具行：权限在左，模型选择紧贴发送按钮（模型 + 发送/停止 一组靠右） */}
                  <div className="flex items-center justify-between gap-2 px-2 py-1.5">
                    <div className="flex min-w-0 items-center gap-0.5">
                      <Dropdown
                        trigger={['click']}
                        placement="topLeft"
                        autoAdjustOverflow={false}
                        menu={{
                          selectable: true,
                          selectedKeys: [permissionMode],
                          items: AGENT_PERMISSION_MODES.map((m) => ({
                            key: m.value,
                            icon: <m.icon className="size-3.5" />,
                            label: (
                              <span>
                                {m.label}
                                <span className="block text-[10px] text-muted-foreground">
                                  {m.hint}
                                </span>
                              </span>
                            )
                          })),
                          onClick: ({ key }) => void setAiPermissionMode(key as AiPermissionMode)
                        }}
                      >
                        <Button
                          type="text"
                          size="small"
                          className={cn(
                            'text-muted-foreground',
                            permissionMode === 'confirm' && 'text-amber-500'
                          )}
                        >
                          <PermissionIcon className="size-3.5" />
                          {permissionMeta.label}
                        </Button>
                      </Dropdown>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <Select
                        size="small"
                        variant="borderless"
                        placement="topLeft"
                        // bare-select：按下（展开）也不许冒边框 —— antd 会给聚焦的 Select
                        // 补一圈 focus outline，权限按钮没有，这里对齐（见 index.css）
                        className="bare-select max-w-56 min-w-0"
                        value={modelSelectValue}
                        onChange={(v) => handleModelSelect(v)}
                        placeholder="选择模型"
                        popupMatchSelectWidth={false}
                        options={modelOptions}
                      />
                      {streaming ? (
                        <Button
                          type="text"
                          danger
                          icon={<Square className="size-4" />}
                          title="停止生成"
                          className="shrink-0"
                          onClick={() => {
                            if (conversationId) void abortAgent(conversationId)
                          }}
                        />
                      ) : (
                        <Button
                          type="text"
                          icon={<Send className="size-4" />}
                          disabled={!input.trim() || !hasConfig}
                          title="发送"
                          className="shrink-0"
                          onClick={handleSend}
                        />
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* 内嵌终端：位于输入框下方 */}
          {active && term && (
            <EmbeddedTerminal
              session={term.session}
              path={term.path}
              onClose={closeEmbeddedTerminal}
            />
          )}
        </div>

        {/* 工作区文件视图：从右边缘滑出的抽屉（antd Drawer 那种观感），**不全屏**。
            绝对定位覆盖在内容区之上、不参与 flex 布局 ——
            展开时左侧对话的宽度与排版一点不动（挤窄对话区会让消息整段重排） */}
        {active && (
          <RightDrawer
            open={filesOpen}
            width={filesRenderWidth}
            // 容器比最小宽度还窄时（分屏挤到极限），下限也跟着降 —— 否则 min > max，
            // 拖拽条会一直把宽度夹到 min，把抽屉顶出内容区
            minWidth={Math.min(FILES_DRAWER_MIN_WIDTH, filesMaxWidth)}
            maxWidth={filesMaxWidth}
            onResize={setFilesWidth}
            onClose={closeFiles}
          >
            <AgentFilesPanel
              workspaceId={active.id}
              workspaceName={active.name}
              onClose={closeFiles}
            />
          </RightDrawer>
        )}
      </div>
    </div>
  )
}
