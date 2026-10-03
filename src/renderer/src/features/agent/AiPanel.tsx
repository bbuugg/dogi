import { AiMarkdown } from '@/features/agent/AiMarkdown'
import { AskFollowupCard } from '@/features/agent/AskFollowupCard'
import { MessageCopyButton } from '@/features/agent/MessageCopyButton'
import { MessageDeleteButton } from '@/features/agent/MessageDeleteButton'
import { MessageEditButton } from '@/features/agent/MessageEditButton'
import { ReasoningPanel } from '@/features/agent/ReasoningPanel'
import { TOOL_LABELS, ToolCallRow, toolRunStatus } from '@/features/agent/ToolCallRow'
import { findTailStart, TurnFold, turnStepSummary } from '@/features/agent/turn-fold'
import { TokenUsageRow } from '@/features/agent/TokenUsageRow'
import { ContextNoticeBar } from '@/features/agent/ContextNoticeBar'
import { RetryIndicator } from '@/features/agent/RetryIndicator'
import { TypingDots } from '@/features/agent/TypingDots'
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton
} from '@/features/agent/Conversation'
import { configModels, hasUsableConfig, modelNameOnly } from '@/features/agent/model-options'
import { Button, Dropdown, Input, Popconfirm, Select } from 'antd'
import { useAppStore } from '@/stores/app-store'
import { cn } from 'cn'
import { ASK_FOLLOWUP_TOOL } from '@shared/ask-followup'
import type {
  AgentChatMessage,
  AgentConfirmRequest,
  AgentMessagePart,
  AgentConversation,
  AiPermissionMode,
  TurnUsage
} from '@shared/types'
import {
  ChevronDown,
  ChevronUp,
  GripVertical,
  Loader2,
  Pencil,
  Plus,
  Send,
  Settings2,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Square,
  Trash2,
  X,
  PanelLeftClose,
  PanelLeftOpen
} from 'lucide-react'
import {
  memo,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentRef,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode
} from 'react'

/**
 * 权限模式（与工作区 Agent 共用同一份配置 `aiSettings.permissionMode`，
 * 图标/文案两边保持一致，别一处一个说法）。
 *
 * 「全部访问」给警示色 + 盾牌带感叹号：那是「不再询问」的档，不能悄无声息地开着。
 */
const PERMISSION_MODES: Array<{
  value: AiPermissionMode
  label: string
  icon: typeof ShieldCheck
  hint: string
}> = [
    {
      value: 'full',
      label: '全部访问',
      icon: ShieldAlert,
      hint: '无需确认，直接执行'
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
      // 空 / 纯空白的思考块直接丢弃（与 AgentPage 同口径，注释见那里的 buildRenderUnits）
      if (!part.text.trim()) continue
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
  // 尾部 trim：模型常在段间吐 `\n\n`，思考结束（由展开转收起）的那一帧会多出几行空白
  return units.map((u) => (u.kind === 'reasoning' ? { ...u, text: u.text.trimEnd() } : u))
}

/** 待批准的确认区（插在工具横条的展开体里）：终端命令必须先过这一关 */
function AiConfirmActions({ confirm }: { confirm: AgentConfirmRequest }) {
  const resolveAiConfirm = useAppStore((s) => s.resolveAiConfirm)
  return (
    <div className="flex gap-2 pt-0.5">
      <Button
        size="small"
        type="primary"
        className="h-8 flex-1 text-[13px]"
        onClick={() => void resolveAiConfirm(confirm.id, true)}
      >
        执行
      </Button>
      <Button
        size="small"
        className="h-8 flex-1 text-[13px]"
        onClick={() => void resolveAiConfirm(confirm.id, false)}
      >
        取消
      </Button>
    </div>
  )
}

function MessageBubbleImpl({
  role,
  parts,
  streaming,
  canEdit,
  editing,
  onEdit,
  canDelete,
  tailCount,
  onDelete,
  pendingConfirm,
  usage,
  retrying
}: {
  role: 'user' | 'assistant'
  parts: AgentMessagePart[]
  streaming?: boolean
  /** 整轮对话是否已结束（生成中不允许改，否则会把正在流式的消息一起截掉） */
  canEdit: boolean
  /** 这条正在被编辑（内容已灌进底部输入框） */
  editing: boolean
  onEdit: () => void
  /** 整轮对话是否已结束（生成中不允许删，否则会把正在流式的消息一起截掉） */
  canDelete: boolean
  /** 含本条在内、会被一起删掉的消息条数 */
  tailCount: number
  onDelete: () => void
  pendingConfirm: AgentConfirmRequest | null
  /** 这一轮的用量统计（仅助手消息、一轮跑完后才有） */
  usage?: TurnUsage
  /** 模型请求正在重试（第 N 次）：把「正在生成」的三点替换成单条「第 N 次重试」 */
  retrying?: { attempt: number; maxRetries: number } | null
}) {
  const del = canDelete ? (
    <MessageDeleteButton count={tailCount} onConfirm={onDelete} />
  ) : null

  if (role === 'user') {
    const text = parts
      .filter((p) => p.type === 'text')
      .map((p) => (p.type === 'text' ? p.text : ''))
      .join('')
    return (
      <div className="group/msg flex flex-col items-end gap-1">
        {/* 选中态用半透明白：主色底 + 白字下，浏览器的默认蓝色选区会把字压得看不清 */}
        <div
          className={cn(
            'max-w-[85%] selection:bg-white/25 whitespace-pre-wrap rounded-lg rounded-br-sm bg-primary px-3 py-2 text-sm text-white',
            // 正在编辑：压暗 + 描边，一眼能看出「改的是这条」
            editing && 'opacity-50 ring-2 ring-border ring-offset-2 ring-offset-background'
          )}
        >
          {text}
        </div>
        {/* invisible 而不是不渲染：保留占位，hover 时不会把消息挤动 */}
        <div className="invisible flex items-center gap-1 group-hover/msg:visible">
          <MessageCopyButton text={text} />
          {canEdit && <MessageEditButton onEdit={onEdit} />}
          {del}
        </div>
      </div>
    )
  }

  // 工具调用与结果合并成一条横条展示
  const units = buildRenderUnits(parts)
  // 复制的是 Markdown 源码（跳过工具横条，文本段之间以空行衔接）
  const rawText = parts
    .filter((p) => p.type === 'text')
    .map((p) => (p.type === 'text' ? p.text : ''))
    .join('\n\n')
    .trim()
  const last = units[units.length - 1]
  // 空档期（还没吐出任何内容，或最后一步是已完成的工具、正文尚未开始）显示三点
  const showDots = !!streaming && (units.length === 0 || (last?.kind === 'tool' && !!last.result))

  // 一轮已完成（助手消息、且不是正在流式、且没有待回答的追问卡）：把「末尾连续正文之前」的过程
  // 收进一个折叠组，只留最终回答可见；与 fishwork 的 TurnStepGroup 等价。
  // 待回答的追问卡不能折进去 —— 否则那张需要用户作答的交互卡被藏住（fishwork 也是这个处理）。
  const followupRequests = useAppStore((s) => s.followupRequests)
  const hasPendingFollowup = units.some(
    (u) => u.kind === 'tool' && u.call.toolName === ASK_FOLLOWUP_TOOL && !!followupRequests[u.call.toolCallId]
  )
  const turnDone = role === 'assistant' && !streaming && !hasPendingFollowup
  const tailStart = turnDone ? findTailStart(units) : 0
  const foldedUnits = tailStart > 0 ? units.slice(0, tailStart) : null

  const renderUnit = (unit: RenderUnit, i: number): ReactNode => {
    if (unit.kind === 'text') {
      return (
        <div key={i} className="p-2">
          <AiMarkdown content={unit.text} />
        </div>
      )
    }
    if (unit.kind === 'reasoning') {
      return (
        <div key={i} className="px-3">
          <ReasoningPanel text={unit.text} streaming={!!streaming && i === units.length - 1} />
        </div>
      )
    }
    if (unit.call.toolName === ASK_FOLLOWUP_TOOL) {
      // 提问工具：待回答时是一张可交互的卡片，答完收成一条横条
      return (
        <div key={i} className="px-3">
          <AskFollowupCard
            toolCallId={unit.call.toolCallId}
            input={unit.call.input}
            output={unit.result?.output}
            isError={unit.result?.isError}
            streaming={streaming}
          />
        </div>
      )
    }
    return (
      <div key={i} className="px-3">
        <ToolCallRow
          toolName={unit.call.toolName}
          input={unit.call.input}
          // 入参流式生成期攒下的半截 JSON：卡片据此显示「正在生成…」（见 stores/agent-helpers）
          inputText={unit.call.inputText}
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
              <AiConfirmActions confirm={pendingConfirm} />
            ) : undefined
          }
        />
      </div>
    )
  }

  return (
    <div className="group/msg space-y-5">
      {foldedUnits && (
        <TurnFold summary={turnStepSummary(foldedUnits)}>
          {foldedUnits.map((unit, k) => renderUnit(unit, k))}
        </TurnFold>
      )}
      {units.slice(tailStart).map((unit, k) => renderUnit(unit, tailStart + k))}
      {usage && <TokenUsageRow usage={usage} className="px-3" />}
      {showDots &&
        (retrying ? (
          <RetryIndicator
            key={retrying.attempt}
            attempt={retrying.attempt}
            className="px-3 py-2"
          />
        ) : (
          <TypingDots className="flex items-center gap-1.5 px-3 py-2" />
        ))}
      {/* 消息下方：复制原始 Markdown / 删除（生成中内容还在变，一轮结束再显示）；
          invisible 而不是不渲染：保留占位，hover 时不会把消息挤动 */}
      <div className="invisible flex items-center gap-1 px-3 group-hover/msg:visible">
        {!streaming && <MessageCopyButton text={rawText} title="复制原文（Markdown）" />}
        {del}
      </div>
    </div>
  )
}

