import { AgentFilesPanel } from '@/features/agent/AgentFilesPanel'
import { AiMarkdown } from '@/features/agent/AiMarkdown'
import { GitPanel } from '@/features/agent/GitPanel'
import { AskFollowupCard } from '@/features/agent/AskFollowupCard'
import { MessageCopyButton } from '@/features/agent/MessageCopyButton'
import { MessageOutline } from '@/features/agent/MessageOutline'
import { MessageDeleteButton } from '@/features/agent/MessageDeleteButton'
import { MessageEditButton } from '@/features/agent/MessageEditButton'
import { ReasoningPanel } from '@/features/agent/ReasoningPanel'
import { TOOL_LABELS, ToolCallRow, toolRunStatus } from '@/features/agent/ToolCallRow'
import { findTailStart, TurnFold, turnStepSummary } from '@/features/agent/turn-fold'
import { TokenUsageRow } from '@/features/agent/TokenUsageRow'
import { TypingDots } from '@/features/agent/TypingDots'
import { WorkspaceQuickActions } from '@/features/agent/WorkspaceQuickActions'
import { VirtualMessageList, type VirtualMessageListHandle } from '@/features/agent/VirtualMessageList'
import { SidePanel, type SidePanelTab } from '@/features/agent/SidePanel'
import { configModels, hasUsableConfig, modelNameOnly } from '@/features/agent/model-options'
import { McpConfigPopover } from '@/features/agent/McpConfigPopover'
import { BrowserPane } from '@/features/automation/BrowserPane'
import { TerminalView } from '@/features/terminal/TerminalView'
import { useAppStore } from '@/stores/app-store'
import { ASK_FOLLOWUP_TOOL } from '@shared/ask-followup'
import { DEFAULT_BROWSER_VIEWPORT, agentBrowserSessionId } from '@shared/browser'
import type {
  AgentChatMessage,
  AgentConfirmRequest,
  AgentMessagePart,
  AiPermissionMode,
  BrowserViewportMode,
  IdeInfo,
  OpenResult,
  SessionInfo,
  ShellProfile
} from '@shared/types'
import type { MenuProps } from 'antd'
import { Button, Dropdown, Input, Select, Tooltip, message } from 'antd'
import { cn } from 'cn'
import {
  Ban,
  Bot,
  Check,
  ChevronDown,
  Code2,
  Files,
  FolderOpen,
  GitBranch,
  Globe,
  PanelRightClose,
  PanelRightOpen,
  Pencil,
  Send,
  Settings,
  ShieldAlert,
  ShieldCheck,
  Square,
  SquareTerminal,
  Terminal,
  X
} from 'lucide-react'
import {
  type ComponentRef,
  type ReactNode,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState
} from 'react'

/** 模型下拉里 ACP 后端的特殊选项值 */
const ACP_OPTION = '__acp__'
const ACP_MANAGE_OPTION = '__acp-manage__'

/**
 * 命令执行权限模式（与终端 AI 助手同一份配置 aiSettings.permissionMode）。
 *
 * 图标与配色对齐 fishwork：**放开的档给警示色**（全部访问 = 盾牌带感叹号 + 琥珀），
 * 确认档用普通盾牌 —— 别让「已经全放开」这件事悄无声息地开着。
 * 横条上只显示图标（文案在下拉项里），所以 `hint` 同时也是图标的悬停提示。
 */
