import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState
} from 'react'
import { Button, Dropdown, Input, Select, Tooltip, message } from 'antd'
import type { MenuProps } from 'antd'
import {
  Ban,
  Bot,
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Code2,
  ExternalLink,
  FolderOpen,
  Loader2,
  Send,
  Settings,
  ShieldCheck,
  Square,
  Terminal,
  X
} from 'lucide-react'
import { useAppStore } from '@/stores/app-store'
import { AiMarkdown } from '@/features/agent/AiMarkdown'
import { MessageCopyButton } from '@/features/agent/MessageCopyButton'
import { TerminalView } from '@/features/terminal/TerminalView'
import { cn } from 'cn'
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

/** 模型下拉里 ACP 后端的特殊选项值 */
const ACP_OPTION = '__acp__'
const ACP_MANAGE_OPTION = '__acp-manage__'

/** Agent 工具的中文展示名 */
const AGENT_TOOL_LABELS: Record<string, string> = {
  list_files: '列出目录',
  read_file: '读取文件',
  write_file: '写入文件',
  edit_file: '编辑文件',
  search_files: '搜索文件',
  execute_command: '执行命令'
}

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
      hint: 'Agent 执行命令无需逐条确认'
    },
    {
      value: 'confirm',
      label: '需确认',
      icon: ShieldCheck,
      hint: 'Agent 执行每条命令前都需要你确认，可随时取消'
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
  pendingConfirm: AgentConfirmRequest | null
}) {
  const resolveAgentConfirm = useAppStore((s) => s.resolveAgentConfirm)
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
  const label = AGENT_TOOL_LABELS[call.toolName] ?? call.toolName
  const inputText = call.input ? JSON.stringify(call.input, null, 1) : ''
  const outputText =
    typeof result?.output === 'string'
      ? result.output.slice(0, 2000)
      : result?.output
        ? JSON.stringify(result.output).slice(0, 2000)
        : ''

  return (
    <details className="my-1.5 rounded-md border border-border/70 text-xs" open={!!confirm}>
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
              'max-h-72 overflow-auto whitespace-pre-wrap font-mono text-[10px]',
              result?.isError && 'text-destructive'
            )}
          >
            {outputText}
          </pre>
        )}
        {confirm && (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <span className="text-[10px] text-muted-foreground">
              是否允许在工作区「{confirm.workspaceName}」执行？
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
        )}
      </div>
    </details>
  )
}

/**
 * 思考过程面板（参考 ainav/sdk 的 ReasoningPanel）：
 * - 流式：spinner + 「思考中」高亮 + 单行实时预览（自动滚动），不显示箭头；
 * - 完成：脑图标 + 「思考过程」，右侧箭头可展开/收起完整内容；
 * - 展开体流式期间自动吸底（用户上滚则暂停跟随）。
 */
