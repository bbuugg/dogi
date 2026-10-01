import {
  CircleCheck,
  CircleQuestionMark,
  CircleSlash,
  CircleX,
  Clock,
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
import { Tooltip } from 'antd'
import { cn } from 'cn'
import { CollapsibleRow } from '@/features/agent/CollapsibleRow'
import { MessageCopyButton } from '@/features/agent/MessageCopyButton'
import { buildFileDiff } from '@/features/agent/tool-file-diff'
import { FileDiffView } from '@/shared/components/FileDiffView'

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

/**
 * 状态以**图标**呈现（文字太占位，横条右侧只留一个记号），`label` 只做 hover 提示
 * 与无障碍名称。running 的图标自转（见下方 render）。
 *
 * ⚠️ 全部图标统一 `size-4`（与行首工具图标、右侧展开箭头同尺寸）：之前状态图标是
 * `size-3.5`，它与 16px 的两个邻居**名义尺寸和描边粗细**（lucide 描边 = 2 × 尺寸/24）
 * 都差一档 —— 三个图标摆一行时它看着又小又轻，跟左边的文字不在一个「视觉尺寸」上。
 * 行内垂直居中由 CollapsibleRow 的 `items-center` 负责（实测各项中心完全对齐），
 * 这里要保的是**光学尺寸一致**，不是靠再挪几像素去补。
 */
const STATUS_META: Record<ToolRunStatus, { label: string; Icon: LucideIcon; cls: string }> = {
  pending: { label: '待批准', Icon: Clock, cls: 'text-amber-600 dark:text-amber-400' },
  running: { label: '调用中', Icon: Loader2, cls: 'text-primary animate-spin' },
  done: { label: '已完成', Icon: CircleCheck, cls: 'text-emerald-600 dark:text-emerald-400' },
  error: { label: '失败', Icon: CircleX, cls: 'text-destructive' },
  cancelled: { label: '已取消', Icon: CircleSlash, cls: 'text-muted-foreground/60' }
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

/**
 * 从工具入参里挑一个最能说明「这次在干什么」的字符串（横条上工具名右侧那段等宽预览）。
 *
 * ⚠️ 找不到可读的字符串时返回**空串**而不是 `JSON.stringify(obj)`：像
 * `ask_followup_question` 的 `{questions:[…]}`、或 `{limit:500}` 这种纯结构化入参，
 * 序列化出来是几百字符的 JSON 噪声，截断后也读不出什么。横条上留个工具名就够 ——
 * 完整入参在展开体的「参数」段里一直都在。
 */
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
  return typeof first === 'string' ? first : ''
}

/** 超过这个长度才给预览挂 Tooltip：短值（路径 / 文件名）横条上本来就完整可见，弹提示是多余的 */
const PREVIEW_TOOLTIP_MIN = 40

/**
 * 展开体里**不显示「参数」段**的工具：参数要么在横条预览里已经写明，要么毫无信息量，
 * 摆出来只是噪音。读取类最典型 —— `{"path":"src/a.ts","offset":1,"limit":500}` 里
 * 真正有用的只有 path（横条上就有），用户关心的是读到了什么。
 *
 * 与「改文件的工具」的区别：那类是连结果一起换掉（改渲染 diff），这类只藏参数、留结果。
 */
const NO_PARAM_TOOLS = new Set(['read_file'])

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
 * 收起时就是一行：[工具图标] [中文名] [入参预览（截断）] [状态图标]；
 * 展开后：
 * - **改文件的工具**（write_file / edit_file / delete_file）显示 git 风格的**前后对比**，
 *   不显示原始入参 / 结果 —— 参数里是整份文件内容，读起来毫无意义（见 tool-file-diff.ts）；
 * - **读取类**（read_file）：展开体**只有读到的内容本身** —— 参数不显示（横条预览里
 *   已经有了），连「结果」这个标题也省掉，复制按钮 hover 时才浮现（见 NO_PARAM_TOOLS）；
 * - 其余工具依次是「参数 / 错误 / 结果」三段，每段右上角可单独复制；
 * - 待批准时确认按钮由调用方通过 `confirm` 插在最后。
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
  const StatusIcon = meta.Icon
  /** 改文件的工具：展开体换成前后对比，入参 / 结果就不再摆出来了 */
  const fileDiff = buildFileDiff(toolName, input)
  /** 读取类（见 NO_PARAM_TOOLS）：展开体只有内容本身，连「结果」这个标题也省掉 */
  const bareOutput = NO_PARAM_TOOLS.has(toolName)
  /** 该工具的入参不值得展示（diff 版或白名单里的读取类） */
  const hideParams = Boolean(fileDiff) || bareOutput
  const inputText = hideParams || input == null ? '' : clip(formatJson(input))
  const errorText = isError ? clip(formatJson(output)) : ''
  const outputText = fileDiff || isError || output === undefined ? '' : clip(formatJson(output))
  const preview = toolArgPreview(input).replace(/\s+/g, ' ')
  const hasBody = Boolean(fileDiff || inputText || errorText || outputText || confirm)

  return (
    <CollapsibleRow
      className={className}
      open={open}
      onOpenChange={setOpen}
      expandable={hasBody}
      // 「调用中」不画右侧展开箭头：还在跑的时候展开体里只有入参、没有结果可看，
      // 箭头纯属噪音（自转的状态图标已经把「进行中」说清楚了）；拿到结果（成功/失败）
      // 才出现箭头，提示那时才有值得展开的东西。仅隐藏箭头，可展开性不变。
      showChevron={status !== 'running'}
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
          {fileDiff && (
            <FileDiffView path={fileDiff.path} hunks={fileDiff.hunks} deleted={fileDiff.deleted} />
          )}
          {inputText && (
            <ToolSection title="参数" text={inputText} copyTitle="复制参数" />
          )}
          {errorText && (
            <ToolSection title="错误" text={errorText} copyTitle="复制错误" error />
          )}
          {outputText &&
            (bareOutput ? (
              // 读取类：展开体里直接就是读到的内容（见 OutputBlock）
              <OutputBlock text={outputText} copyTitle="复制内容" />
            ) : (
              <ToolSection title="结果" text={outputText} copyTitle="复制结果" />
            ))}
          {confirm}
        </>
      }
    >
      {/* 工具名 vs 入参预览：**只有预览吃溢出**。
          ⚠️ 名字必须是 shrink-0 —— 否则长预览（命令、路径、URL…）会把名字一起挤扁成省略号，
          看起来像「工具名被截断」；名字自身用 max-w 封顶（未知工具名可能很长）。
          配色：工具名/预览都比正文浅一档（正文是 foreground，这里 muted 系）——
          工具调用是「过程」，不该和正文抢注意力。

          执行状态图标在预览**之后**（本行的最右端，展开箭头之前）：命令有多长都不影响它
          待在末尾 —— 预览 min-w-0 truncate 吃溢出，图标 shrink-0 不参与收缩。
          预览超长时挂 Tooltip 给全文（截断只是 CSS，DOM 里文本是完整的）。 */}
      <span className="max-w-[10rem] shrink-0 truncate font-medium text-muted-foreground">
        {toolLabel(toolName)}
      </span>
      {preview && (
        <Tooltip title={preview.length > PREVIEW_TOOLTIP_MIN ? preview : undefined}>
          <span
            data-tool-preview
            className="min-w-0 truncate font-mono text-xs text-muted-foreground/70"
          >
            {preview}
          </span>
        </Tooltip>
      )}
      <Tooltip title={meta.label}>
        <StatusIcon aria-label={meta.label} className={cn('size-4 shrink-0', meta.cls)} />
      </Tooltip>
    </CollapsibleRow>
  )
}

