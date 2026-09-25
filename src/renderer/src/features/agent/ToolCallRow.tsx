import {
  CircleQuestionMark,
  FilePenLine,
  FilePlus,
  FileSearch,
  FileText,
  FolderTree,
  Keyboard,
  Loader2,
  MonitorDot,
  ScrollText,
  Search,
  Sparkles,
  Terminal,
  Trash2,
  Wrench,
  type LucideIcon
} from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { cn } from 'cn'
import { CollapsibleRow } from '@/features/agent/CollapsibleRow'
import { MessageCopyButton } from '@/features/agent/MessageCopyButton'

/**
 * 工具调用的中文展示名。Agent 页（工作区助手）与终端 AI 助手共用一份 ——
 * 确认卡文案、浮窗折叠状态条、工具横条都用它。
 */
export const TOOL_LABELS: Record<string, string> = {
  // 工作区 Agent
  list_files: '列出目录',
  find_files: '查找文件',
  search_files: '搜索内容',
  read_file: '读取文件',
  write_file: '写入文件',
  edit_file: '编辑文件',
  delete_file: '删除文件',
  execute_command: '执行命令',
  read_skill: '读取技能',
  // 终端 AI 助手
  run_in_terminal: '执行终端命令',
  send_keys: '发送按键',
  read_terminal_output: '读取终端输出',
  list_terminal_sessions: '查看终端列表',
  // 两个界面都有：向用户追问（结构化选择题）
  'ask_followup_question': '追问'
}

/** 每个工具一个图标（横条最左侧）—— 搜索类工具一眼能认出来，不用读文字 */
const TOOL_ICONS: Record<string, LucideIcon> = {
  list_files: FolderTree,
  find_files: FileSearch,
  search_files: Search,
  read_file: FileText,
  write_file: FilePlus,
  edit_file: FilePenLine,
  delete_file: Trash2,
  execute_command: Terminal,
  read_skill: Sparkles,
  run_in_terminal: Terminal,
  send_keys: Keyboard,
  read_terminal_output: ScrollText,
  list_terminal_sessions: MonitorDot,
  'ask_followup_question': CircleQuestionMark
}

export function toolLabel(toolName: string): string {
  return TOOL_LABELS[toolName] ?? toolName
}

export function toolIcon(toolName: string): LucideIcon {
  return TOOL_ICONS[toolName] ?? Wrench
}

/** 工具调用状态：待批准（确认模式等待用户）/ 调用中 / 已完成 / 失败 / 已取消 */
export type ToolRunStatus = 'pending' | 'running' | 'done' | 'error' | 'cancelled'

/**
 * 由「是否有待批准 / 是否有结果 / 结果是否报错 / 整轮是否还在生成」推导状态。
 * 各页的确认语义不同（工作区是拒绝/允许，终端是执行/取消），但状态判定一致。
 */
export function toolRunStatus(args: {
  /** 本条调用正等待用户批准 */
  confirming: boolean
  /** 已拿到 tool-result */
  hasResult: boolean
  isError?: boolean
  /** 所属消息是否仍在生成（没结果又不在生成中 = 已取消） */
  streaming?: boolean
}): ToolRunStatus {
  if (args.confirming) return 'pending'
  if (args.hasResult) return args.isError ? 'error' : 'done'
  return args.streaming ? 'running' : 'cancelled'
}

const STATUS_META: Record<ToolRunStatus, { label: string; cls: string }> = {
  pending: { label: '待批准', cls: 'text-amber-600 dark:text-amber-400' },
  running: { label: '调用中', cls: 'text-primary' },
  done: { label: '已完成', cls: 'text-emerald-600 dark:text-emerald-400' },
  error: { label: '失败', cls: 'text-destructive' },
  cancelled: { label: '已取消', cls: 'text-muted-foreground/60' }
}

/** 优先当作「主参数」展示的字段名（按顺序取第一个命中的） */
const ARG_KEYS = [
  'path',
  'file_path',
  'filePath',
  'target',
  'command',
  'query',
  'pattern',
  'glob',
  'keys',
  'cwd',
  'dir',
  'sessionId'
]

/** 从工具入参里挑一个最能说明「这次在干什么」的字符串（横条中间那段等宽预览） */
export function toolArgPreview(input: unknown): string {
  if (input == null) return ''
  if (typeof input === 'string') return input
  if (typeof input !== 'object') return String(input)
  const obj = input as Record<string, unknown>
  for (const key of ARG_KEYS) {
    const v = obj[key]
    if (typeof v === 'string' && v.trim()) return v
    if (Array.isArray(v) && v.length > 0) {
      const joined = v.filter((x) => typeof x === 'string').join(' ')
      if (joined.trim()) return joined
    }
  }
  const first = Object.values(obj).find((v) => typeof v === 'string' && v.trim())
  return typeof first === 'string' ? first : JSON.stringify(obj)
}