const AGENT_PERMISSION_MODES: Array<{
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
 * 只在「需确认」模式下出现：Agent 执行命令 / 写入 / 编辑 / 删除这些**会改动东西**的
 * 操作前先请示，用户点了允许才真正执行。文案里带上工作区名，避免误批到别的目录。
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
function MessageBubbleImpl({
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
            'max-w-[85%] selection:bg-white/25 whitespace-pre-wrap rounded-lg rounded-br-sm bg-primary px-3 py-2 text-[15px] text-white break-all',
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

  // 一轮已完成（助手消息、且不是正在流式、且没有待回答的追问卡）：把「末尾连续正文之前」的过程
  // 收进一个折叠组，只留最终回答可见；与 fishwork 的 TurnStepGroup 等价。
  // 待回答的追问卡不能折进去 —— 否则那张需要用户作答的交互卡被藏住（fishwork 也是这个处理）。
  const followupRequests = useAppStore((s) => s.followupRequests)
  const hasPendingFollowup = units.some(
    (u) => u.kind === 'tool' && u.call.toolName === ASK_FOLLOWUP_TOOL && !!followupRequests[u.call.toolCallId]
  )
  const turnDone = message.role === 'assistant' && !streaming && !hasPendingFollowup
  const tailStart = turnDone ? findTailStart(units) : 0
  const foldedUnits = tailStart > 0 ? units.slice(0, tailStart) : null

  const renderUnit = (unit: RenderUnit, i: number): ReactNode => {
    if (unit.kind === 'text') {
      return (
        <div key={i}>
          <AiMarkdown content={unit.text} />
        </div>
      )
    }
    if (unit.kind === 'reasoning') {
      return (
        <ReasoningPanel
          key={i}
          text={unit.text}
          streaming={!!streaming && i === units.length - 1}
        />
      )
    }
    if (unit.call.toolName === ASK_FOLLOWUP_TOOL) {
      // 提问工具：待回答时是一张可交互的卡片，答完收成一条横条
      return (
        <AskFollowupCard
          key={i}
          toolCallId={unit.call.toolCallId}
          input={unit.call.input}
          output={unit.result?.output}
          isError={unit.result?.isError}
          streaming={streaming}
        />
      )
    }
    return (
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
  }

  return (
    <div data-message-id={message.id} className="group/msg space-y-5">
      {foldedUnits && (
        <TurnFold summary={turnStepSummary(foldedUnits)}>
          {foldedUnits.map((unit, k) => renderUnit(unit, k))}
        </TurnFold>
      )}
      {units.slice(tailStart).map((unit, k) => renderUnit(unit, tailStart + k))}
      {message.usage && <TokenUsageRow usage={message.usage} />}
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

/** 记忆化：流式期间每个 token 都会触发整个列表重渲染，历史消息的 props
 *  （message 引用 / 布尔 / 数值 / pendingConfirm 引用）全部不变，直接跳过 ——
 *  只有正在生成的那条重渲染。滚动过程里的 setState（回底按钮）也不再掀起
 *  可见消息的全量重渲染。 */
const MessageBubble = memo(MessageBubbleImpl)

/** 稳定的空消息数组：避免每次渲染新引用导致滚动 effect 误触发 */
const NO_MESSAGES: AgentChatMessage[] = []

/**
 * 右侧多标签面板的标签 key。
 *
 * 浏览器 / 文件 / 源码管理是固定 key；**终端一个会话一个 key**（`terminal:<sessionId>`），
 * 所以终端天然支持多开。以后要加「日志 / 预览」之类的视图，加一个 key、往 `sideTabs`
 * 里补一条描述即可 —— 面板本身（`SidePanel`）不认识任何具体内容。
 */
type SideTabKey = 'browser' | 'files' | 'git' | `terminal:${string}`

/**
 * 标签在「打开顺序」里的位次。
 *
 * 不在表里的（理论上只在顺序表同步前的那一瞬出现）一律排到最后 ——
 * `Array.prototype.sort` 是稳定的，所以它们仍保持 `sideTabs` 里的相对顺序。
 */
function tabRank(order: string[], key: string): number {
  const i = order.indexOf(key)
  return i === -1 ? Number.MAX_SAFE_INTEGER : i
}

/** 一个终端标签：会话 + 打开时的工作区目录 + 用的哪个 shell */
interface TerminalTab {
  /** 标签 key 用（= 会话 id，稳定且唯一） */
  id: string
  session: SessionInfo
  /** 打开时的目录（「执行命令」按它复用终端） */
  path: string
  shellId?: string
  /** 标签短名（终端 / 终端 2 …） */
  label: string
}

/**
 * Agent 会话的界面：类 Claude Code 的工作区编程助手。
 * 上方是对话流（文本 + 工具卡），底部大输入框，Enter 发送 / Shift+Enter 换行。
 * 对话绑定会话所属的工作区，工具（读写文件 / 搜索 / 执行命令）只能作用于该目录。
 *
 * **入参只有 `conversationId`（画哪个会话）与 `visible`（这一页当前显示着没有）**，
 * 不读 store 里的「当前选中」指针 —— 那是侧边栏的选中态，多标签并存时它只能指向其中一个。
 * 因此它可以同时挂在多处（PanelView 里一个会话一个标签、甚至分屏并排）而互不串台。
 * 「标签什么时候出现在 PanelView 里」由侧边栏点击（`selectAgentConversation`）决定，
 * 这里只负责「给定一个会话，把它画出来」。
 *
 * `visible` 目前只有一个用途：切到这个标签时**在绘制之前**量一次内容区宽度（见 `contentWidth`），
 * 否则首帧会先用兜底宽度画、下一帧才纠正，看着就是「面板宽度闪一下」。
 */
export function AgentPage({
  conversationId,
  visible = true
}: {
  conversationId: string | null
  /** 这一页当前是不是显示着（非活动的会话标签被 display:none 藏着）；缺省按显示处理 */
  visible?: boolean
}) {
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
  // 非 ACP 模型默认走内置的 Mastra agent（复用同一套模型配置与工具）；
  // 旧会话若存的是 'ai-sdk' 仍按 ai-sdk 路径执行，不强制迁移。
  const backend = conversation?.backend ?? active?.backend ?? 'mastra'
  // ACP 后端无需模型配置（agent 自带模型），只需有可用的预置配置
  const activeAcp =
    (backend === 'acp' ? acpAgents.find((a) => a.id === ownChoice) : undefined) ??
    acpAgents.find((a) => a.id === aiSettings.activeAcpId) ??
    acpAgents[0]
  /** 本会话实际使用的模型配置：会话自己的选择优先，回退到设置里的默认模型。
   *  参与回退的配置必须**有可用模型**（models 被删空的配置跳过，否则下拉会出
   *  undefined 项、请求也解析不出模型） */
  const usable = (id?: string | null): string | undefined =>
    backend !== 'acp' && hasUsableConfig(aiConfigs, id) ? (id ?? undefined) : undefined
  const effectiveConfigId = usable(ownChoice) ?? usable(aiSettings.activeConfigId)
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
  // 消息流的滚动定位（吸底跟随 / 发送回底 / 回底按钮）都在 VirtualMessageList 内部管理
  const listRef = useRef<VirtualMessageListHandle>(null)

  /** 消息目录点击：把那条消息滚到可视区顶部（虚拟列表按下标定位，未渲染的消息也能跳） */
  const jumpToMessage = (messageId: string): void => {
    listRef.current?.scrollToMessage(messageId)
  }

  // ------------- 右侧多标签面板：标签的存在性 / 活动标签（宽度由 SidePanel 自持） -------------
  /**
   * 面板的活动标签（`null` = 面板收起）。所有标签都由下面的 `sideTabs` 描述。
   *
   * 收起面板**不关任何东西**：浏览器会话的生命周期归 Agent 的 browser_close 工具，
   * 终端 / 文件 / 源码管理各自由标签上的 × 关闭 —— 收起只是把画面裁掉。
   * 反过来，关标签也**不收起面板**：标签条上还有别的标签就切过去，空了才收起
   * （四个 close*Tab 共用一个判据，见 fallbackSideTab）。
   */
  const [sideTab, setSideTab] = useState<SideTabKey | null>(null)
  /** 订阅回调里要读当前标签（闭包会锁住旧值），渲染期同步一次 */
  const sideTabRef = useRef<SideTabKey | null>(null)
  sideTabRef.current = sideTab
  /** 最近看过的标签：收起后（活动标签置 null）仍记得，供顶栏「门」按钮恢复 */
  const lastSideTabRef = useRef<SideTabKey>('browser')
  if (sideTab !== null) lastSideTabRef.current = sideTab

  /** 浏览器标签是否存在。关掉它 = 连同浏览器会话一起销毁（见 closeBrowserTab） */
  const [browserTabOpen, setBrowserTabOpen] = useState(false)
  /** 订阅回调里要读「标签条上有没有浏览器标签」（闭包会锁住旧值），渲染期同步一次 */
  const browserTabOpenRef = useRef(false)
  browserTabOpenRef.current = browserTabOpen
  /** 浏览器视口预设（PC / 手机）—— 由本页持有并传给面板里的 BrowserPane */
  const [browserMode, setBrowserMode] = useState<BrowserViewportMode>(DEFAULT_BROWSER_VIEWPORT)

  /** 文件视图 / 源码管理标签是否存在（内容跟着当前工作区走） */
  const [filesTabOpen, setFilesTabOpen] = useState(false)
  const [gitTabOpen, setGitTabOpen] = useState(false)
  const [gitCount, setGitCount] = useState(0)
  /**
   * 切工作区 / 打开源码管理标签时刷新 badge 计数。
   * 不用 setInterval 轮询：会话里执行 git 命令后 GitPanel 自己会刷新；这里只负责
   * 进入工作区或打开标签时给个最新数字。
   */
  useEffect(() => {
    if (!active) {
      setGitCount(0)
      return
    }
    let cancelled = false
    void window.api.git
      .status(active.path)
      .then((s) => {
        if (cancelled) return
        setGitCount(s.isRepo ? s.changes.length : 0)
      })
      .catch(() => { })
    return () => {
      cancelled = true
    }
  }, [active?.path, gitTabOpen])

  /** 内容区（对话 + 右侧面板）实测宽度：面板宽度上限按它算 */
  const contentRef = useRef<HTMLDivElement | null>(null)
  /**
   * 内容区实测宽度（0 = 还没量到，退回容器比例兜底）。
   *
   * 必须跟着尺寸变化走：分屏、拖侧边栏、切标签都会改变它，而面板宽度上限是按它算的 ——
   * 只在挂载时算一次的话，容器变窄后面板会顶出分屏之外被裁。
   */
  const [contentWidth, setContentWidth] = useState(0)
  useEffect(() => {
    const el = contentRef.current
    if (!el) return
    const sync = (): void => {
      const w = el.clientWidth
      // **0 不是「容器变窄了」，是「这一段被藏起来了」**：非活动的会话标签是 display:none
      // （见 PanelView 的 hidden），此时量到 0。把它记下来 = 面板宽度按兜底容器算错，
      // 切回来才纠正 —— 那一错一纠就是「面板宽度闪一下」。所以 0 一律跳过，保留上次的实测值。
      if (w > 0) setContentWidth(w)
    }
    sync()
    const ro = new ResizeObserver(sync)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  /**
   * **刚切到可见的那一帧**就同步量一次 —— layout effect 里的更新会在浏览器绘制前落定。
   *
   * 光有上面那个 ResizeObserver 不够：它的回调**晚于首次绘制**。会话标签切过来时这一页
   * 刚从 `display:none` 里出来，首帧只能拿兜底宽度画，下一帧 RO 才把真实宽度补上 ——
   * 看到的就是「面板宽度闪一下」（面板拖到最宽时最明显）。这里量的是同一根元素、同一个值，
   * 只是把时机提到绘制之前。
   *
   * 依赖只有 `visible`：只在「显示状态变了」时量一次，刻意不做成每次渲染都读 clientWidth
   * （那是强制同步布局，消息流式刷新时会白烧性能）。
   */
  useLayoutEffect(() => {
    if (!visible) return
    const w = contentRef.current?.clientWidth ?? 0
    if (w > 0) setContentWidth(w)
  }, [visible])

  // ------------- 终端：一个会话一个标签（支持多开） -------------
  const [terms, setTerms] = useState<TerminalTab[]>([])
  /** 终端标签序号，只增不减 —— 标签名「终端 / 终端 2 / 终端 3 …」用它 */
  const termSeqRef = useRef(0)

  /**
   * 关掉某个标签后，面板切到哪儿（`null` = 收起面板）。
   *
   * 判据只有一条：**标签条上还有没有别的标签** —— 有就切过去，一个都不剩才收起面板。
   * （以前四个标签各写各的兜底、且各只认自己记住的那一个：关浏览器标签时终端 / 文件 /
   * 源码管理还在也照样把面板收掉，用户实测反馈过。）
   *
   * 优先级：最后一个终端 → 浏览器 → 文件 → 源码管理。后两个与 `sideTabs` 一样，
   * 要求当前工作区在（没有工作区时它们不挂在标签条上）。
   */
  const fallbackSideTab = useCallback(
    (closing: SideTabKey): SideTabKey | null => {
      const rest = terms.filter((t) => `terminal:${t.id}` !== closing)
      if (rest.length > 0) return `terminal:${rest[rest.length - 1].id}`
      if (closing !== 'browser' && conversationId && browserTabOpen) return 'browser'
      if (closing !== 'files' && active && filesTabOpen) return 'files'
      if (closing !== 'git' && active && gitTabOpen) return 'git'
      return null
    },
    [conversationId, terms, browserTabOpen, filesTabOpen, gitTabOpen, active]
  )

  /**
   * 关掉一个终端标签：杀掉会话并摘掉标签。
   * 关掉的正是当前标签就把面板切到别的标签（别的都没有才收起，见 fallbackSideTab）。
   */
  const closeTerminalTab = useCallback(
    (id: string) => {
      const rest = terms.filter((t) => t.id !== id)
      const target = terms.find((t) => t.id === id)
      if (target) void window.api.terminal.kill(target.session.id)
      setTerms(rest)
      const next = fallbackSideTab(`terminal:${id}`)
      setSideTab((cur) => (cur === `terminal:${id}` ? next : cur))
    },
    [terms, fallbackSideTab]
  )

  // ------------- 顶栏按钮 / 面板开关 -------------
  /** 顶栏按钮的统一行为：正看着这个标签就收起面板，否则切到它（标签不在的话由调用方先加上） */
  const focusSideTab = useCallback((key: SideTabKey): void => {
    setSideTab((cur) => (cur === key ? null : key))
  }, [])

  /**
   * 关闭浏览器标签 = **销毁浏览器会话**。
   *
   * Agent 的浏览器工具下次调用时会自己重新开一个（主进程 `ensureSession` 会重建），
   * 所以这里不需要补偿；标签一并摘掉，下次用到时再按需挂出来。
   * 面板若正看着它，切到别的标签 —— **别的标签还在就继续开着**，一个都不剩才收起
   * （见 fallbackSideTab）。
   */
  const closeBrowserTab = useCallback((): void => {
    if (conversationId) void window.api.browser.close(agentBrowserSessionId(conversationId))
    setBrowserTabOpen(false)
    const next = fallbackSideTab('browser')
    setSideTab((cur) => (cur === 'browser' ? next : cur))
  }, [conversationId, fallbackSideTab])

  /** 顶栏「浏览器」按钮：标签不在就先加上，再看它 / 收起面板 */
  const toggleBrowserTab = useCallback((): void => {
    setBrowserTabOpen(true)
    focusSideTab('browser')
  }, [focusSideTab])

  /** 顶栏「文件视图」「源码管理」按钮：标签不在就先加上 */
  const toggleFilesTab = useCallback((): void => {
    setFilesTabOpen(true)
    focusSideTab('files')
  }, [focusSideTab])
  const toggleGitTab = useCallback((): void => {
    setGitTabOpen(true)
    focusSideTab('git')
  }, [focusSideTab])

  /** 关掉文件 / 源码管理标签（只是摘掉标签，不动工作区；别的标签还在就不收起面板） */
  const closeFilesTab = useCallback((): void => {
    setFilesTabOpen(false)
    const next = fallbackSideTab('files')
    setSideTab((cur) => (cur === 'files' ? next : cur))
  }, [fallbackSideTab])
  const closeGitTab = useCallback((): void => {
    setGitTabOpen(false)
    const next = fallbackSideTab('git')
    setSideTab((cur) => (cur === 'git' ? next : cur))
  }, [fallbackSideTab])

  /**
   * 顶栏最右的「门」按钮：开关整个面板。
   * 展开时回到上次看的标签；那个标签已经关掉了就退回浏览器标签（面板的默认视图）。
   */
  const toggleSidePanel = useCallback((): void => {
    if (sideTabRef.current !== null) {
      setSideTab(null)
      return
    }
    const last = lastSideTabRef.current
    const stillThere =
      last === 'browser'
        ? browserTabOpen
        : last === 'files'
          ? filesTabOpen
          : last === 'git'
            ? gitTabOpen
            : terms.some((t) => `terminal:${t.id}` === last)
    if (stillThere) {
      setSideTab(last)
      return
    }
    setBrowserTabOpen(true)
    setSideTab('browser')
  }, [browserTabOpen, filesTabOpen, gitTabOpen, terms])

  /**
   * 已自动展开过的浏览器会话 id —— **每个浏览器会话只自动展开一次**。
   * 之后无论 Agent 在这一页里怎么跳转，都不再抢着切标签（你收起就收起了）；
   * 会话结束（browser_close / 你关掉标签）后清空，新会话照常弹。
   */
  const autoShownRef = useRef<string | null>(null)

  /**
   * Agent 用到浏览器时把浏览器标签挂出来（浏览器会话懒启动，一启动就推 `browser:state`）。
   *
   * 分两种情形，优先级从高到低：
   * 1. **标签条上没有浏览器标签** → 一定挂出来并切过去，哪怕面板开着、你正在看终端/文件。
   *    这是「AI 正在操作网页，你得看得见」的唯一时机 —— 没有标签时它连画面都没接，
   *    再不让位就完全看不到（用户实测反馈过：面板开在别的标签上时就「什么都看不到」）；
   * 2. 标签已在 → 保持原来的克制：面板正开着（你在看别的标签）不抢焦点；收起了也只在
   *    **这个会话第一次**用浏览器时弹一次（`autoShownRef`），后续动作不再把它顶开。
   */
  useEffect(() => {
    if (!conversationId) return
    const sid = agentBrowserSessionId(conversationId)
    const offState = window.api.browser.onState((state) => {
      if (state.sessionId !== sid) return
      // 情形 1：没有标签 —— 挂出来并切过去（不抢焦点的话就永远看不到画面）
      if (!browserTabOpenRef.current) {
        autoShownRef.current = sid
        setBrowserTabOpen(true)
        setSideTab('browser')
        return
      }
      // 情形 2：标签已在 —— 面板开着就不动（你可能正看着别的标签）
      if (sideTabRef.current !== null) return
      if (autoShownRef.current === sid) return
      autoShownRef.current = sid
      setSideTab('browser')
    })
    const offClosed = window.api.browser.onClosed(({ sessionId }) => {
      // 会话结束：下一个浏览器会话要重新享有「自动展开一次」的机会
      if (sessionId === sid && autoShownRef.current === sid) autoShownRef.current = null
    })
    return () => {
      offState()
      offClosed()
    }
  }, [conversationId])

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

  /**
   * 新建一个终端标签（在当前工作区目录启动），返回新会话（失败 null）。
   *
   * **多开**：每调一次开一个会话、挂一个标签（终端已经是面板里的一种标签，见 sideTabs），
   * 标签名按创建序号起「终端 / 终端 2 / …」。shellId 缺省 = 交给主进程按偏好/平台默认选。
   */
  const openEmbeddedTerminal = useCallback(
    async (shellId?: string): Promise<SessionInfo | null> => {
      if (!active) return null
      try {
        const session = await window.api.terminal.createLocal(
          undefined,
          undefined,
          shellId,
          active.path
        )
        termSeqRef.current += 1
        const seq = termSeqRef.current
        setTerms((cur) => [
          ...cur,
          {
            id: session.id,
            session,
            path: active.path,
            shellId: shellId ?? effectiveShellId,
            label: seq === 1 ? '终端' : `终端 ${seq}`
          }
        ])
        // 新开的终端立刻切到它的标签（面板随之展开）
        setSideTab(`terminal:${session.id}`)
        return session
      } catch (err) {
        message.error(err instanceof Error ? err.message : '终端打开失败')
        return null
      }
    },
    [active, effectiveShellId]
  )

  /** 会话结束后按 Enter 重连：摘掉死掉的标签，照它原来用的 shell 再开一个 */
  const reconnectTerminal = useCallback(
    (tab: TerminalTab) => {
      closeTerminalTab(tab.id)
      void openEmbeddedTerminal(tab.shellId)
    },
    [closeTerminalTab, openEmbeddedTerminal]
  )

  /**
   * 工作区快捷功能里的「执行命令」：复用当前工作区已有的终端（没有就现开一个），
   * 再用 runScript 写入 —— 它会等 shell 就绪，刚建好的会话也能立刻收到命令。
   */
  const runQuickCommand = useCallback(
    async (command: string) => {
      if (!active) throw new Error('没有选中的工作区')
      const existing = terms.find((t) => t.path === active.path)?.session ?? null
      const session = existing ?? (await openEmbeddedTerminal())
      if (!session) throw new Error('终端打开失败')
      const ok = await window.api.terminal.runScript(session.id, `${command}\r`)
      if (!ok) throw new Error('命令写入失败，请检查终端是否已退出')
    },
    [active, terms, openEmbeddedTerminal]
  )

  /** 顶栏终端按钮的左半：**新建一个终端**（多开）。关某个终端走它标签上的 × */
  const handleTerminalClick = useCallback(() => {
    void openEmbeddedTerminal()
  }, [openEmbeddedTerminal])

  /**
   * 快捷键「开关 AI Agent 终端」（默认 Ctrl/Cmd+Shift+`）的落地。
   *
   * 终端已经是面板里的标签，所以这里做的是**开关面板**：正看着某个终端就收起面板，
   * 否则切到最后一个终端；一个终端都没开才新建一个。
   *
   * 动作只在 store 里广播一次请求（`ui.agentTerminalToggle` 自增），真正的开/关在这里做。
   * 不传 shellId —— 用设置里配的默认终端（主进程按 preferences.localShell 选）。
   * ref 记住已处理到的值：挂载前攒下的旧请求不会在挂载时误触发一次。
   */
  const agentTerminalToggle = useAppStore((s) => s.ui.agentTerminalToggle)
  const handledToggleRef = useRef(agentTerminalToggle)
  useEffect(() => {
    if (agentTerminalToggle === handledToggleRef.current) return
    handledToggleRef.current = agentTerminalToggle
    const last = terms[terms.length - 1]
    if (!last) {
      void openEmbeddedTerminal()
      return
    }
    setSideTab((cur) => (cur === `terminal:${last.id}` ? null : `terminal:${last.id}`))
  }, [agentTerminalToggle, terms, openEmbeddedTerminal])

  /** 终端按钮的下拉菜单：检出多个 shell 时才出现 */
  const shellMenuItems: MenuProps['items'] = shells.map((s) => ({
    key: s.id,
    icon: <Terminal className="size-3.5" />,
    label: s.name
  }))

  /** 下拉里选 shell = 用这个 shell **再开一个**终端（多开，不再复用/替换） */
  const handleShellSelect: MenuProps['onClick'] = ({ key, domEvent }) => {
    domEvent.stopPropagation()
    void openEmbeddedTerminal(key)
  }

  /** 模型下拉选中值：ACP 后端显示预置配置，内置（Mastra）后端显示本会话实际使用的模型配置 */
  /**
   * 模型下拉的选中值编码（解析见 handleModelSelect）：
   * - `cfg:<配置id>:<模型id>`：内置 Mastra agent，配置下的具体模型
   * - `<配置id>`：内置 Mastra agent，配置默认模型（兼容旧值）
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
    const models = configModels(config)
    if (models.length === 0) return undefined
    if (conversation?.modelId && models.includes(conversation.modelId)) {
      return `cfg:${config.id}:${conversation.modelId}`
    }
    return `cfg:${config.id}:${models[0]}`
  })()

  const handleModelSelect = (value?: string) => {
    if (!activeId || !conversationId || !value) return
    if (value === ACP_MANAGE_OPTION) {
      // 预置配置在设置页统一维护
      setSettingsOpen(true, 'models')
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
    // 内置模型（cfg: 或纯配置 id）一律走 Mastra agent
    if (value.startsWith('cfg:')) {
      const [, cfgId, cfgModel] = value.split(':')
      void setAgentConversationModel(conversationId, {
        backend: 'mastra',
        configId: cfgId,
        modelId: cfgModel
      })
      return
    }
    // 旧格式兜底：纯配置 id
    void setAgentConversationModel(conversationId, {
      backend: 'mastra',
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
          options: aiConfigs.flatMap((c) =>
            configModels(c).map((m) => ({ value: `cfg:${c.id}:${m}`, label: `${c.name} · ${m}` }))
          )
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
  // （滚动状态由 VirtualMessageList 按 listKey 重挂自行重置）
  useEffect(() => {
    setInput('')
    setEditing(null)
  }, [activeId, conversationId])

  /**
   * 右侧面板的标签集合：**浏览器 / 终端 / 文件 / 源码管理** 都在这里。
   *
   * - **浏览器**：Agent 的 `browser_*` 工具就操作这个会话（会话 id 由 conversationId
   *   推导，见 @shared/browser），看到的就是它正在操作的页面 —— 点哪、填了什么肉眼可见。
   *   关掉这个标签会**销毁会话**（见 closeBrowserTab），所以它按需挂出来；
   * - **终端**：一个会话一个标签（支持多开），绑定打开时的工作区目录；
   * - **文件 / 源码管理**：跟着当前工作区，按需存在。
   *
   * 内容都**常挂载**（由 SidePanel 隐藏非活动标签）：浏览器标签卸载等于重新接一次
   * 帧流（黑屏一下），终端标签卸载则 xterm 重建、会话输出全丢（`terminal:data` 无回放）。
   */
  const sideTabs: SidePanelTab[] = [
    ...(conversationId && browserTabOpen
      ? [
        {
          key: 'browser',
          label: '浏览器',
          title: '浏览器 · Agent 操作画面',
          icon: <Globe className="size-4" />,
          content: (
            <div className="h-full px-2 pb-2">
              <BrowserPane
                sessionId={agentBrowserSessionId(conversationId)}
                mode={browserMode}
                onModeChange={setBrowserMode}
                className="h-full"
              />
            </div>
          ),
          onClose: closeBrowserTab
        }
      ]
      : []),
    ...terms.map((t) => ({
      key: `terminal:${t.id}`,
      label: t.label,
      title: `终端 · ${t.path}`,
      icon: <SquareTerminal className="size-4" />,
      content: (
        <div className="h-full px-2 pb-2">
          <TerminalView
            session={t.session}
            isActive={sideTab === `terminal:${t.id}`}
            onExitedReconnect={() => reconnectTerminal(t)}
            onExitedClose={() => closeTerminalTab(t.id)}
          />
        </div>
      ),
      onClose: () => closeTerminalTab(t.id)
    })),
    ...(active && filesTabOpen
      ? [
        {
          key: 'files',
          label: '文件',
          title: `文件 · ${active.name}`,
          icon: <Files className="size-4" />,
          content: <AgentFilesPanel workspaceId={active.id} workspaceName={active.name} />,
          onClose: closeFilesTab
        }
      ]
      : []),
    ...(active && gitTabOpen
      ? [
        {
          key: 'git',
          label: '源码管理',
          title: `源码管理 · ${active.name}`,
          icon: <GitBranch className="size-4" />,
          content: (
            <GitPanel
              cwd={active.path}
              // 面板内部不再有关闭按钮：要关就用下面标签自己的 `onClose`（标签条上的 ×）
              // 或顶栏的源码管理按钮
              onChanges={(info) => setGitCount(info ? info.count : 0)}
            />
          ),
          onClose: closeGitTab
        }
      ]
      : [])
  ]

  /** 面板正显示的那个终端标签（没有就是 null）—— 顶栏终端按钮的激活态与 shell 选中态用它 */
  const activeTerm = terms.find((t) => `terminal:${t.id}` === sideTab) ?? null

  /**
   * 标签的**打开顺序**：新开的排到最后（跟浏览器 / 编辑器的标签条一致）。
   *
   * 上面 `sideTabs` 的数组顺序是代码里写死的（浏览器 → 终端 → 文件 → 源码管理），
   * 因为每个标签的**存在性**是各自独立的开关，拼数组时只知道「有哪些」、不知道「谁先来的」。
   * 于是打开浏览器会插到最前面，新开一个终端会插到「文件 / 源码管理」前面 —— 都不在末尾。
   * 这里额外记一份打开顺序来修正它。
   *
   * 顺序表只需「追加 + 剔除」，不必在每个开 / 关的地方手动登记：哪些标签活着在渲染期就是
   * 已知的（`sideTabs` 正是当前活着的那批），直接拿它同步即可 —— 关掉的自动剔掉、
   * 新出现的追加到末尾，**关掉再打开也会自然排到最后**。
   *
   * 用 `useLayoutEffect`：顺序要在**首次绘制前**修正，否则新标签会先在固定槽位闪一帧再跳走。
   */
  const [tabOrder, setTabOrder] = useState<string[]>([])
  /** 当前活着的标签 key 串（`sideTabs` 每次渲染都是新数组，直接拿它当 effect 依赖会每次都跑） */
  const sideTabKeys = sideTabs.map((t) => t.key).join('\n')
  useLayoutEffect(() => {
    const keys = sideTabKeys ? sideTabKeys.split('\n') : []
    setTabOrder((cur) => {
      const kept = cur.filter((k) => keys.includes(k))
      const added = keys.filter((k) => !kept.includes(k))
      // 没变化就原样返回，别白白多渲染一次
      return kept.length === cur.length && added.length === 0 ? cur : [...kept, ...added]
    })
  }, [sideTabKeys])

  /** 按打开顺序排好的标签（见上；顺序表里还没有的排到最后） */
  const orderedSideTabs = [...sideTabs].sort(
    (a, b) => tabRank(tabOrder, a.key) - tabRank(tabOrder, b.key)
  )

  return (
    <div className="flex h-full min-h-0 flex-col bg-background rounded-lg overflow-hidden">
      {/* 顶栏：当前工作区 + 操作 */}
      <div className="flex h-14 shrink-0 items-center gap-2 px-3 py-2">
        {active ? (
          <div className="ml-2 flex min-w-0 flex-1 flex-col justify-center">
            {conversation && (
              <span
                className="truncate text-base font-bold leading-tight"
                title={conversation.title}
              >
                {conversation.title}
              </span>
            )}
            {/* 当前工作目录：分屏后同一屏可能并排好几个会话，光看标题分不清各自作用在哪个目录。
                放到会话名下方，长路径截断，完整路径走 title 悬浮提示 */}
            <span
              data-agent-cwd
              className="truncate font-mono text-xs leading-tight text-muted-foreground"
              title={active.path}
            >
              {active.path}
            </span>
          </div>
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
              {/* 快捷功能：最左侧，下拉列 `<工作区>/.dogi/workspace.json` 里配好的条目 */}
              <WorkspaceQuickActions workspace={active} onRunCommand={runQuickCommand} />
              {/* 文件视图：单图标按钮 —— 在面板里挂出 / 切到「文件」标签（见 toggleFilesTab） */}
              <Tooltip
                title={sideTab === 'files' ? '收起面板' : '文件视图'}
              >
                <button
                  type="button"
                  title="文件视图"
                  onClick={toggleFilesTab}
                  className={cn(
                    'flex size-7 items-center justify-center rounded-md border border-border bg-transparent',
                    sideTab === 'files' ? 'text-primary' : 'text-foreground hover:bg-foreground/10'
                  )}
                >
                  <Files className="size-4" />
                </button>
              </Tooltip>
              {/* 源代码管理（git）：图标按钮 + 改动数 badge，同样是面板里的一个标签 */}
              <Tooltip
                title={sideTab === 'git' ? '收起面板' : '源代码管理（git）'}
              >
                <button
                  type="button"
                  title="源代码管理"
                  onClick={toggleGitTab}
                  className={cn(
                    'relative flex size-7 items-center justify-center rounded-md border border-border bg-transparent',
                    sideTab === 'git' ? 'text-primary' : 'text-foreground hover:bg-foreground/10'
                  )}
                >
                  <GitBranch className="size-4" />
                  {gitCount > 0 && (
                    <span className="absolute -right-1.5 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] leading-none text-white">
                      {gitCount > 99 ? '99+' : gitCount}
                    </span>
                  )}
                </button>
              </Tooltip>
              {/* 终端：分裂按钮 —— 左半**新建一个终端**（多开；关某个走它标签上的 ×），
                  右半 chevron 下拉是「用哪个 shell 新建」 */}
              <div className="flex items-stretch">
                <Tooltip title="新建终端">
                  <button
                    type="button"
                    title="新建终端"
                    onClick={handleTerminalClick}
                    className={cn(
                      'flex size-7 items-center justify-center rounded-l-md border border-border border-r-0 bg-transparent',
                      activeTerm ? 'text-primary' : 'text-foreground hover:bg-foreground/10'
                    )}
                  >
                    <SquareTerminal className="size-4" />
                  </button>
                </Tooltip>
                <Dropdown
                  trigger={['click']}
                  placement="bottomRight"
                  menu={{
                    items: shellMenuItems,
                    onClick: handleShellSelect,
                    selectedKeys: activeTerm?.shellId ? [activeTerm.shellId] : []
                  }}
                >
                  <button
                    type="button"
                    title="选择终端"
                    className="flex size-7 w-5 items-center justify-center rounded-l-none rounded-r-md border border-border bg-transparent text-foreground hover:bg-foreground/10"
                  >
                    <ChevronDown className="size-3.5" />
                  </button>
                </Dropdown>
              </div>
              {/* 浏览器：单图标按钮 —— 在多标签面板里切到浏览器标签，再点收起面板 */}
              <Tooltip
                title={
                  sideTab === 'browser'
                    ? '收起面板'
                    : '打开浏览器（查看 Agent 正在操作的页面）'
                }
              >
                <button
                  type="button"
                  aria-label="浏览器"
                  title="浏览器"
                  onClick={toggleBrowserTab}
                  className={cn(
                    'flex size-7 items-center justify-center rounded-md border border-border bg-transparent',
                    sideTab === 'browser' ? 'text-primary' : 'text-foreground hover:bg-foreground/10'
                  )}
                >
                  <Globe className="size-4" />
                </button>
              </Tooltip>
              {/* 打开：分裂按钮 —— 左半在文件管理器打开目录，右半 chevron 下拉（文件管理器 / IDE） */}
              <div className="flex items-stretch">
                <Tooltip title="打开工作区目录">
                  <button
                    type="button"
                    title="打开文件管理器"
                    onClick={() => {
                      if (!active) return
                      void handleOpen(
                        () => window.api.shell.openFileManager(active.path),
                        `已打开：${active.path}`
                      )
                    }}
                    className="flex size-7 items-center justify-center rounded-l-md border border-border border-r-0 bg-transparent text-foreground hover:bg-foreground/10"
                  >
                    <FolderOpen className="size-4" />
                  </button>
                </Tooltip>
                <Dropdown
                  trigger={['click']}
                  placement="bottomRight"
                  menu={{ items: openMenuItems, onClick: handleOpenMenuClick }}
                >
                  <button
                    type="button"
                    title="更多打开方式"
                    className="flex size-7 w-5 items-center justify-center rounded-l-none rounded-r-md border border-border bg-transparent text-foreground hover:bg-foreground/10"
                  >
                    <ChevronDown className="size-3.5" />
                  </button>
                </Dropdown>
              </div>
              {/* 面板开关：功能区最右一个 —— 「右侧面板展开 / 收起」一对图标，
                  图标本身就说明动作（收起时是展开箭头，展开时是收起箭头）。
                  展开时回到上次看的标签（那个标签没了就退回浏览器标签），
                  宽度由 SidePanel 默认撑到上限（= 把对话区压到最小宽度） */}
              <Tooltip title={sideTab !== null ? '收起面板' : '展开面板'}>
                <button
                  type="button"
                  aria-label="展开/收起面板"
                  title="面板"
                  aria-pressed={sideTab !== null}
                  onClick={toggleSidePanel}
                  className={cn(
                    'flex size-7 items-center justify-center rounded-md border border-border bg-transparent',
                    sideTab !== null ? 'text-primary' : 'text-foreground hover:bg-foreground/10'
                  )}
                >
                  {sideTab !== null ? (
                    <PanelRightClose className="size-4" />
                  ) : (
                    <PanelRightOpen className="size-4" />
                  )}
                </button>
              </Tooltip>
            </>
          )}
        </div>
      </div>

      {/* 内容区：左侧对话（对话流 + 输入框），右侧是**多标签面板**
          （浏览器 / 终端 / 文件 / 源码管理，见 sideTabs 与 SidePanel） */}
      <div ref={contentRef} className="relative flex min-h-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {/* 对话流 + 底部的「滚动到底部」按钮。这一层 relative 只为给按钮做定位上下文，
          按钮浮在对话流底部正中央，不参与布局、不挤压消息 */}
          <div className="relative flex min-h-0 flex-1 flex-col">
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
              <VirtualMessageList
                ref={listRef}
                listKey={conversationId ?? '__none__'}
                messages={messages}
                className="min-h-0 flex-1"
                footer={
                  error && !streaming ? (
                    <div className="mx-auto w-full max-w-3xl px-2">
                      <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                        {error}
                      </div>
                    </div>
                  ) : null
                }
                renderItem={(m, index) => (
                  <div className="mx-auto w-full max-w-3xl px-5">
                    <MessageBubble
                      conversationId={conversationId}
                      message={m}
                      streaming={
                        streaming && index === messages.length - 1 && m.role === 'assistant'
                      }
                      canEdit={!streaming && m.role === 'user'}
                      editing={editing?.id === m.id}
                      onEdit={startEdit}
                      canDelete={!streaming}
                      tailCount={messages.length - index}
                      pendingConfirm={pendingConfirm}
                    />
                  </div>
                )}
              />
            )}
            {/* 右侧「消息目录」：用户消息各占一段，悬停预览、点击跳转 */}
            <MessageOutline messages={messages} onJump={jumpToMessage} />
          </div>

          {/* 底部大输入框：外层外壳是唯一的边框（内层输入区无边框，避免双重 border）；
          左下角是命令执行权限，右下角是模型选择与发送/停止（模型紧贴发送按钮左侧） */}
          {active && (
            <div className="mx-auto w-full max-w-3xl shrink-0 px-5 py-4">
              <div>
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
                        {/* 横条上**只显示图标**（文案在下拉项里，省下的宽度留给输入框）；
                            「全部访问」用警示色 —— 它意味着不再询问 */}
                        <Button
                          type="text"
                          size="small"
                          icon={<PermissionIcon className="size-4" />}
                          title={`${permissionMeta.label}：${permissionMeta.hint}（点击切换）`}
                          className={cn(
                            'px-1.5',
                            permissionMode === 'full' ? 'text-amber-500!' : 'text-muted-foreground'
                          )}
                        />
                      </Dropdown>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <McpConfigPopover />
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
                        // 选中态只显示模型名（列表里仍是「提供商 · 模型」，方便区分同名模型）
                        labelRender={(opt) => modelNameOnly(opt.label)}
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

        </div>

        {/* 右侧多标签面板：浏览器 / 终端 / 文件 / 源码管理都是它的标签（见 sideTabs），
            拖左边缘可改宽度。常挂载（收起时宽度动画到 0）—— 展开有动画，
            且各标签的画面 / 终端会话都不会丢。
            标签顺序用 `orderedSideTabs`（打开顺序），不是 `sideTabs` 的固定槽位 */}
        {active && (
          <SidePanel
            open={orderedSideTabs.length > 0 && sideTab !== null}
            tabs={orderedSideTabs}
            activeKey={sideTab}
            // 标签 key 只可能来自本页 sideTabs，收窄是安全的
            onSelect={(key) => setSideTab(key as SideTabKey)}
            onCollapse={() => setSideTab(null)}
            containerWidth={contentWidth}
          />
        )}
      </div>
    </div>
  )
}