/**
 * 只有内容、没有「结果」小标题的输出块（读取类工具用，见 NO_PARAM_TOOLS）。
 *
 * 读取文件时展开体里**就应该是文件内容本身** —— 顶上一行「结果 + 复制按钮」纯属噪音
 * （内容是什么一眼就看得出，不需要标题告诉用户）。
 *
 * 复制能力不丢：按钮挪到内容块的右上角、**hover 时才浮现**（用 `group/out` 局部组，
 * 不跟外层行的 hover 联动）。给 pre 留出 `pr-9`，按钮不会压住第一行的尾巴。
 */
function OutputBlock({ text, copyTitle }: { text: string; copyTitle: string }) {
  return (
    <div className="group/out relative">
      <pre
        className={cn(
          'whitespace-pre-wrap break-all rounded border border-border/70 bg-muted/40 px-2 py-1.5 pr-9',
          'font-mono text-[13px] leading-relaxed text-muted-foreground'
        )}
      >
        {text}
      </pre>
      <div className="absolute top-1 right-1 opacity-0 transition-opacity group-hover/out:opacity-100 focus-within:opacity-100">
        <MessageCopyButton text={text} title={copyTitle} className="bg-muted/80" />
      </div>
    </div>
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
            : // 比正文浅一档：工具的参数 / 结果只是过程材料，不该和正文同色
              'border-border/70 bg-muted/40 text-muted-foreground'
        )}
      >
        {text}
      </pre>
    </div>
  )
}