/** 缩进成可读 JSON；本来就是普通字符串（文件内容、命令输出）则原样返回 */
export function formatJson(value: unknown): string {
  if (typeof value === 'string') {
    try {
      return JSON.stringify(JSON.parse(value), null, 2)
    } catch {
      return value
    }
  }
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

/** 展开体里单段文本的字符上限：太小看不到内容，太大撑爆 DOM */
const OUTPUT_LIMIT = 4000

function clip(text: string): string {
  if (text.length <= OUTPUT_LIMIT) return text
  return `${text.slice(0, OUTPUT_LIMIT)}\n…（已截断，共 ${text.length} 字符）`
}

/**
 * 工具调用横条（参考 ainav/sdk 的 ToolCallBlock，样式全部 Tailwind 重写）。
 *
 * 收起时就是一行：[工具图标] [中文名] [主参数预览] [状态] [›]；
 * 展开后依次是「参数 / 错误 / 结果」三段，每段右上角可单独复制，
 * 待批准时确认按钮由调用方通过 `confirm` 插在最后。
 *
 * 待批准时自动展开（确认按钮必须可见），用户手动收起后不再强制打开。
 */
export function ToolCallRow({
  toolName,
  input,
  output,
  isError,
  status,
  confirm,
  className
}: {
  toolName: string
  /** 工具入参（tool-call 的 input） */
  input: unknown
  /** 工具结果（tool-result 的 output）；未返回则不传 */
  output?: unknown
  isError?: boolean
  status: ToolRunStatus
  /** 待批准时的确认区（各页按钮文案不同，由调用方给） */
  confirm?: ReactNode
  className?: string
}) {
  const [open, setOpen] = useState(status === 'pending')

  // 确认请求是异步到达的：状态变成 pending 时把行展开，否则按钮藏在收起体里点不到
  useEffect(() => {
    if (status === 'pending') setOpen(true)
  }, [status])

  const Icon = toolIcon(toolName)
  const meta = STATUS_META[status]
  const inputText = input == null ? '' : clip(formatJson(input))
  const errorText = isError ? clip(formatJson(output)) : ''
  const outputText = !isError && output !== undefined ? clip(formatJson(output)) : ''
  const preview = toolArgPreview(input).replace(/\s+/g, ' ')
  const hasBody = Boolean(inputText || errorText || outputText || confirm)

  return (
    <CollapsibleRow
      className={className}
      open={open}
      onOpenChange={setOpen}
      expandable={hasBody}
      bodyClassName="flex flex-col gap-2"
      icon={
        <Icon
          className={cn(
            'size-4 shrink-0',
            status === 'pending'
              ? 'text-amber-600 dark:text-amber-400'
              : 'text-muted-foreground/70'
          )}
        />
      }
      body={
        <>
          {inputText && (
            <ToolSection title="参数" text={inputText} copyTitle="复制参数" />
          )}
          {errorText && (
            <ToolSection title="错误" text={errorText} copyTitle="复制错误" error />
          )}
          {outputText && (
            <ToolSection title="结果" text={outputText} copyTitle="复制结果" />
          )}
          {confirm}
        </>
      }
    >
      {/* 工具名与参数预览都可以缩：横条被 max-w-full 封顶后由这两段吃溢出，
          工具名封 10rem 上限（未知工具名可能很长），预览吃掉剩下的全部 */}
      <span className="max-w-[10rem] min-w-0 truncate font-medium text-foreground/80">
        {toolLabel(toolName)}
      </span>
      {preview && (
        <span className="min-w-0 truncate font-mono text-xs text-muted-foreground/70">
          {preview}
        </span>
      )}
      {status === 'running' && <Loader2 className="size-3.5 shrink-0 animate-spin text-primary" />}
      <span className={cn('shrink-0', meta.cls)}>{meta.label}</span>
    </CollapsibleRow>
  )
}

/** 展开体里的一段：小标题 + 复制 + 代码块 */
function ToolSection({
  title,
  text,
  copyTitle,
  error
}: {
  title: string
  text: string
  copyTitle: string
  error?: boolean
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-2">
        <span
          className={cn(
            'text-xs font-semibold uppercase tracking-wide',
            error ? 'text-destructive' : 'text-muted-foreground/70'
          )}
        >
          {title}
        </span>
        <MessageCopyButton text={text} title={copyTitle} />
      </div>
      {/* 不设自己的 max-height / 滚动条：滚动统一由 CollapsibleRow 的展开体承担，
          否则会出现「外层一个滚动条 + 每段一个滚动条」的套娃 */}
      <pre
        className={cn(
          'whitespace-pre-wrap break-all rounded border px-2 py-1.5',
          'font-mono text-[13px] leading-relaxed',
          error
            ? 'border-destructive/40 bg-destructive/5 text-destructive'
            : 'border-border/70 bg-muted/40 text-foreground/80'
        )}
      >
        {text}
      </pre>
    </div>
  )
}