function ReasoningPanel({ text, streaming }: { text: string; streaming: boolean }) {
  const [open, setOpen] = useState(false)
  const lineRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const stick = useRef(true)

  // 流式时单行预览自动滚到最新内容
  useEffect(() => {
    if (streaming && lineRef.current) {
      lineRef.current.scrollTop = lineRef.current.scrollHeight
    }
  }, [text, streaming])

  // 展开体流式时自动吸底（用户上滚则暂停跟随）
  useEffect(() => {
    if (streaming && open && bodyRef.current && stick.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight
    }
  }, [text, streaming, open])

  return (
    <div className="my-1.5 rounded-md border border-border/70 bg-muted/30 text-xs">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left text-muted-foreground hover:text-foreground"
      >
        {streaming ? (
          <Loader2 className="size-3.5 shrink-0 animate-spin text-primary" />
        ) : (
          <Brain className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <span
          className={cn('shrink-0 font-medium', streaming && 'text-primary')}
        >
          {streaming ? '思考中' : '思考过程'}
        </span>
        {!open && streaming && (
          <span
            ref={lineRef}
            className="min-w-0 flex-1 overflow-hidden whitespace-nowrap font-mono text-[10px] text-muted-foreground"
          >
            {text}
          </span>
        )}
        {!streaming && (
          <ChevronRight
            className={cn(
              'ml-auto size-3.5 shrink-0 text-muted-foreground/60 transition-transform',
              open && 'rotate-90'
            )}
          />
        )}
      </button>
      {open && (
        <div
          ref={bodyRef}
          onScroll={() => {
            const el = bodyRef.current
            if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 24
          }}
          className="max-h-60 overflow-y-auto whitespace-pre-wrap border-t border-border/70 px-2 py-1.5 text-[11px] leading-relaxed text-muted-foreground"
        >
          {text}
        </div>
      )}
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

/** 单条消息：用户气泡 / 助手（Markdown + 工具卡），两者都可选中、都可一键复制 */
function MessageBubble({
  message,
  streaming,
  pendingConfirm
}: {
  message: AgentChatMessage
  streaming?: boolean
  pendingConfirm: AgentConfirmRequest | null
}) {
  if (message.role === 'user') {
    const text = textOf(message.parts, '')
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

  const units = buildRenderUnits(message.parts)
  // 复制的是 Markdown 源码而不是渲染后的文本：代码块、链接等结构才能保留
  const rawText = textOf(message.parts, '\n\n').trim()

  return (
    <div className="space-y-1">
      {units.map((unit, i) =>
        unit.kind === 'text' ? (
          <div key={i} className="py-2">
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
      {/* 生成中就露出复制按钮没有意义（内容还在变），一轮结束再显示 */}
      {!streaming && <MessageCopyButton text={rawText} title="复制原文（Markdown）" />}
    </div>
  )
}

/** 稳定的空消息数组：避免每次渲染新引用导致滚动 effect 误触发 */
const NO_MESSAGES: AgentChatMessage[] = []

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
  // 终端位于页面底部，向上拖 = 面板变高，所以高度增量取 deltaY 的相反数
  const startDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
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
      {/* 高度拖拽条：位于终端标题栏（横条）上方 */}
      <div
        onPointerDown={startDrag}
        title="拖动调整高度"
        className="group/resize relative z-10 -my-1 h-2 shrink-0 cursor-row-resize"
      >
        <div className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-border transition-colors group-hover/resize:bg-primary" />
      </div>
      <div className="flex h-8 shrink-0 items-center gap-1.5 px-3">
        <Terminal className="size-3.5 shrink-0 text-muted-foreground" />
        <span
          className="min-w-0 truncate font-mono text-[11px] text-muted-foreground"
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
 * Agent 主界面：类 Claude Code 的工作区编程助手。
 * 上方是对话流（文本 + 工具卡），底部大输入框，Enter 发送 / Shift+Enter 换行。
 * 对话绑定左侧选中的工作区，工具（读写文件 / 搜索 / 执行命令）只能作用于该目录。
 */
export function AgentPage() {
  const workspaces = useAppStore((s) => s.agentWorkspaces)
  const activeId = useAppStore((s) => s.activeAgentWorkspaceId)
  const active = activeId ? workspaces.find((w) => w.id === activeId) : undefined
  const aiSettings = useAppStore((s) => s.aiSettings)
  const aiConfigs = useAppStore((s) => s.aiConfigs)
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen)
  const acpAgents = aiSettings.acpAgents ?? []
  // ACP 后端当前使用的预置配置（设置页维护，下拉处切换）
  const activeAcp = acpAgents.find((a) => a.id === aiSettings.activeAcpId) ?? acpAgents[0]
  // 后端按工作区（会话）独立：默认内置 AI SDK，可在模型下拉处切到外部 ACP agent
  const backend = active?.backend ?? 'ai-sdk'
  // ACP 后端无需模型配置（agent 自带模型），只需有可用的预置配置
  const hasConfig =
    backend === 'acp'
      ? Boolean(activeAcp)
      : Boolean(aiSettings.activeConfigId) && aiConfigs.length > 0
  const setActiveAiConfig = useAppStore((s) => s.setActiveAiConfig)
  const setAgentWorkspaceBackend = useAppStore((s) => s.setAgentWorkspaceBackend)
  const saveAiSettings = useAppStore((s) => s.saveAiSettings)
  const setAiPermissionMode = useAppStore((s) => s.setAiPermissionMode)
  const permissionMode: AiPermissionMode =
    aiSettings.permissionMode === 'confirm' ? 'confirm' : 'full'
  const permissionMeta =
    AGENT_PERMISSION_MODES.find((m) => m.value === permissionMode) ?? AGENT_PERMISSION_MODES[0]
  const PermissionIcon = permissionMeta.icon
  // 消息来自当前会话（唯一真源），流式/错误等运行时状态另存 agentRuns
  const conversationId = useAppStore((s) => s.activeAgentConversationId)
  const conversation = useAppStore((s) =>
    conversationId ? s.agentConversations.find((c) => c.id === conversationId) : undefined
  )
  const run = useAppStore((s) => (conversationId ? s.agentRuns[conversationId] : undefined))
  const messages = conversation?.messages ?? NO_MESSAGES
  const streaming = run?.streaming ?? false
  const error = run?.error ?? null
  const pendingConfirm = useAppStore((s) => {
    if (!activeId) return null
    for (const c of Object.values(s.agentPendingConfirms)) {
      if (c.workspaceId === undefined || c.workspaceId === activeId) return c
    }
    return null
  })
  const sendAgentMessage = useAppStore((s) => s.sendAgentMessage)
  const abortAgent = useAppStore((s) => s.abortAgent)
  const setSidebarCollapsed = useAppStore((s) => s.setSidebarCollapsed)

  const [input, setInput] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)
  const nearBottomRef = useRef(true)

  // 内嵌终端（在输入框下方）：绑定打开时的工作区目录，切换工作区不影响已开的终端
  const [term, setTerm] = useState<{ session: SessionInfo; path: string } | null>(null)
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

  // 可用终端列表（终端按钮右侧下拉：选择用哪个终端打开）
  const [shells, setShells] = useState<ShellProfile[]>([])
  const [shellsLoaded, setShellsLoaded] = useState(false)
  useEffect(() => {
    if (shellsLoaded) return
    let alive = true
    void window.api.terminal.listShells().then((res) => {
      if (!alive) return
      setShells(res.shells)
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

  /** 终端按钮：在输入框下方内嵌显示/关闭终端（在当前工作区目录启动） */
  const handleToggleTerminal = useCallback(async () => {
    if (term) {
      closeEmbeddedTerminal()
      return
    }
    if (!active) return
    try {
      const session = await window.api.terminal.createLocal(undefined, undefined, undefined, active.path)
      setTerm({ session, path: active.path })
    } catch (err) {
      message.error(err instanceof Error ? err.message : '终端打开失败')
    }
  }, [term, active, closeEmbeddedTerminal])

  /** 终端下拉：选择用哪个终端（shell）打开；已打开时切换为新 shell */
  const shellMenuItems: MenuProps['items'] = shells.map((s) => ({
    key: s.id,
    icon: <Terminal className="size-3.5" />,
    label: s.name
  }))

  const handleShellSelect: MenuProps['onClick'] = async ({ key, domEvent }) => {
    if (!active) return
    domEvent.stopPropagation()
    const shell = shells.find((s) => s.id === key)
    if (!shell) return
    if (term) void window.api.terminal.kill(term.session.id)
    try {
      const session = await window.api.terminal.createLocal(undefined, undefined, shell.id, active.path)
      setTerm({ session, path: active.path })
    } catch (err) {
      message.error(err instanceof Error ? err.message : '终端打开失败')
    }
  }

  /** 模型下拉选中值：ACP 后端显示预置配置，内置后端显示模型配置 */
  const modelSelectValue =
    backend === 'acp'
      ? activeAcp
        ? `acp:${activeAcp.id}`
        : ACP_OPTION
      : aiConfigs.some((c) => c.id === aiSettings.activeConfigId)
        ? aiSettings.activeConfigId
        : undefined

  const handleModelSelect = (value: string) => {
    if (!activeId) return
    if (value === ACP_MANAGE_OPTION) {
      // 预置配置在设置页统一维护
      setSettingsOpen(true, 'ai')
      return
    }
    if (value === ACP_OPTION || value.startsWith('acp:')) {
      void setAgentWorkspaceBackend(activeId, 'acp')
      if (value.startsWith('acp:')) void saveAiSettings({ activeAcpId: value.slice(4) })
      return
    }
    void setActiveAiConfig(value)
    void setAgentWorkspaceBackend(activeId, 'ai-sdk')
  }

  // antd 6 的 Select 不再支持 options 里的 type:'divider'（会渲染成空选项行），改用分组
  const modelOptions = [
    ...(aiConfigs.length > 0
      ? [
          {
            label: 'AI 模型',
            options: aiConfigs.map((c) => ({
              value: c.id,
              label: `${c.name}（${c.model}）`
            }))
          }
        ]
      : []),
    {
      label: 'Agent',
      options: [
        ...acpAgents.map((a) => ({
          value: `acp:${a.id}`,
          label: a.name,
          icon: <Bot className="size-3.5" />
        })),
        ...(activeAcp
          ? []
          : [{ value: ACP_OPTION, label: '外部 ACP agent', icon: <Bot className="size-3.5" /> }]),
        {
          value: ACP_MANAGE_OPTION,
          label: acpAgents.length ? '管理 ACP agent…' : '配置 ACP agent…',
          icon: <Settings className="size-3.5" />
        }
      ]
    }
  ]

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el && nearBottomRef.current) el.scrollTop = el.scrollHeight
  }, [messages, streaming, activeId])

  const handleListScroll = () => {
    const el = scrollRef.current
    if (!el) return
    nearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48
  }

  const handleSend = () => {
    if (streaming || !input.trim() || !hasConfig || !conversationId) return
    void sendAgentMessage(input)
    setInput('')
  }

  // 换了工作区或会话后清空草稿，避免把上一段的输入带进新对话
  useEffect(() => {
    setInput('')
  }, [activeId, conversationId])

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      {/* 顶栏：当前工作区 + 操作 */}
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border/70 px-3">
        {active ? (
          <>
            <FolderOpen className="size-4 shrink-0 text-primary" />
            <span className="shrink-0 text-sm font-medium">{active.name}</span>
            {conversation && (
              <>
                <span className="shrink-0 text-muted-foreground/40">/</span>
                <span
                  className="max-w-44 shrink-0 truncate text-xs text-muted-foreground"
                  title={conversation.title}
                >
                  {conversation.title}
                </span>
              </>
            )}
          </>
        ) : (
          <>
            <Bot className="size-4 shrink-0 text-muted-foreground" />
            <span className="text-sm text-muted-foreground">AI Agent</span>
          </>
        )}
        {/* 右侧操作区靠右：顶栏中间不再显示工作区路径 */}
        <div className="ml-auto flex items-center gap-0.5">
          {active && (
            <>
              <Tooltip title={term ? '关闭终端' : '打开终端'}>
                <Button
                  type="text"
                  size="small"
                  className="px-1.5 text-muted-foreground"
                  icon={<Terminal className="size-3.5" />}
                  onClick={() => void handleToggleTerminal()}
                />
              </Tooltip>
              <Tooltip title="选择用哪个终端打开">
                <Dropdown
                  trigger={['click']}
                  placement="bottomRight"
                  menu={{ items: shellMenuItems, onClick: handleShellSelect }}
                >
                  <Button
                    type="text"
                    size="small"
                    className="px-0.5 text-muted-foreground"
                    icon={<ChevronDown className="size-3" />}
                  />
                </Dropdown>
              </Tooltip>
              <Tooltip title="打开工作区目录">
                <Dropdown
                  trigger={['click']}
                  placement="bottomRight"
                  menu={{ items: openMenuItems, onClick: handleOpenMenuClick }}
                >
                  <Button
                    type="text"
                    size="small"
                    className="px-1.5 text-muted-foreground"
                    icon={<ExternalLink className="size-3.5" />}
                  />
                </Dropdown>
              </Tooltip>
            </>
          )}
        </div>
      </div>

      {/* 对话流 */}
      <div
        ref={scrollRef}
        onScroll={handleListScroll}
        className="agent-scroll min-h-0 flex-1 select-text overflow-y-auto py-4"
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
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-2">
            {messages.map((m, i) => (
              <MessageBubble
                key={m.id}
                message={m}
                streaming={streaming && i === messages.length - 1 && m.role === 'assistant'}
                pendingConfirm={pendingConfirm}
              />
            ))}
            {error && !streaming && (
              <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                {error}
              </div>
            )}
          </div>
        )}
      </div>

      {/* 底部大输入框：外层外壳是唯一的边框（内层输入区无边框，避免双重 border）；
          左下角是模型选择与命令执行权限，右下角是发送/停止 */}
      {active && (
        <div className="shrink-0 p-3">
          <div className="mx-auto w-full max-w-3xl">
            <div
              className={cn(
                'overflow-hidden rounded-xl border border-transparent bg-muted/50 transition-colors',
                'focus-within:border-primary/50 focus-within:bg-muted/70'
              )}
            >
              <Input.TextArea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault()
                    handleSend()
                  }
                }}
                placeholder={
                  hasConfig
                    ? `在「${active.name}」中描述你的任务…（Enter 发送 · Shift+Enter 换行）`
                    : backend === 'acp'
                      ? '请先在设置中配置 ACP agent（AI 配置页）'
                      : '请先在设置中配置 AI 模型'
                }
                autoSize={{ minRows: 2, maxRows: 8 }}
                variant="borderless"
                className="agent-input max-h-52 w-full border-none bg-transparent px-3 py-2.5 text-[13px] shadow-none"
              />
              {/* 工具行：模型 / 权限 在左，发送在右 */}
              <div className="flex items-center justify-between gap-2 px-2 py-1.5">
                <div className="flex min-w-0 items-center gap-0.5">
                  <Select
                    size="small"
                    variant="borderless"
                    placement="topLeft"
                    className="max-w-56 min-w-0"
                    value={modelSelectValue}
                    onChange={(v) => handleModelSelect(v)}
                    placeholder="选择模型"
                    popupMatchSelectWidth={false}
                    options={modelOptions}
                  />
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
                {streaming ? (
                  <Button
                    type="text"
                    danger
                    icon={<Square className="size-4" />}
                    title="停止生成"
                    className="shrink-0"
                    onClick={() => void abortAgent()}
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
            <div className="mt-1.5 flex items-center justify-between px-1 text-[10px] text-muted-foreground/70">
              <span>Agent 只能在「{active.name}」目录内操作</span>
              <span>工具：读文件 / 写文件 / 编辑 / 搜索 / 执行命令</span>
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
  )
}