/** 记忆化：流式期间只重渲染正在生成的那条（parts / usage 引用不变的历史消息直接跳过）。
 *  onEdit / onDelete 是渲染期为当前 msg 新建的闭包，行为恒定，不参与比较 ——
 *  换会话时列表整体重挂（listKey 变化），不存在闭包串台。 */
const MessageBubble = memo(
  MessageBubbleImpl,
  (a, b) =>
    a.role === b.role &&
    a.parts === b.parts &&
    a.streaming === b.streaming &&
    a.canEdit === b.canEdit &&
    a.editing === b.editing &&
    a.canDelete === b.canDelete &&
    a.tailCount === b.tailCount &&
    a.pendingConfirm === b.pendingConfirm &&
    a.usage === b.usage &&
    a.retrying === b.retrying
)

/**
 * 折叠态单行：直接展示文本（逐 token 更新即打字效果），垂直居中、超出宽度省略。
 * 横向滚动与打字效果在感知上冲突（溢出时变成滚动条就看不出在打字），故不启用横向滚动。
 */
function ScrollLine({ text }: { text: string }) {
  return (
    <div
      className="flex items-center overflow-hidden"
      style={{ height: COLLAPSED_LINE_H }}
    >
      <div className="truncate whitespace-nowrap text-[12px] leading-4 text-muted-foreground">
        {text}
      </div>
    </div>
  )
}

/** 稳定的空消息数组：避免每次渲染新引用导致滚动 effect 误触发 */
const NO_MESSAGES: AgentChatMessage[] = []

/**
 * 折叠态流式日志的完整文本：保留换行（工具调用 / 错误各占一行），
 * 供「逐行向上滚动」展示 —— 只在出现新行（换行）时整体上移一次，
 * 正在输入的当前行原地更新、不重挂载、不淡入，避免逐 token 替换造成的闪烁。
 */
function buildCollapsedText(messages: AgentChatMessage[]): string {
  const last = messages[messages.length - 1]
  if (!last) return ''
  // 最后一条还是用户消息（助手还没开口）：对齐 Codex 的「思考中」文案
  if (last.role === 'user') return '思考中…'
  let text = ''
  for (const p of last.parts) {
    if (p.type === 'text') text += p.text
    else if (p.type === 'reasoning') text += p.text
    else if (p.type === 'tool-call') text += `\n⚙ ${TOOL_LABELS[p.toolName] ?? p.toolName}\n`
    else if (p.type === 'tool-result' && p.isError) {
      text += `\n⚠ ${TOOL_LABELS[p.toolName] ?? p.toolName}失败\n`
    }
  }
  // 助手已开始流式但还没吐出任何内容（含工具执行中、纯思考未落字）：保持「思考中」
  if (!text.trim()) return '思考中…'
  return text
}

/** 会话列表条目的时间标签：今天给时刻，更早给日期 */
function convTimeLabel(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  const pad = (n: number) => String(n).padStart(2, '0')
  return sameDay
    ? `${pad(d.getHours())}:${pad(d.getMinutes())}`
    : `${d.getMonth() + 1}/${d.getDate()}`
}

/** 浮窗容器与面板组内容区的边距下限（px） */
const FLOAT_MARGIN = 8

/** 浮窗默认离容器底部的距离（px） */
const DEFAULT_BOTTOM = 24

/** 横条输入栏固定高度（px）：py-1.5×2 + 内容 h-8，锚点翻转/拖拽钳制都以此为准 */
const BAR_HEIGHT = 44

/** 折叠态流式日志的单行高度（px，与 text-[12px] leading-4 一致）与可见行数 */
const COLLAPSED_LINE_H = 16
const COLLAPSED_VISIBLE = 1

