import { AiMarkdown } from '@/features/agent/AiMarkdown'
import { MessageCopyButton } from '@/features/agent/MessageCopyButton'
import { Button, Dropdown, Input, Select } from 'antd'
import { useAppStore } from '@/stores/app-store'
import { cn } from 'cn'
import type {
  AiChatMessage,
  AiConfirmRequest,
  AiMessagePart,
  AiPermissionMode
} from '@shared/types'
import {
  ArrowDown,
  Ban,
  Check,
  ChevronDown,
  ChevronUp,
  Eraser,
  GripVertical,
  Loader2,
  Send,
  Settings2,
  ShieldCheck,
  Sparkles,
  Square,
  Terminal,
  X
} from 'lucide-react'
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent
} from 'react'

const TOOL_LABELS: Record<string, string> = {
  run_in_terminal: '执行终端命令',
  send_keys: '发送按键',
  read_terminal_output: '读取终端输出',
  list_terminal_sessions: '查看终端列表'
}

const PERMISSION_MODES: Array<{
  value: AiPermissionMode
  label: string
  icon: typeof ShieldCheck
  hint: string
}> = [
    {
      value: 'full',
      label: '完全访问',
      icon: Terminal,
      hint: 'AI 可直接执行终端命令，无需逐条确认'
    },
    {
      value: 'confirm',
      label: '确认模式',
      icon: ShieldCheck,
      hint: 'AI 执行每条终端命令前都需要你确认，可随时取消'
    }
  ]

type ToolCallPart = Extract<AiMessagePart, { type: 'tool-call' }>
type ToolResultPart = Extract<AiMessagePart, { type: 'tool-result' }>

/** 工具渲染单元：一次调用及其结果合为一处展示 */
interface ToolUnit {
  kind: 'tool'
  call: ToolCallPart
  result?: ToolResultPart
}

type RenderUnit = ToolUnit | { kind: 'text'; text: string }