/** 浮窗展开时的最小高度（px）：输入横条 + 至少能看到一小段消息区 */
const MIN_PANEL_HEIGHT = 180

/** 浮窗最小宽度（px）：卡片头部一排控件挤得下即可 */
const MIN_PANEL_WIDTH = 320

/** 左侧会话列表的宽度（px） */
const CONV_LIST_WIDTH = 190

/**
 * 浮窗缩放方向：n/s 上下边、e/w 左右边、四角为两两组合。
 * 语义是「窗口边」——拖动哪条边，哪条边动，对边保持不动。
 */
type ResizeDir = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

/** 四边 + 四角手柄的位置/光标描述（角排在边之后，命中优先级更高） */
const RESIZE_HANDLES: Array<{ dir: ResizeDir; cls: string; indicator: string }> = [
  { dir: 'n', cls: 'inset-x-2.5 top-0 h-1.5 cursor-row-resize', indicator: 'h-1 w-10' },
  { dir: 's', cls: 'inset-x-2.5 bottom-0 h-1.5 cursor-row-resize', indicator: 'h-1 w-10' },
  { dir: 'w', cls: 'inset-y-2.5 left-0 w-1.5 cursor-col-resize', indicator: 'h-10 w-1' },
  { dir: 'e', cls: 'inset-y-2.5 right-0 w-1.5 cursor-col-resize', indicator: 'h-10 w-1' },
  { dir: 'nw', cls: 'left-0 top-0 size-2.5 cursor-nwse-resize', indicator: 'size-1.5' },
  { dir: 'ne', cls: 'right-0 top-0 size-2.5 cursor-nesw-resize', indicator: 'size-1.5' },
  { dir: 'sw', cls: 'left-0 bottom-0 size-2.5 cursor-nesw-resize', indicator: 'size-1.5' },
  { dir: 'se', cls: 'right-0 bottom-0 size-2.5 cursor-nwse-resize', indicator: 'size-1.5' }
]

/**
 * 浮在终端之上的 AI 助手浮窗：展示并驱动这个终端页面的 AI 会话。
 *
 * 平时只是终端底部居中的一条横式输入栏（拖拽手柄 + 权限模式图标 + 输入框 + 发送）；
 * 发送后向上展开消息列表卡片，卡片头部可最小化 —— 最小化后只留一行状态条，
 * 最新对话内容像 Codex「思考中」那样逐行替换闪过。整体可拖拽移动（位置存 store，各终端共享）。
 *
 * AI 助手属于**终端页面**（终端标签 = 一个会话）：每个终端页面一个实例，
 * 开关（`ui.aiOpenSessions`）、最小化（`ui.aiMinimizedSessions`）与当前打开的
 * AI 会话（`activeTerminalConv`）都按页面隔离。
 *
 * 会话模型与工作区 Agent 同构（统一的 agent:chat 引擎）：左侧可展开会话列表
 * （跨终端页面共享，持久化），「新开会话」开的是草稿 —— 首条消息发出那一刻才转正落盘。
 * 工具绑定按请求计算：在哪条会话里发消息，工具就作用于那个终端页面的会话。
 */
export function AiPanel({ sessionId }: { sessionId: string | null }) {
  const aiConfigs = useAppStore((s) => s.aiConfigs)
  const aiSettings = useAppStore((s) => s.aiSettings)
  const sessions = useAppStore((s) => s.sessions)
  const activeSession = sessions.find((s) => s.id === sessionId)
  // 当前页面打开的 AI 会话：可能是草稿（新建还没发过消息），也可能是池里的历史会话
  const activeId = useAppStore((s) => (sessionId ? s.activeTerminalConv[sessionId] : undefined))
  const draft = useAppStore((s) => (sessionId ? s.terminalDrafts[sessionId] : undefined))
  const conversation: AgentConversation | undefined = useAppStore((s) => {
    if (!sessionId) return undefined
    if (draft && draft.id === activeId) return draft
    return s.terminalConversations.find((c) => c.id === activeId)
  })
  const terminalConversations = useAppStore((s) => s.terminalConversations)
  // 运行态（流式 / 重试 / 压缩通知）在 agentRuns 上，按会话 id 取 —— 与工作区 Agent 同一份
  const run = useAppStore((s) => (conversation ? s.agentRuns[conversation.id] : undefined))
  const messages = conversation?.messages ?? NO_MESSAGES
  const cid = conversation?.id ?? null
  const aiStreaming = run?.streaming ?? false
  const aiError = run?.error ?? null
  const deleteTerminalMessagesFrom = useAppStore((s) => s.deleteTerminalMessagesFrom)
  // 本会话待批准的确认请求：多实例下各会话独立，显示在对应工具卡内
  const pendingConfirm = useAppStore((s) => {
    for (const c of Object.values(s.pendingConfirms)) {
      if (c.sessionId === sessionId) return c
    }
    return null
  })
  const sendTerminalMessage = useAppStore((s) => s.sendTerminalMessage)
  const resendTerminalMessage = useAppStore((s) => s.resendTerminalMessage)
  const abortTerminal = useAppStore((s) => s.abortTerminal)
  const newTerminalConversation = useAppStore((s) => s.newTerminalConversation)
  const selectTerminalConversation = useAppStore((s) => s.selectTerminalConversation)
  const deleteTerminalConversation = useAppStore((s) => s.deleteTerminalConversation)
  const setTerminalConversationModel = useAppStore((s) => s.setTerminalConversationModel)
  const setAiPermissionMode = useAppStore((s) => s.setAiPermissionMode)
  const resolveAiConfirm = useAppStore((s) => s.resolveAiConfirm)
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen)
  const setSessionAiOpen = useAppStore((s) => s.setSessionAiOpen)
  const aiPanelWidth = useAppStore((s) => s.ui.aiPanelWidth)
  const aiPanelHeight = useAppStore((s) => s.ui.aiPanelHeight)
  const floatingPos = useAppStore((s) => s.ui.aiFloatingPos)
  const setAiFloatingPos = useAppStore((s) => s.setAiFloatingPos)
  const setAiPanelWidth = useAppStore((s) => s.setAiPanelWidth)
  const setAiPanelHeight = useAppStore((s) => s.setAiPanelHeight)
  // 未显式设置过则为最小化（只露输入条），发送/待批准时自动展开
  const minimized = useAppStore((s) =>
    sessionId ? s.ui.aiMinimizedSessions[sessionId] !== false : true
  )
  const setAiMinimized = useAppStore((s) => s.setAiMinimized)

  const [input, setInput] = useState('')
  /** 正在编辑的用户消息（内容已灌进横条输入框；发送时先删这条及其之后，再重发） */
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null)
  /** 左侧会话列表是否展开（面板本地的 UI 态，不进 store） */
  const [listOpen, setListOpen] = useState(false)
  const inputRef = useRef<ComponentRef<typeof Input> | null>(null)
  // 弹层展开状态受控：antd 的下拉 portal 在 body 上，拖浮窗时不会跟随，
  // 会在原地悬空错位 —— 拖拽开始就把它们收起
  const [modelSelectOpen, setModelSelectOpen] = useState(false)
  const [permMenuOpen, setPermMenuOpen] = useState(false)
  const rootRef = useRef<HTMLElement>(null)
  const barRef = useRef<HTMLDivElement>(null)
  // 面板组内容区尺寸：用于「横条在上半区时卡片向下展开」的翻转判断，以及
  // 尺寸/位置钳制（窗口缩小、分屏后浮窗不能溢出内容区）
  const [containerH, setContainerH] = useState<number | null>(null)
  const [containerW, setContainerW] = useState<number | null>(null)

  useEffect(() => {
    const parent = rootRef.current?.parentElement
    if (!parent) return
    const update = () => {
      setContainerH(parent.clientHeight)
      setContainerW(parent.clientWidth)
    }
    update()
    const ro = new ResizeObserver(update)
    ro.observe(parent)
    return () => ro.disconnect()
  }, [])
  // 消息流的滚动定位（吸底跟随 / 发送回底 / 回底按钮）都在 Conversation 内部管理；
  // 卡片从折叠态展开时高度才有值，靠 resetKey 里的 minimized 触发一次瞬时落底。

  // 助手在折叠态（只剩一条横条）时提问会把卡片藏住，用户根本看不到 —— 有提问就撑开
  const hasFollowupForSession = useAppStore((s) => {
    if (!sessionId) return false
    for (const req of Object.values(s.followupRequests)) {
      if (req.sessionId === sessionId) return true
    }
    return false
  })
  useEffect(() => {
    if (hasFollowupForSession && sessionId) setAiMinimized(sessionId, false)
  }, [hasFollowupForSession, sessionId, setAiMinimized])

  // 面板还没有任何会话（首次打开 / 跨重启的新终端页面）时现开一个草稿，
  // 保证「点开就能输入」；已有草稿时 newTerminalConversation 会复用它
  useEffect(() => {
    if (sessionId && !activeId) newTerminalConversation(sessionId)
  }, [sessionId, activeId, newTerminalConversation])

  // 模型按**会话**独立：这条会话选过就用自己的，没选过才回退到设置页的默认模型。
  // 参与回退的配置必须**有可用模型**（models 被删空的配置跳过，否则下拉会出 undefined 项、
  // 请求也解析不出模型）
  const usable = (id?: string | null): string | undefined =>
    hasUsableConfig(aiConfigs, id) ? (id ?? undefined) : undefined
  const effectiveConfigId = usable(conversation?.configId) ?? usable(aiSettings.activeConfigId)
  const hasConfig = Boolean(effectiveConfigId)

  // ---------- 模型下拉：按「模型配置 / 模型 id」两级分组（结构同 Agent 页） ----------
  // 终端助手只有内置 Mastra 引擎 —— ACP 会话是 AI Agent 页的形态（每个会话绑定一个外部 agent），
  // 终端助手既不能挂上去也没有意义，所以这里不再出现 ACP 分组。
  const modelSelectValue = (() => {
    const config = aiConfigs.find((c) => c.id === effectiveConfigId)
    if (!config) return undefined
    const models = configModels(config)
    if (models.length === 0) return undefined
    if (conversation?.modelId && models.includes(conversation.modelId)) {
      return `cfg:${config.id}:${conversation.modelId}`
    }
    return `cfg:${config.id}:${models[0]}`
  })()
  /**
   * 下拉选项：**只能有一层分组**。
   *
   * ⚠️ antd 6 的 Select（@rc-component/select）flattenOptions 会把「组的子项」一律当作
   * 可选 option（取 data.value），不再继续下钻 —— 两层嵌套分组时内层分组会变成
   * `value: undefined` 的选项，模型 id 根本不渲染、点了也没反应。
   * 所以「配置 / 模型 id」的从属关系用组内条目的 label 前缀表达。
   */
  const modelOptions = [
    ...(aiConfigs.length > 0
      ? [
        {
          label: 'AI 模型',
          options: aiConfigs.flatMap((c) =>
            configModels(c).map((m) => ({ value: `cfg:${c.id}:${m}`, label: `${c.name} · ${m}` }))
          )
        }
      ]
      : [])
  ]
  const handleModelSelect = (value?: string): void => {
    if (!cid || !value) return
    if (value.startsWith('cfg:')) {
      const [, cfgId, cfgModel] = value.split(':')
      void setTerminalConversationModel(cid, { configId: cfgId, modelId: cfgModel })
    }
  }
  const permissionMode: AiPermissionMode =
    aiSettings.permissionMode === 'confirm' ? 'confirm' : 'full'
  const permissionMeta =
    PERMISSION_MODES.find((m) => m.value === permissionMode) ?? PERMISSION_MODES[1]
  const PermissionIcon = permissionMeta.icon
  const hasMessages = messages.length > 0 || aiStreaming
  const showList = !minimized
  /** 触发 Conversation 瞬时落底的序号：自己发消息 / 卡片展开（高度过渡结束）后递增 */
  const [scrollResetSeq, setScrollResetSeq] = useState(0)

  // 卡片从折叠态展开时高度有 200ms 过渡（见下方 transition-[height]），等它结束再落底 ——
  // 否则按 0 高度算出的落点是错的（沿用原 VirtualMessageList 的 extra=minimized 时序）
  useEffect(() => {
    if (minimized) return
    const t = setTimeout(() => setScrollResetSeq((s) => s + 1), 260)
    return () => clearTimeout(t)
  }, [minimized])
  // 折叠态流式日志：最新消息的完整文本（保留换行），按行向上滚动展示
  const collapsedText = buildCollapsedText(messages)

  // pos.y 语义恒为「横条底边距容器底部的距离」，翻转与否不改基准
  const anchoredBottom = floatingPos ? floatingPos.y : DEFAULT_BOTTOM
  // 横条上方是否有实体内容（列表 / 确认条 / 错误条）：只有这时才需要翻转
  const hasUpperContent =
    showList ||
    (minimized && Boolean(pendingConfirm)) ||
    (!showList && Boolean(aiError))
  // 横条落在容器上半区（条顶边越过中线）：卡片整体向下展开，
  // 否则列表/确认条向上长会超出容器顶边。两种模式的高度都被
  // 钳在横条所在侧的剩余空间内，内容超高时消息区内部滚动。
  const barNearTop =
    containerH !== null && containerH - anchoredBottom - BAR_HEIGHT < containerH / 2
  const flipped = hasUpperContent && barNearTop
  // 翻转状态粘滞：收起瞬间若立刻切回 bottom 锚点，列表会在 200ms 收起动画期间
  // 跳回横条上方收缩（向上弹一下）；展开时则需同步生效（layout 阶段 setState，
  // 绘制前完成，不会闪现错锚点的一帧）。两种锚点下横条位置完全一致，
  // 动画结束后再切换锚点是无感的。
  const [flippedSticky, setFlippedSticky] = useState(false)
  useLayoutEffect(() => {
    if (flipped) {
      setFlippedSticky(true)
      return
    }
    const t = setTimeout(() => setFlippedSticky(false), 240)
    return () => clearTimeout(t)
  }, [flipped])
  // 缩放期间冻结翻转态：拖「横条侧」的边会带着横条移动、可能越过中线触发翻转，
  // 若中途翻，同一个 (x, y, 高度) 的渲染位置会整体跳一下 —— 冻结到松手再重算。
  const [frozenFlip, setFrozenFlip] = useState<boolean | null>(null)
  const flip = frozenFlip ?? flippedSticky

  // 高度上限：按当前锚点方向取「横条到容器另一侧」的剩余空间（与旧的 maxHeight 同源）。
  // 容器还没量到时不设限，先按用户设定值渲染。
  const maxPanelHeight =
    containerH === null
      ? Number.POSITIVE_INFINITY
      : Math.max(
        MIN_PANEL_HEIGHT,
        (flip ? anchoredBottom + BAR_HEIGHT : containerH - anchoredBottom) - FLOAT_MARGIN
      )
  // 展开态尺寸固定（不再随消息多少伸缩），用户拖四边/四角可调整；
  // 再按可用空间钳制一次，保证容器变小（窗口缩小 / 分屏）时浮窗仍留在可视区内。
  const panelHeight = Math.max(MIN_PANEL_HEIGHT, Math.min(aiPanelHeight, maxPanelHeight))
  const maxPanelWidth =
    containerW === null
      ? Number.POSITIVE_INFINITY
      : Math.max(MIN_PANEL_WIDTH, containerW - FLOAT_MARGIN * 2)
  const panelWidth = Math.max(MIN_PANEL_WIDTH, Math.min(aiPanelWidth, maxPanelWidth))
  const cardHeight = panelHeight - BAR_HEIGHT
  // 位置同样夹一下：容器变窄后从左边缘起算的位置不能把面板顶出右边
  const panelLeft =
    !floatingPos || containerW === null
      ? floatingPos?.x
      : Math.max(FLOAT_MARGIN, Math.min(floatingPos.x, containerW - panelWidth - FLOAT_MARGIN))

  const asideStyle: CSSProperties = {
    width: panelWidth,
    left: floatingPos ? panelLeft : '50%',
    transform: floatingPos ? undefined : 'translateX(-50%)',
    ...(flip && containerH !== null
      ? { top: containerH - anchoredBottom - BAR_HEIGHT }
      : { bottom: anchoredBottom })
  }

  /**
   * 拖拽移动浮窗：垂直位置以横条底边为基准（pos.y 语义在翻转/非翻转下一致，
   * 列表展开收起时横条不会跑位），并夹在面板组内容区内。落点在按钮/输入框等
   * 交互控件上时不启动拖拽，否则会抢走它们的点击。
   */
  const startDrag = (e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0) return
    const target = e.target as HTMLElement
    const el = rootRef.current
    // antd 的 Select 下拉、Dropdown 菜单都 portal 到 body：它们的事件会顺着 **React 树**
    // 冒泡回卡片头部这个 onPointerDown，但 DOM 上并不属于浮窗。若不放行，点下拉选项会被
    // 当成拖拽——既把弹层关掉，又 preventDefault 掉后续 mousedown/click，
    // 选项永远选不中（表现就是「模型切换切不过去」）。所以只认浮窗自己的 DOM。
    if (!el || !el.contains(target)) return
    if (target.closest('button, input, textarea, .ant-select, .ant-popover')) return
    setModelSelectOpen(false)
    setPermMenuOpen(false)
    e.preventDefault()
    const parent = el.parentElement
    if (!parent) return
    const cRect = parent.getBoundingClientRect()
    const rect = el.getBoundingClientRect()
    const barRect = barRef.current?.getBoundingClientRect() ?? rect
    const baseX = rect.left - cRect.left
    const baseY = cRect.bottom - barRect.bottom
    const startX = e.clientX
    const startY = e.clientY
    if (!floatingPos) setAiFloatingPos({ x: baseX, y: baseY })
    const move = (ev: PointerEvent) => {
      const x = Math.max(
        FLOAT_MARGIN,
        Math.min(cRect.width - rect.width - FLOAT_MARGIN, baseX + ev.clientX - startX)
      )
      // 只保证横条本体在容器内；卡片主体靠 flipped + 固定高度自适应剩余空间
      const y = Math.max(
        FLOAT_MARGIN,
        Math.min(cRect.height - BAR_HEIGHT - FLOAT_MARGIN, baseY - (ev.clientY - startY))
      )
      setAiFloatingPos({ x, y })
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  /**
   * 拖四边 / 四角缩放浮窗：按「窗口边」语义 —— 拖哪条边哪条边动，对边不动，
   * 拖动中始终把整个矩形夹在面板组内容区内，并且不小于最小宽高。
   *
   * 位置存储是 (左边距, 横条底边距容器底)，而手势算的是面板矩形，两者在翻转
   * 与否时换算方式不同（翻转后横条在面板顶部），所以这里按手势开始时的翻转态换算。
   */
  const startResize = (e: ReactPointerEvent<HTMLElement>, dir: ResizeDir) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    const el = rootRef.current
    const parent = el?.parentElement
    if (!el || !parent) return
    // 用 pointer capture 把后续事件锁在手柄上：鼠标拖出窗口边界再松手也能收到 pointerup，
    // 否则翻转态冻结会一直留着不放（拿不到 capture 时退化为 window 监听，行为一致）
    const handle = e.currentTarget
    const pointerId = e.pointerId
    try {
      handle.setPointerCapture(pointerId)
    } catch {
      // 忽略：下面仍用 window 监听兜底
    }
    const cRect = parent.getBoundingClientRect()
    const rect = el.getBoundingClientRect()
    const flipAtStart = flip
    setFrozenFlip(flipAtStart)
    // 面板矩形（相对容器左上角）
    const left0 = rect.left - cRect.left
    const top0 = rect.top - cRect.top
    const right0 = left0 + rect.width
    const bottom0 = top0 + rect.height
    const startX = e.clientX
    const startY = e.clientY
    /** 由面板矩形反算「位置 + 尺寸」并写入 store */
    const apply = (left: number, top: number, right: number, bottom: number) => {
      setAiPanelWidth(right - left)
      setAiPanelHeight(bottom - top)
      setAiFloatingPos({
        x: left,
        // 横条底边的位置：未翻转时横条在面板底部，翻转后在面板顶部
        y: flipAtStart ? cRect.height - top - BAR_HEIGHT : cRect.height - bottom
      })
    }
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - startX
      const dy = ev.clientY - startY
      let left = left0
      let top = top0
      let right = right0
      let bottom = bottom0
      if (dir.includes('w')) {
        left = Math.min(Math.max(FLOAT_MARGIN, left0 + dx), right0 - MIN_PANEL_WIDTH)
      }
      if (dir.includes('e')) {
        right = Math.max(Math.min(cRect.width - FLOAT_MARGIN, right0 + dx), left0 + MIN_PANEL_WIDTH)
      }
      if (dir.includes('n')) {
        top = Math.min(Math.max(FLOAT_MARGIN, top0 + dy), bottom0 - MIN_PANEL_HEIGHT)
      }
      if (dir.includes('s')) {
        bottom = Math.max(
          Math.min(cRect.height - FLOAT_MARGIN, bottom0 + dy),
          top0 + MIN_PANEL_HEIGHT
        )
      }
      apply(left, top, right, bottom)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      try {
        handle.releasePointerCapture(pointerId)
      } catch {
        // 忽略：capture 可能已随元素卸载释放
      }
      // 松手后再交回给自动翻转判断
      setFrozenFlip(null)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }

  /** 点「编辑」：把这条的内容灌进横条输入框并进入编辑态（发送时走重发，先删这条及其之后） */
  const startEdit = (target: AgentChatMessage) => {
    const text = target.parts
      .filter((p) => p.type === 'text')
      .map((p) => (p.type === 'text' ? p.text : ''))
      .join('')
    setEditing({ id: target.id, text })
    setInput(text)
    // 编辑要在展开的卡片里看得见，顺手把卡片撑开
    if (sessionId) setAiMinimized(sessionId, false)
    // 受控输入框要等这一帧的值写进去再聚焦，否则光标会停在旧文本末尾
    requestAnimationFrame(() => inputRef.current?.focus())
  }

  const cancelEdit = () => {
    setEditing(null)
    setInput('')
  }

  const handleSend = () => {
    if (!input.trim() || aiStreaming || !sessionId || !cid) return
    const text = input
    setInput('')
    // 自己发消息 / 编辑重发：让消息区瞬时落底（用户翻在上方也要回到底部）
    setScrollResetSeq((s) => s + 1)
    if (editing) {
      const id = editing.id
      setEditing(null)
      void resendTerminalMessage(cid, id, text)
    } else {
      void sendTerminalMessage(text, sessionId)
    }
  }

  // 换了会话 / 换了终端页面就清掉编辑态，避免把上一处的编辑目标带过去
  useEffect(() => {
    setEditing(null)
    setInput('')
  }, [sessionId, cid])

  // 会话列表（最新在前）：历史会话跨终端页面共享，草稿不进列表
  const convList = [...terminalConversations].sort((a, b) => b.updatedAt - a.updatedAt)

  return (
    <aside
      ref={rootRef}
      className={cn(
        // 描边用 ring（box-shadow）而不是 border：border 会在锚点侧垫出 1px，
        // 使 bottom/top 两套锚定公式对不上横条，展开/折叠时横条会微跳 2px
        'absolute z-20 flex select-none flex-col overflow-hidden rounded-xl bg-card/40 shadow-2xl ring-1 ring-inset ring-border backdrop-blur-md',
        // 上半区时反转主轴：DOM 里的「列表在上、横条在下」视觉上变为「横条在上、列表在下」
        flip && 'flex-col-reverse'
      )}
      style={asideStyle}
    >
      {/* 消息列表卡片展开/收起：直接对卡片高度做 0 ↔ cardHeight 过渡（沿横条对侧平滑生长），
          不直接装卸载；收起时禁用交互，避免隐形内容截获点击/焦点。
          ⚠️ 别改回 grid-rows 0fr/1fr 那套折叠：卡片高度是写死的确定值，会把这个 0fr
          轨道顶开（实测 grid-template-rows:0fr 会解析成 396px），折叠态照样把卡片露出来 */}
      <div
        className={cn(
          'min-h-0 overflow-hidden transition-[height] duration-200 ease-out',
          !showList && 'pointer-events-none'
        )}
        style={{ height: showList ? cardHeight : 0 }}
      >
        {/* 卡片内容：撑满折叠容器，头 + 主体（左会话列表 + 消息区）自上而下排布 */}
        <div className="flex h-full min-h-0 flex-col">
          {/* 卡片头部：拖拽手柄 + 模型选择 + 会话列表开关 + 操作（整行可拖动） */}
          <div
            onPointerDown={startDrag}
            className="flex h-10 shrink-0 cursor-move touch-none items-center gap-1 border-b border-border/70 bg-sidebar/40 px-2"
          >
            <GripVertical className="size-3.5 shrink-0 text-muted-foreground/50" />
            <Sparkles className="size-4 shrink-0 text-primary" />
            <Select
              size="small"
              variant="borderless"
              // bare-select：与 Agent 页的模型选择同一套观感 —— 按下（展开）不出边框、不泛白底（见 index.css）
              className="bare-select min-w-0 flex-1"
              value={modelSelectValue}
              onChange={handleModelSelect}
              placeholder="请选择模型"
              popupMatchSelectWidth={false}
              open={modelSelectOpen}
              onOpenChange={setModelSelectOpen}
              options={modelOptions}
              // 选中态只显示模型名（列表里仍是「提供商 · 模型」，方便区分同名模型）
              labelRender={(opt) => modelNameOnly(opt.label)}
            />
            <Button
              type="text"
              icon={listOpen ? <PanelLeftClose className="size-3.5" /> : <PanelLeftOpen className="size-3.5" />}
              className={cn('h-7 w-7 shrink-0 p-0', listOpen ? 'text-primary' : 'text-muted-foreground')}
              title={listOpen ? '收起会话列表' : '会话列表'}
              onClick={() => setListOpen((v) => !v)}
            />
            <Button
              type="text"
              icon={<Settings2 className="size-3.5" />}
              className="h-7 w-7 shrink-0 p-0 text-muted-foreground"
              title="AI 设置"
              onClick={() => setSettingsOpen(true, 'models')}
            />
            <Button
              type="text"
              icon={
                flip ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />
              }
              className="h-7 w-7 shrink-0 p-0 text-muted-foreground"
              title="最小化（收起为状态条）"
              onClick={() => sessionId && setAiMinimized(sessionId, true)}
            />
            <Button
              type="text"
              icon={<X className="size-4" />}
              className="h-7 w-7 shrink-0 p-0 text-muted-foreground"
              title="关闭 AI 助手"
              onClick={() => sessionId && setSessionAiOpen(sessionId, false)}
            />
          </div>

          {/* 编辑态提示条：说清「发送会连带删掉后面的消息」，也给了退路（Esc / 叉）。
              放在卡片顶部而不是横条里 —— 横条那一行已经排满，塞不下。 */}
          {editing && (
            <div className="flex h-7 shrink-0 items-center gap-1.5 border-b border-amber-500/30 bg-amber-500/10 px-2 text-[12px] text-amber-600 dark:text-amber-400">
              <Pencil className="size-3 shrink-0" />
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

          {/* 主体：左侧会话列表（可收起）+ 消息区 */}
          <div className="relative flex min-h-0 flex-1">
            {listOpen && (
              <div className="flex w-[var(--conv-w)] shrink-0 flex-col border-r border-border/70 bg-sidebar/30" style={{ ['--conv-w' as string]: `${CONV_LIST_WIDTH}px` }}>
                <button
                  type="button"
                  className="flex h-8 shrink-0 items-center gap-1.5 border-b border-border/60 px-2 text-[12px] text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground"
                  title="新开会话"
                  onClick={() => sessionId && newTerminalConversation(sessionId)}
                >
                  <Plus className="size-3.5" />
                  <span>新开会话</span>
                </button>
                <div className="min-h-0 flex-1 overflow-y-auto p-1">
                  {convList.length === 0 && (
                    <p className="px-2 py-3 text-[11px] leading-4 text-muted-foreground/70">
                      还没有历史会话。发送第一条消息后，这里会列出这个终端助手的全部会话。
                    </p>
                  )}
                  {convList.map((c) => {
                    const active = c.id === cid
                    return (
                      <div
                        key={c.id}
                        className={cn(
                          'group/item flex w-full cursor-pointer items-center gap-1 rounded-md px-2 py-1.5 text-left text-xs',
                          active
                            ? 'bg-primary/10 text-foreground'
                            : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground'
                        )}
                        onClick={() => sessionId && selectTerminalConversation(sessionId, c.id)}
                      >
                        <span className="min-w-0 flex-1 truncate">{c.title || '新会话'}</span>
                        <span className="shrink-0 text-[10px] text-muted-foreground/60">
                          {convTimeLabel(c.updatedAt)}
                        </span>
                        <Popconfirm
                          title="删除这条会话？"
                          description="消息历史将从磁盘一并删除。"
                          okText="删除"
                          cancelText="取消"
                          onConfirm={(e) => {
                            e?.stopPropagation()
                            if (sessionId) void deleteTerminalConversation(sessionId, c.id)
                          }}
                          onCancel={(e) => e?.stopPropagation()}
                        >
                          <span
                            role="button"
                            aria-label="删除会话"
                            className="hidden shrink-0 rounded p-0.5 text-muted-foreground/60 transition-colors hover:bg-destructive/10 hover:text-destructive group-hover/item:block"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <Trash2 className="size-3" />
                          </span>
                        </Popconfirm>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}

            {/* 消息区：占满剩余宽度并在内部滚动（高度固定，不随消息多少伸缩），
                AI 回复属于「内容」，保持可选中复制 */}
            <div className="relative min-h-0 min-w-0 flex-1 px-2">
              {messages.length === 0 ? (
                <div className="flex h-full flex-col p-3">
                  <div className="flex flex-1 flex-col items-center justify-center gap-3 py-6 text-center text-muted-foreground">
                    <Sparkles className="size-8 text-primary/40" />
                    {activeSession ? (
                      <div className="space-y-1 text-xs leading-5">
                        <p>试试：查看当前目录下占用空间最大的文件</p>
                        <p>试试：诊断 nginx 为什么启动失败</p>
                      </div>
                    ) : (
                      <div className="space-y-1 text-xs leading-5">
                        <p>打开一个终端会话后开始对话</p>
                        <p>每个终端页面有独立的 AI 上下文与会话列表</p>
                      </div>
                    )}
                    {!hasConfig && (
                      <Button
                        size="small"
                        variant="filled"
                        className="mt-2"
                        onClick={() => setSettingsOpen(true, 'models')}
                      >
                        先去配置模型
                      </Button>
                    )}
                  </div>
                  {aiError && <p className="text-xs text-destructive px-3">{aiError}</p>}
                </div>
              ) : (
                <Conversation
                  className="h-full pt-3"
                  resetKey={`${cid ?? '__no_conversation__'}#${scrollResetSeq}`}
                >
                  <ConversationContent>
                    {/* 上下文已压缩（与工作区 Agent 同款；累计 token 已收进工作区 Agent 的上下文圆环）*/}
                    <ContextNoticeBar notice={run?.contextNotice} className="px-3" />
                    {messages.map((msg, index) => (
                      <div key={msg.id} data-message-id={msg.id} className="pb-3">
                        <MessageBubble
                          role={msg.role}
                          parts={msg.parts}
                          streaming={
                            aiStreaming && index === messages.length - 1 && msg.role === 'assistant'
                          }
                          canEdit={!aiStreaming && msg.role === 'user'}
                          editing={editing?.id === msg.id}
                          onEdit={() => startEdit(msg)}
                          canDelete={!aiStreaming}
                          tailCount={messages.length - index}
                          onDelete={() => cid && void deleteTerminalMessagesFrom(cid, msg.id)}
                          pendingConfirm={pendingConfirm}
                          usage={msg.usage}
                          retrying={run?.retrying ?? null}
                        />
                      </div>
                    ))}
                    {aiError && <p className="text-xs text-destructive px-3">{aiError}</p>}
                  </ConversationContent>
                  <ConversationScrollButton />
                </Conversation>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* 列表收起时错误也要可见 */}
      {!showList && aiError && (
        <div className="border-b border-border/60 px-3 py-1 text-xs text-destructive">
          {aiError}
        </div>
      )}

      {/* 折叠态收到待批准：不展开卡片，确认条直接挂在横条上方；
          命令全文完整展示（自动换行、超高时内部滚动），不靠悬停 tooltip 阅读 */}
      {minimized && pendingConfirm && (
        <div className="border-b border-amber-500/30 bg-amber-500/10 px-2 py-1.5">
          <div className="flex items-center gap-2">
            <ShieldCheck className="size-3.5 shrink-0 text-amber-500" />
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-amber-500">
              {TOOL_LABELS[pendingConfirm.toolName] ?? pendingConfirm.toolName}
            </span>
            <Button
              size="small"
              type="primary"
              className="h-6 shrink-0 px-2 text-xs"
              onClick={() => void resolveAiConfirm(pendingConfirm.id, true)}
            >
              执行
            </Button>
            <Button
              size="small"
              className="h-6 shrink-0 px-2 text-xs"
              onClick={() => void resolveAiConfirm(pendingConfirm.id, false)}
            >
              取消
            </Button>
          </div>
          <pre className="mt-1 max-h-24 overflow-y-auto whitespace-pre-wrap break-all rounded bg-secondary/50 px-1.5 py-1 font-mono text-xs leading-4 text-muted-foreground">
            {pendingConfirm.command}
          </pre>
        </div>
      )}

      {/* 横条输入栏（始终显示）：拖拽手柄 · 权限模式图标 · 输入框/状态条 · 展开按钮 · 发送/停止；
          展开态下手柄与展开按钮隐藏（拖拽/收起由卡片头部承担）；
          折叠且会话进行中时输入框让位给一行状态条（Codex「思考中」风格），
          折叠但会话空闲时中央区域直接是输入框，无需先点开；
          权限模式与发送/停止照常可用 */}
      <div
        ref={barRef}
        className="flex h-11 shrink-0 items-center gap-1 px-3"
      >
        {/* 拖拽手柄：展开态随宽度过渡收为 0（拖拽由卡片头部承担），
           -mx-1 抵消父级 gap，收起后不留空隙 */}
        <span
          onPointerDown={startDrag}
          title="拖拽移动"
          className={cn(
            'flex shrink-0 cursor-move touch-none items-center justify-center overflow-hidden rounded text-muted-foreground/50 transition-all duration-200 ease-out hover:text-foreground',
            minimized ? 'w-7 opacity-100' : 'pointer-events-none -mx-1 w-0 opacity-0'
          )}
        >
          <GripVertical className="size-4 shrink-0" />
        </span>
        <Dropdown
          trigger={['click']}
          placement="topLeft"
          open={permMenuOpen}
          onOpenChange={setPermMenuOpen}
          menu={{
            selectable: true,
            selectedKeys: [permissionMode],
            items: PERMISSION_MODES.map((m) => ({
              key: m.value,
              icon: <m.icon className="size-3.5" />,
              label: (
                <span>
                  {m.label}
                  <span className="block text-xs text-muted-foreground">{m.hint}</span>
                </span>
              )
            })),
            onClick: ({ key }) => void setAiPermissionMode(key as AiPermissionMode)
          }}
        >
          <Button
            type="text"
            size="small"
            icon={<PermissionIcon className="size-4" />}
            title={`${permissionMeta.label}：${permissionMeta.hint}（点击切换）`}
            className={cn(
              'shrink-0',
              // 警示色给「全部访问」（不再询问），确认档走中性色 —— 与 Agent 页一致
              permissionMode === 'full' ? 'text-amber-500' : 'text-muted-foreground'
            )}
          />
        </Dropdown>
        {minimized && hasMessages && aiStreaming ? (
          /* 仅折叠且会话进行中才显示：逐行向上滚动的流式日志（点击展开对话）。
             每行按换行切分；只有新增一行（出现换行）时整列上移一次（transform 过渡），
             正在输入的当前行原地更新文本、不重挂载、不淡入，消除逐 token 替换的闪烁；
             单行可见、垂直居中，超长行不省略、改为横向滚动；
             会话未进行时中央区域直接是输入框（见 else 分支），无需先点开 */
          (() => {
            const lines = collapsedText.split('\n')
            const shift = Math.max(0, lines.length - COLLAPSED_VISIBLE)
            return (
              <div
                className="flex h-8 min-w-0 flex-1 cursor-pointer items-center gap-1.5 px-1"
                title="展开对话"
                onClick={() => sessionId && setAiMinimized(sessionId, false)}
              >
                <Loader2 className="size-3.5 shrink-0 animate-spin text-primary" />
                <div
                  className="relative min-w-0 flex-1 overflow-hidden"
                  style={{ height: COLLAPSED_LINE_H * COLLAPSED_VISIBLE }}
                >
                  <div
                    className="transition-transform duration-300 ease-out"
                    style={{ transform: `translateY(-${shift * COLLAPSED_LINE_H}px)` }}
                  >
                    {lines.map((ln, i) => (
                      <ScrollLine key={i} text={ln} />
                    ))}
                  </div>
                </div>
              </div>
            )
          })()
        ) : (
          <Input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && editing) {
                e.preventDefault()
                cancelEdit()
                return
              }
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                e.preventDefault()
                handleSend()
              }
            }}
            placeholder={
              editing
                ? '改完按 Enter 重新发送（会先删除这条及其之后的全部消息）'
                : hasConfig
                  ? activeSession
                    ? `描述你想做的事…（Enter 发送 · 绑定 ${activeSession.title}）`
                    : '描述你想做的事…（Enter 发送）'
                  : '请先在设置中配置模型'
            }
            variant="borderless"
            className="ai-bar-input min-w-0 flex-1 text-[13px]"
          />
        )}
        {/* 展开按钮：与手柄同样的宽度收拉动效，输入区变宽不跳变 */}
        <span
          className={cn(
            'block shrink-0 overflow-hidden transition-all duration-200 ease-out',
            minimized ? 'w-7 opacity-100' : 'pointer-events-none -mx-1 w-0 opacity-0'
          )}
        >
          <Button
            type="text"
            size="small"
            // 箭头指向预示展开方向：横条在上半区时卡片向下展开
            icon={barNearTop ? <ChevronDown className="size-4" /> : <ChevronUp className="size-4" />}
            title="展开对话"
            className="h-7 w-7 p-0 text-muted-foreground"
            onClick={() => sessionId && setAiMinimized(sessionId, false)}
          />
        </span>
        {aiStreaming ? (
          <Button
            type="text"
            danger
            size="small"
            icon={<Square className="size-4" />}
            title="停止"
            className="shrink-0"
            onClick={() => sessionId && void abortTerminal(sessionId)}
          />
        ) : (
          <Button
            type="text"
            size="small"
            icon={<Send className="size-4" />}
            disabled={!input.trim() || !hasConfig || !sessionId || !cid}
            title="发送"
            className="shrink-0"
            onClick={handleSend}
          />
        )}
      </div>

      {/* 缩放热区：四边 + 四角，按「窗口边」语义拖动（拖哪条边哪条边动，对边不动）。
          展开态才有意义，折叠成横条时不显示；平时完全透明不挡视线，
          悬停时在该边/角露出一小段胶囊提示可拖 */}
      {showList &&
        RESIZE_HANDLES.map((h) => (
          <div
            key={h.dir}
            onPointerDown={(e) => startResize(e, h.dir)}
            title="拖动调整大小"
            className={cn(
              'group/resize absolute z-10 flex touch-none items-center justify-center',
              h.cls
            )}
          >
            <span
              className={cn(
                'rounded-full bg-transparent transition-colors group-hover/resize:bg-primary/60',
                h.indicator
              )}
            />
          </div>
        ))}
    </aside>
  )
}