/** 把消息 parts 整理为渲染单元：文本独立成块；tool-call 与对应 tool-result 按 toolCallId 合并 */
function buildRenderUnits(parts: AiMessagePart[]): RenderUnit[] {
  const units: RenderUnit[] = []
  const toolsById = new Map<string, ToolUnit>()
  for (const part of parts) {
    if (part.type === 'text') {
      units.push({ kind: 'text', text: part.text })
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

/** 工具调用状态：待批准（确认模式等待用户）/ 调用中 / 已完成 / 失败 / 已取消 */
type ToolStatus = 'pending' | 'running' | 'done' | 'error' | 'cancelled'

const TOOL_STATUS_META: Record<
  ToolStatus,
  { label: string; icon: typeof Loader2; cls: string; spin?: boolean }
> = {
  pending: { label: '待批准', icon: ShieldCheck, cls: 'text-amber-500' },
  running: { label: '调用中', icon: Loader2, cls: 'text-muted-foreground', spin: true },
  done: { label: '已完成', icon: Check, cls: 'text-green-500' },
  error: { label: '失败', icon: X, cls: 'text-destructive' },
  cancelled: { label: '已取消', icon: Ban, cls: 'text-muted-foreground' }
}

/** 工具调用卡片：参数与结果同卡展示，头部带状态；待批准时确认按钮就在卡内 */
function ToolPartCard({
  unit,
  streaming,
  pendingConfirm
}: {
  unit: ToolUnit
  streaming: boolean
  pendingConfirm: AiConfirmRequest | null
}) {
  const resolveAiConfirm = useAppStore((s) => s.resolveAiConfirm)
  const { call, result } = unit
  // 本工具对应的待批准确认（确认模式下）
  const confirm = pendingConfirm?.toolCallId === call.toolCallId ? pendingConfirm : null
  const status: ToolStatus = confirm
    ? 'pending'
    : result
      ? result.isError
        ? 'error'
        : 'done'
      : streaming
        ? 'running'
        : 'cancelled'
  const meta = TOOL_STATUS_META[status]
  const StatusIcon = meta.icon
  const label = TOOL_LABELS[call.toolName] ?? call.toolName
  const inputText = call.input ? JSON.stringify(call.input, null, 1) : ''
  const outputText =
    typeof result?.output === 'string'
      ? result.output.slice(0, 1500)
      : result?.output
        ? JSON.stringify(result.output).slice(0, 1500)
        : ''

  return (
    <details className="my-1.5 rounded-md text-xs" open={!!confirm}>
      <summary className="flex cursor-pointer items-center gap-1.5 px-2 py-1.5 text-muted-foreground hover:text-foreground">
        <StatusIcon
          className={cn('size-3.5 shrink-0', meta.cls, meta.spin && 'animate-spin')}
        />
        <span className={cn('shrink-0 font-medium', meta.cls)}>{meta.label}</span>
        <span className="shrink-0 text-muted-foreground/50">·</span>
        <span className="shrink-0 font-medium">{label}</span>
        {inputText && (
          <span className="min-w-0 flex-1 truncate font-mono text-[10px]">
            {inputText.replace(/\s+/g, ' ').slice(0, 80)}
          </span>
        )}
      </summary>
      <div className="border-t border-border/70 px-2 py-1.5">
        {inputText && (
          <pre className="mb-1 overflow-x-auto whitespace-pre-wrap font-mono text-[10px] text-muted-foreground">
            {inputText}
          </pre>
        )}
        {outputText && (
          <pre
            className={cn(
              'max-h-64 overflow-auto whitespace-pre-wrap font-mono text-[10px]',
              result?.isError && 'text-destructive'
            )}
          >
            {outputText}
          </pre>
        )}
        {confirm && (
          <div className="mt-2 flex gap-2">
            <Button
              size="small"
              type="primary"
              className="h-7 flex-1 text-xs"
              onClick={() => void resolveAiConfirm(confirm.id, true)}
            >
              执行
            </Button>
            <Button
              size="small"
              className="h-7 flex-1 text-xs"
              onClick={() => void resolveAiConfirm(confirm.id, false)}
            >
              取消
            </Button>
          </div>
        )}
      </div>
    </details>
  )
}

function MessageBubble({
  role,
  parts,
  streaming,
  pendingConfirm
}: {
  role: 'user' | 'assistant'
  parts: AiMessagePart[]
  streaming?: boolean
  pendingConfirm: AiConfirmRequest | null
}) {
  if (role === 'user') {
    const text = parts
      .filter((p) => p.type === 'text')
      .map((p) => (p.type === 'text' ? p.text : ''))
      .join('')
    return (
      <div className="flex flex-col items-end gap-1">
        {/* 选中态用半透明白：主色底 + 白字下，浏览器的默认蓝色选区会把字压得看不清 */}
        <div className="max-w-[85%] selection:bg-white/25 whitespace-pre-wrap rounded-lg rounded-br-sm bg-primary px-3 py-2 text-[13px] text-white">
          {text}
        </div>
        <MessageCopyButton text={text} />
      </div>
    )
  }

  // 工具调用与结果合并成单张卡片展示
  const units = buildRenderUnits(parts)
  // 复制的是 Markdown 源码（跳过工具卡片，文本段之间以空行衔接）
  const rawText = parts
    .filter((p) => p.type === 'text')
    .map((p) => (p.type === 'text' ? p.text : ''))
    .join('\n\n')
    .trim()

  return (
    <div className="space-y-1">
      {units.map((unit, i) =>
        unit.kind === 'text' ? (
          <div key={i} className="px-3 py-2">
            <AiMarkdown content={unit.text} />
            {streaming && i === units.length - 1 && (
              <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse bg-primary align-middle" />
            )}
          </div>
        ) : (
          <ToolPartCard
            key={i}
            unit={unit}
            streaming={!!streaming}
            pendingConfirm={pendingConfirm}
          />
        )
      )}
      {units.length === 0 && streaming && (
        <div className="flex items-center gap-2 rounded-lg px-3 py-2 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" /> 思考中...
        </div>
      )}
      {/* 消息下方：复制原始 Markdown（生成中内容还在变，一轮结束再显示） */}
      {!streaming && (
        <div className="px-3">
          <MessageCopyButton text={rawText} title="复制原文（Markdown）" />
        </div>
      )}
    </div>
  )
}

/** 稳定的空消息数组：避免每次渲染新引用导致滚动 effect 误触发 */
const NO_MESSAGES: AiChatMessage[] = []

/** 折叠状态条文本：取最后一条消息的最新一段（流式增长时取尾部，呈现「闪过」效果） */
function buildCollapsedLine(messages: AiChatMessage[]): string {
  const last = messages[messages.length - 1]
  if (!last) return ''
  let line = ''
  for (const p of last.parts) {
    if (p.type === 'text' && p.text.trim()) line = p.text.trim()
    else if (p.type === 'tool-call') line = `⚙ ${TOOL_LABELS[p.toolName] ?? p.toolName}`
    else if (p.type === 'tool-result' && p.isError) {
      line = `⚠ ${TOOL_LABELS[p.toolName] ?? p.toolName}失败`
    }
  }
  const flat = line.replace(/\s+/g, ' ')
  if (last.role === 'user') return flat ? `你：${flat}` : ''
  // AI 消息还没吐出文字（含工具执行中）：对齐 Codex 的思考态文案
  if (!flat) return '思考中…'
  // 取尾部而不是一行开头：流式增长时看起来像文字在往下闪过
  return flat.length > 100 ? `…${flat.slice(-100)}` : `AI：${flat}`
}

/** 浮窗容器与面板组内容区的边距下限（px） */
const FLOAT_MARGIN = 8

/** 浮窗默认离容器底部的距离（px） */
const DEFAULT_BOTTOM = 24

/** 横条输入栏固定高度（px）：py-1.5×2 + 内容 h-8，锚点翻转/拖拽钳制都以此为准 */
const BAR_HEIGHT = 44

/** 浮窗展开时的最小高度（px）：输入横条 + 至少能看到一小段消息区 */
const MIN_PANEL_HEIGHT = 180

/** 浮窗最小宽度（px）：卡片头部一排控件挤得下即可 */
const MIN_PANEL_WIDTH = 260

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
 * 浮在终端之上的 AI 助手浮窗：展示并驱动 sessionId 所属会话的独立对话。
 *
 * 平时只是终端底部居中的一条横式输入栏（拖拽手柄 + 权限模式图标 + 输入框 + 发送）；
 * 发送后向上展开消息列表卡片，卡片头部可最小化 —— 最小化后只留一行状态条，
 * 最新对话内容像 Codex「思考中」那样逐行替换闪过。整体可拖拽移动（位置存 store，各终端共享）。
 *
 * AI 助手属于**终端页面**（终端标签 = 一个会话）：每个终端页面一个实例，
 * 对话（`aiChats`）、开关（`ui.aiOpenSessions`）与最小化（`ui.aiMinimizedSessions`）
 * 都按会话隔离，互不影响。
 */
export function AiPanel({ sessionId }: { sessionId: string | null }) {
  const aiConfigs = useAppStore((s) => s.aiConfigs)
  const aiSettings = useAppStore((s) => s.aiSettings)
  const sessions = useAppStore((s) => s.sessions)
  const activeSession = sessions.find((s) => s.id === sessionId)
  // 每个终端会话一个独立的 AI 对话：面板展示所属会话的上下文
  const chat = useAppStore((s) => (sessionId ? s.aiChats[sessionId] : undefined))
  const messages = chat?.messages ?? NO_MESSAGES
  const aiStreaming = chat?.streaming ?? false
  const aiError = chat?.error ?? null
  // 本会话待批准的确认请求：多实例下各会话独立，显示在对应工具卡内
  const pendingConfirm = useAppStore((s) => {
    for (const c of Object.values(s.pendingConfirms)) {
      if (c.sessionId === sessionId) return c
    }
    return null
  })
  const sendAiMessage = useAppStore((s) => s.sendAiMessage)
  const abortAi = useAppStore((s) => s.abortAi)
  const clearAiMessages = useAppStore((s) => s.clearAiMessages)
  const setActiveAiConfig = useAppStore((s) => s.setActiveAiConfig)
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
  // 弹层展开状态受控：antd 的下拉 portal 在 body 上，拖浮窗时不会跟随，
  // 会在原地悬空错位 —— 拖拽开始就把它们收起
  const [modelSelectOpen, setModelSelectOpen] = useState(false)
  const [permMenuOpen, setPermMenuOpen] = useState(false)
  const rootRef = useRef<HTMLElement>(null)
  const barRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
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
  // 是否跟随底部：用户上翻阅读历史时暂停自动跟随，避免被强制拉回底部
  const nearBottomRef = useRef(true)
  const prevScrollTopRef = useRef(0)
  const [showJump, setShowJump] = useState(false)

  const handleListScroll = () => {
    const el = scrollRef.current
    if (!el) return
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight
    // 只要发生向上的滚动即视为用户要阅读历史，立即暂停跟随；
    // 滚回底部附近（48px 内）才恢复——避免流式输出和滚动互抢位置
    if (el.scrollTop < prevScrollTopRef.current - 2) {
      nearBottomRef.current = false
    } else if (distance < 48) {
      nearBottomRef.current = true
    }
    prevScrollTopRef.current = el.scrollTop
    setShowJump(distance > 48)
  }

  const jumpToBottom = () => {
    const el = scrollRef.current
    if (!el) return
    nearBottomRef.current = true
    el.scrollTop = el.scrollHeight
    setShowJump(false)
  }

  // Chromium 的滚动锚定（scroll anchoring）在流式内容增长/markdown 重排时会错误修正
  // 滚动位置，造成偶发跳顶、干扰手动滚动；容器上已用 overflow-anchor:none 关闭，
  // 由这里显式管理。useLayoutEffect 在绘制前执行，避免「先画到中间再跳到底」的闪动。
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el && nearBottomRef.current) el.scrollTop = el.scrollHeight
  }, [messages, aiStreaming, minimized])

  const hasConfig = Boolean(aiSettings.activeConfigId) && aiConfigs.length > 0
  const permissionMode: AiPermissionMode =
    aiSettings.permissionMode === 'confirm' ? 'confirm' : 'full'
  const permissionMeta =
    PERMISSION_MODES.find((m) => m.value === permissionMode) ?? PERMISSION_MODES[1]
  const PermissionIcon = permissionMeta.icon
  const hasMessages = messages.length > 0 || aiStreaming
  const showList = !minimized
  const collapsedLine = buildCollapsedLine(messages)

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
    if (target.closest('button, input, textarea, .ant-select')) return
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

  const handleSend = () => {
    if (!input.trim() || aiStreaming || !sessionId) return
    // 用户刚发出新消息：无论当前在哪个位置都跟随到底部，并向上展开消息列表
    nearBottomRef.current = true
    setAiMinimized(sessionId, false)
    void sendAiMessage(input, sessionId)
    setInput('')
  }

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
        {/* 卡片内容：撑满折叠容器，头 + 消息区 + 横条自上而下排布 */}
        <div className="flex h-full min-h-0 flex-col">
          {/* 卡片头部：拖拽手柄 + 模型选择 + 操作（整行可拖动） */}
          <div
            onPointerDown={startDrag}
            className="flex h-10 shrink-0 cursor-move touch-none items-center gap-1 border-b border-border/70 bg-sidebar/40 px-2"
          >
            <GripVertical className="size-3.5 shrink-0 text-muted-foreground/50" />
            <Sparkles className="size-4 shrink-0 text-primary" />
            <Select
              size="small"
              variant="borderless"
              className="min-w-0 flex-1"
              value={
                aiConfigs.some((c) => c.id === aiSettings.activeConfigId)
                  ? aiSettings.activeConfigId
                  : undefined
              }
              onChange={(v) => void setActiveAiConfig(v)}
              placeholder="请选择模型"
              popupMatchSelectWidth={false}
              open={modelSelectOpen}
              onOpenChange={setModelSelectOpen}
              options={aiConfigs.map((c) => ({ value: c.id, label: `${c.name}（${c.model}）` }))}
            />
            <Button
              type="text"
              icon={<Eraser className="size-3.5" />}
              className="h-7 w-7 shrink-0 p-0 text-muted-foreground"
              title="清空对话"
              onClick={() => sessionId && clearAiMessages(sessionId)}
            />
            <Button
              type="text"
              icon={<Settings2 className="size-3.5" />}
              className="h-7 w-7 shrink-0 p-0 text-muted-foreground"
              title="AI 设置"
              onClick={() => setSettingsOpen(true, 'ai')}
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

          {/* 消息区：占满卡片剩余高度并在内部滚动（高度固定，不随消息多少伸缩），
              AI 回复属于「内容」，保持可选中复制 */}
          <div className="relative min-h-0 flex-1">
            <div
              ref={scrollRef}
              onScroll={handleListScroll}
              className="h-full overflow-y-auto select-text"
              style={{ overflowAnchor: 'none' }}
            >
              <div className="flex min-h-full flex-col space-y-3 p-3">
                {messages.length === 0 && (
                  <div className="flex flex-1 flex-col items-center justify-center gap-3 py-6 text-center text-muted-foreground">
                    <Sparkles className="size-8 text-primary/40" />
                    {activeSession ? (
                      <div className="space-y-1 text-sm leading-5">
                        <p>试试：查看当前目录下占用空间最大的文件</p>
                        <p>试试：诊断 nginx 为什么启动失败</p>
                      </div>
                    ) : (
                      <div className="space-y-1 text-xs leading-5">
                        <p>打开一个终端会话后开始对话</p>
                        <p>每个终端都有独立、互不影响的 AI 上下文</p>
                      </div>
                    )}
                    {!hasConfig && (
                      <Button
                        size="small"
                        variant="filled"
                        className="mt-2"
                        onClick={() => setSettingsOpen(true, 'ai')}
                      >
                        先去配置模型
                      </Button>
                    )}
                  </div>
                )}
                {messages.map((msg, i) => (
                  <MessageBubble
                    key={msg.id}
                    role={msg.role}
                    parts={msg.parts}
                    streaming={aiStreaming && i === messages.length - 1 && msg.role === 'assistant'}
                    pendingConfirm={pendingConfirm}
                  />
                ))}
                {aiError && <p className="text-xs text-destructive px-3">{aiError}</p>}
              </div>
            </div>
            {/* 不在底部时显示：一键滚动到底部 */}
            {showJump && (
              <button
                type="button"
                onClick={jumpToBottom}
                title="滚动到底部"
                className="absolute bottom-3 left-1/2 flex size-8 -translate-x-1/2 items-center justify-center rounded-full border border-border bg-background text-muted-foreground shadow-md transition-colors hover:bg-secondary hover:text-foreground"
              >
                <ArrowDown className="size-4" />
              </button>
            )}
          </div>
        </div>
      </div>

      {/* 列表收起时错误也要可见 */}
      {!showList && aiError && (
        <div className="border-b border-border/60 px-3 py-1 text-[11px] text-destructive">
          {aiError}
        </div>
      )}

      {/* 折叠态收到待批准：不展开卡片，确认条直接挂在横条上方；
          命令全文完整展示（自动换行、超高时内部滚动），不靠悬停 tooltip 阅读 */}
      {minimized && pendingConfirm && (
        <div className="border-b border-amber-500/30 bg-amber-500/10 px-2 py-1.5">
          <div className="flex items-center gap-2">
            <ShieldCheck className="size-3.5 shrink-0 text-amber-500" />
            <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-amber-500">
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
          <pre className="mt-1 max-h-24 overflow-y-auto whitespace-pre-wrap break-all rounded bg-secondary/50 px-1.5 py-1 font-mono text-[11px] leading-4 text-muted-foreground">
            {pendingConfirm.command}
          </pre>
        </div>
      )}

      {/* 横条输入栏（始终显示）：拖拽手柄 · 权限模式图标 · 输入框/状态条 · 展开按钮 · 发送/停止；
          展开态下手柄与展开按钮隐藏（拖拽/收起由卡片头部承担）；
          折叠且有对话时仅输入框让位给一行状态条（Codex「思考中」风格），
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
                  <span className="block text-[10px] text-muted-foreground">{m.hint}</span>
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
              permissionMode === 'full' ? 'text-muted-foreground' : 'text-amber-500'
            )}
          />
        </Dropdown>
        {minimized && hasMessages ? (
          /* 折叠态的输入框位置：一行最新对话内容闪过，点击展开对话；
             h-8 对齐 antd 输入框默认高度（32px），两种中心内容切换时条高不变 */
          <div
            className="flex h-8 min-w-0 flex-1 cursor-pointer items-center gap-1.5 px-1"
            title="展开对话"
            onClick={() => sessionId && setAiMinimized(sessionId, false)}
          >
            {aiStreaming && (
              <Loader2 className="size-3.5 shrink-0 animate-spin text-primary" />
            )}
            {/* key=文本：每次替换重新触发淡入上移动画，制造「闪过」感 */}
            <div
              key={collapsedLine}
              className="ai-line min-w-0 flex-1 truncate text-[12px] text-muted-foreground"
            >
              {collapsedLine}
            </div>
          </div>
        ) : (
          <Input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                e.preventDefault()
                handleSend()
              }
            }}
            placeholder={
              hasConfig
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
            onClick={() => sessionId && void abortAi(sessionId)}
          />
        ) : (
          <Button
            type="text"
            size="small"
            icon={<Send className="size-4" />}
            disabled={!input.trim() || !hasConfig || !sessionId}
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
