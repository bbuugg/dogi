import {
  Camera,
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
  GitBranch,
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
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Image as AntImage, Tooltip } from 'antd'
import { cn } from 'cn'
import { CollapsibleRow } from '@/features/agent/CollapsibleRow'
import { ACP_KIND_LABELS, ACP_UNNAMED_TOOL } from '@shared/acp-tools'
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
  git_read: '查看 Git',
  screenshot: '网页截图',
  browser_screenshot: '页面截图',
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
  git_read: GitBranch,
  screenshot: Camera,
  browser_screenshot: Camera,
  read_skill: Sparkles,
  run_in_terminal: Terminal,
  send_keys: Keyboard,
  read_terminal_output: ScrollText,
  list_terminal_sessions: MonitorDot,
  'ask_followup_question': CircleQuestionMark
}

/** 会产出「可查看图片地址」的截图类工具（结果里带 dogi-ws:// 时卡片渲染缩略图） */
const SHOT_TOOLS = new Set(['screenshot', 'browser_screenshot'])

function isShotTool(name: string): boolean {
  return SHOT_TOOLS.has(name)
}

/**
 * **可单条停止**的工具（卡片上给一颗「停止」，只杀这一条命令的进程树）。
 *
 * 只有工作区的 `execute_command` 在主进程登记了杀手（见 command-stop.ts）——
 * 终端页的 `run_in_terminal` 是把命令送进用户自己的终端会话，进程归那个终端管，
 * 停它要走终端自己的 Ctrl-C，这里不接。ACP agent 的命令更是完全在它自己的进程里。
 */
const STOPPABLE_TOOLS = new Set(['execute_command'])

/**
 * 从工具结果里抠出第一个 `dogi-ws://` 图片地址（主进程拼好放在结果文本里）。
 * 只在截图类工具上调用 —— 别的工具结果里出现这个 scheme 的概率极低，不误伤。
 */
function firstWorkspaceMediaUrl(text: string): string | null {
  const m = /dogi-ws:\/\/[^\s)"'<>]+/.exec(text)
  return m ? m[0] : null
}

/**
 * 工具卡**头部标题**：内置工具名 → ACP 种类（`acpKind`）→ 原始名。
 *
 * 严格对齐 fishwork `lib/parts.ts` 的 `toolCardTitle`：
 * - 内置工具（`read_file` / `execute_command` …）用内置中文名；
 * - 命中占位名（ACP agent 没给 `name`）时，**拿 `kind` 翻中文名**（`读取` / `编辑文件` /
 *   `执行命令` …）—— 这才是「工具名」的来源，绝不退化成一刀切的「工具调用」；
 * - ⚠️ 这条路**永远不碰 `title`**：title 是文件路经 / 整段命令，详见 `ToolCallRow` 的明细；
 * - 以上都没有：说明这是 agent 自己报的名字，原样显示。
 */
export function toolCardTitle(name: string, kind?: string): string {
  const builtin = TOOL_LABELS[name]
  if (builtin) return builtin
  if (!name || name === ACP_UNNAMED_TOOL) {
    return (kind ? ACP_KIND_LABELS[kind] : undefined) ?? ACP_KIND_LABELS[ACP_UNNAMED_TOOL]
  }
  return ACP_KIND_LABELS[name] ?? ACP_KIND_LABELS[name.toLowerCase()] ?? name
}

export function toolLabel(toolName: string): string {
  return toolCardTitle(toolName)
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

/** 优先当作「主参数」展示的字段名（按顺序取第一个命中的）。对齐 fishwork 的 renderBuiltinDirect */
const ARG_KEYS = [
  'path',
  'file_path',
  'filePath',
  'command',
  'cmd',
  'query',
  'pattern',
  'keyword',
  'name',
  'skill',
  'target',
  'url',
  'glob',
  'keys',
  'cwd',
  'dir',
  'sessionId'
]

/**
 * 从工具入参里挑一个最能说明「这次在干什么」的字符串（横条上工具名右侧那段等宽预览）。
 * 与 fishwork 的 `renderBuiltinDirect` 对齐：命令类加 `$ ` 前缀（命令不放内容区第一块，
 * 折叠态下也能直接看到跑的是什么），其余工具取主入参（路径 / 查询 / 名称…）。
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
  let subject = ''
  for (const key of ARG_KEYS) {
    const v = obj[key]
    if (typeof v === 'string' && v.trim()) {
      subject = v
      break
    }
    if (Array.isArray(v) && v.length > 0) {
      const joined = v.filter((x) => typeof x === 'string').join(' ')
      if (joined.trim()) {
        subject = joined
        break
      }
    }
  }
  if (!subject) {
    const first = Object.values(obj).find((v) => typeof v === 'string' && v.trim())
    if (typeof first === 'string') subject = first
  }
  if (!subject) return ''
  // 命令类加 `$ ` 前缀，与 fishwork 一致：一眼看出是条要执行的命令
  if ('command' in obj || 'cmd' in obj) return `$ ${subject}`
  return subject
}

/** JSON 字符串里的转义 → 真字符（只覆盖模型写文件时真会用的那几个） */
const JSON_UNESCAPE: Record<string, string> = {
  n: '\n',
  t: '\t',
  r: '\r',
  b: '\b',
  f: '\f',
  '"': '"',
  '\\': '\\',
  '/': '/'
}

/**
 * 从**可能截断**的入参 JSON 文本里抠一个字符串字段的值（工具入参流式生成期用）。
 *
 * 那时候的入参是半截 JSON（`JSON.parse` 必抛），所以不追求解析出完整对象 ——
 * 按 `"key"` 定位后一路扫到**未转义的**收尾引号，扫到末尾仍没闭合就取到末尾。
 * 只喂渲染：抠不出来返回 undefined（调用方据此回退），这份文本永不落盘，
 * 收口时以完整 `tool-call` 的 `input` 为准（与 fishwork `lib/parts.ts` 同一实现）。
 */
function partialJsonString(text: string, key: string): string | undefined {
  const head = text.indexOf(`"${key}"`)
  if (head < 0) return undefined
  let i = head + key.length + 2
  // 跳过冒号与空白
  while (i < text.length && /[\s:]/.test(text[i])) i += 1
  if (text[i] !== '"') return undefined
  let out = ''
  for (i += 1; i < text.length; i += 1) {
    const ch = text[i]
    if (ch === '\\') {
      const next = text[i + 1]
      // 半截转义序列（文本正好停在反斜杠上）：就此收尾，别把孤立的反斜杠画出来
      if (next === undefined) break
      out += JSON_UNESCAPE[next] ?? next
      i += 1
      continue
    }
    if (ch === '"') break
    out += ch
  }
  return out
}

/**
 * 入参**流式生成期**的预览：从半截 JSON 里抠出「横条明细」（路径 / 命令）+「正在生成的内容」。
 *
 * 与 `buildFileDiff` 的分工：那个吃完整 `input`、生成前后对比；这个吃 `inputText`、
 * 只给一坨正在变长的文本。两者不会同时命中（有 `inputText` 就说明还没收口）。
 * 返回 null = 抠不出可看的东西，调用方按普通横条渲染（不展开空壳）。
 */
function streamingToolPreview(inputText: string): { detail?: string; text?: string } | null {
  if (!inputText.trim()) return null
  const path =
    partialJsonString(inputText, 'path') ||
    partialJsonString(inputText, 'file_path') ||
    partialJsonString(inputText, 'filePath')
  const command = partialJsonString(inputText, 'command') || partialJsonString(inputText, 'cmd')
  // edit_file 的新内容是 newString（旧会话历史里是 newText），write_file 的是 content
  const content =
    partialJsonString(inputText, 'content') ||
    partialJsonString(inputText, 'newString') ||
    partialJsonString(inputText, 'newText')
  // 命令类：命令本身就够看（走横条明细），没有别的可展开内容
  if (command) return { detail: `$ ${command}` }
  if (path || content) {
    return {
      ...(path ? { detail: path } : {}),
      ...(content ? { text: content } : {})
    }
  }
  return null
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
  className,
  title,
  acpKind,
  inputText,
  liveOutput,
  onStop
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
  /** ACP 工具的人类可读描述（路径 / 命令等），只作「工具名后面的明细」兜底展示，绝不进工具名 */
  title?: string
  /** ACP 协议的工具种类（read / edit / execute …）：拿不到 name 时靠它翻出中文工具名 */
  acpKind?: string
  /**
   * **入参还在流式生成**时攒下的半截 JSON 文本（`AgentMessagePart` 的 `inputText`）。
   *
   * 传了它就切进「正在生成」形态：横条明细从半截 JSON 里抠（路径 / 命令），
   * 展开体铺一坨随增量变长的内容 —— 写文件这类入参数 KB 起的调用从「一直转圈」
   * 变成「肉眼可见在打字」。完整 tool-call 到达后该字段被摘掉，自动回到 diff / 参数形态。
   */
  inputText?: string
  /**
   * **命令执行期间**的实时输出（stdout / stderr 各一份，见 `AgentMessagePart` 的 `liveOutput`）。
   *
   * 只在**可单条停止**的命令（`execute_command`）处于 `running` 时渲染成「实时输出」块 ——
   * 命令一边跑一边出结果，而不是等跑完才一次性显示。命令结束（拿到 tool-result）后
   * 该字段被清掉、本块让位给结果直显。对齐 fishwork 的 `LiveOutputBlock`。
   */
  liveOutput?: { stdout: string; stderr: string }
  /**
   * 「停止这条命令」的回调。只在**可单条停止**的工具（见 `STOPPABLE_TOOLS`）处于
   * `running` 时才会渲染出按钮 —— 调用方无脑传即可，是否显示由本组件判定。
   *
   * ⚠️ 与调用方的「停止整轮」是两回事：那个掐掉整个回合（含还没跑的步骤），
   * 这个只杀这一条命令、本轮继续（见主进程 command-stop.ts）。
   */
  onStop?: () => void
}) {
  const [open, setOpen] = useState(status === 'pending')

  // 确认请求是异步到达的：状态变成 pending 时把行展开，否则按钮藏在收起体里点不到
  useEffect(() => {
    if (status === 'pending') setOpen(true)
  }, [status])

  const Icon = toolIcon(toolName)
  const meta = STATUS_META[status]
  const StatusIcon = meta.Icon
  /**
   * 这条命令**正在跑**（已启动、还没结果）：铺实时输出区 + 自动展开。
   *
   * ⚠️ 判据刻意**不看 `liveOutput` 在不在**：那个字段只在**第一段输出到达**时才被创建，
   * 而「在跑但什么都不吐」的命令（`sleep 30` / 长编译 / 等网络）整轮都没有输出 ——
   * 拿它当判据会让这类命令退化成一行头部、用户看不到任何「它在跑」的迹象
   * （fishwork 也踩过同一个坑，见其 `isCommandRunning` 的注释）。
   */
  const commandRunning = status === 'running' && STOPPABLE_TOOLS.has(toolName)
  /** 入参流式生成期的预览（null = 没在流式生成，或半截 JSON 里还抠不出可看的东西） */
  const streaming = typeof inputText === 'string' ? streamingToolPreview(inputText) : null
  /** 正在生成的内容（要有它才自动展开 / 吸底：命令类只有横条明细，展开是一片空白） */
  const streamingText = streaming?.text
  /**
   * 入参一帧帧在长，这张卡本来就是给用户看的「正在写什么」→ 有内容就展开、随内容吸底；
   * 收口后自动收回，与思考条「思考中展开、结束收起」同一观感。
   *
   * ⚠️ 依赖是**布尔值**而不是那段在变的文本：流式期间用户手动收起后，后面每来一帧
   * 都会重跑 effect 把它强行撑开。
   * ⚠️ 也**不能用 useState 初值**，且收起要走 `autoOpenedRef`：上面那条「待批准就展开」
   * 的 effect 在挂载时可能已经把行撑开了（确认卡先于首次渲染到达），无条件 setOpen(false)
   * 会把确认按钮埋进收起体里 — 只收「自己撑开的那一次」。
   *
   * 命令运行中同样自动展开（实时输出是这块卡存在的意义，折叠起来等于白流）。
   */
  const autoOpen = Boolean(streamingText) || commandRunning
  const autoOpenedRef = useRef(false)
  useEffect(() => {
    if (autoOpen) {
      autoOpenedRef.current = true
      setOpen(true)
    } else if (autoOpenedRef.current) {
      autoOpenedRef.current = false
      setOpen(false)
    }
  }, [autoOpen])
  /** 改文件的工具：展开体换成前后对比，入参 / 结果就不再摆出来了（流式生成期还没有完整入参） */
  const fileDiff = streaming ? null : buildFileDiff(toolName, input)
  /** 读取类（见 NO_PARAM_TOOLS）：展开体只有内容本身，连「结果」这个标题也省掉 */
  const bareOutput = NO_PARAM_TOOLS.has(toolName)
  /**
   * 该工具的入参不值得展示（diff 版或白名单里的读取类）。
   * 命令**运行中**也藏参数：命令本身已经在横条明细里（`$ …`），再摆一份
   * `{"command":"…"}` 的 JSON 纯属噪音 —— 运行中要看的只有实时输出。
   */
  const hideParams = Boolean(fileDiff) || bareOutput || commandRunning
  const paramsText = hideParams || input == null ? '' : clip(formatJson(input))
  const errorText = isError ? clip(formatJson(output)) : ''
  /** 结果全文（未截断）：截图地址在文本末尾，截断后再抠可能抠不到 */
  const outputFull = fileDiff || isError || output === undefined ? '' : formatJson(output)
  const outputText = clip(outputFull)
  // 截图类工具的产物：结果里带 `dogi-ws://` 图片地址时直接渲染缩略图（可点击放大），
  // 否则用户只看到一个文件路径，等于没截
  const shotUrl = isShotTool(toolName) ? firstWorkspaceMediaUrl(outputFull) : null
  // 工具名后面的明细：优先取入参里最能说明「在干什么」的主参数（路径 / 命令 / 查询…），
  // ACP 工具入参偏薄（或压根没有）时回退到 agent 给的 title（路径 / 命令描述）。
  // 入参还在生成时没有可用的 input，改从半截 JSON 里抠（抠出路径 / 命令就显示）。
  // ⚠️ title 只进这里、绝不进工具名（见 toolLabelOf）：否则脚本 / 命令类会把整段命令顶替工具名。
  const preview = (streaming?.detail || toolArgPreview(input) || title || '').replace(/\s+/g, ' ')
  const hasBody = Boolean(
    fileDiff || streamingText || commandRunning || paramsText || errorText || outputText || confirm
  )
  /** 这条命令还在跑、且调用方接了单条停止 → 横条上给一颗「停止」（见 STOPPABLE_TOOLS） */
  const canStop = status === 'running' && Boolean(onStop) && STOPPABLE_TOOLS.has(toolName)

  return (
    <CollapsibleRow
      className={className}
      open={open}
      onOpenChange={setOpen}
      expandable={hasBody}
      // 「调用中」不画右侧展开箭头：还在跑的时候展开体里只有入参、没有结果可看，
      // 箭头纯属噪音（自转的状态图标已经把「进行中」说清楚了）；拿到结果（成功/失败）
      // 才出现箭头，提示那时才有值得展开的东西。仅隐藏箭头，可展开性不变。
      // ⚠️ 例外是**入参流式生成期**：卡片本来就在展开着给用户看「正在写什么」，
      // 箭头必须在 —— 否则用户手动收起后，这行看上去就不能点开了（可展开性其实没变）。
      showChevron={status !== 'running' || autoOpen}
      // 入参流式生成期随内容吸底（内容一直变长，不跟随就看不到最新几行）
      stickToBottom={autoOpen}
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
          {streamingText && <StreamingInputBlock text={streamingText} />}
          {commandRunning && (
            <LiveOutputBlock live={liveOutput ?? { stdout: '', stderr: '' }} />
          )}
          {fileDiff && (
            <FileDiffView path={fileDiff.path} hunks={fileDiff.hunks} deleted={fileDiff.deleted} />
          )}
          {paramsText && (
            <ToolSection title="参数" text={paramsText} copyTitle="复制参数" />
          )}
          {shotUrl && (
            <div className="w-fit overflow-hidden rounded-md border border-border">
              <AntImage
                src={shotUrl}
                alt="截图"
                className="max-h-80 w-auto"
                preview={{ mask: <div className="text-xs text-white/90">点击放大</div> }}
              />
            </div>
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
        {toolCardTitle(toolName, acpKind)}
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
      {canStop && (
        // 「停止」在状态图标**之前**：状态图标是这一行固定的收尾记号（与展开箭头一起
        // 贴右端），中间插一个会动的按钮会让它在有/无之间来回跳。
        <Tooltip title="停止这条命令（本轮其它步骤照常继续）">
          <button
            type="button"
            aria-label="停止这条命令"
            onClick={(e) => {
              // 横条整行可点（展开/收起），别让这次点击顺带把它折起来
              e.stopPropagation()
              onStop?.()
            }}
            className={cn(
              'shrink-0 rounded border border-border px-1.5 text-[11px] leading-4',
              'text-muted-foreground transition-colors',
              'hover:border-destructive/50 hover:bg-destructive/10 hover:text-destructive'
            )}
          >
            停止
          </button>
        </Tooltip>
      )}
      <Tooltip title={meta.label}>
        <StatusIcon aria-label={meta.label} className={cn('size-4 shrink-0', meta.cls)} />
      </Tooltip>
    </CollapsibleRow>
  )
}

/**
 * 入参**流式生成期**的「正在生成…」块：随增量一帧帧变长的等宽文本。
 *
 * 与展开体里的「参数 / 结果」段同款（`ToolSection`），只是没有小标题的复制按钮 ——
 * 内容还在变，复制它没有意义。
 *
 * ⚠️ **不设自己的 max-height / overflow**：滚动统一由 CollapsibleRow 的展开体承担，
 * 否则会出现「外层一个滚动条 + 这里一个滚动条」的套娃（见 AGENTS 6.18）。
 */
function StreamingInputBlock({ text }: { text: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-semibold tracking-wide text-muted-foreground/70">
        正在生成…
      </span>
      <pre
        className={cn(
          'whitespace-pre-wrap break-all rounded border border-border/70 bg-muted/40 px-2 py-1.5',
          'font-mono text-[13px] leading-relaxed text-muted-foreground'
        )}
      >
        {text}
      </pre>
    </div>
  )
}

/**
 * 命令**实时输出**块（`execute_command` 运行中铺在展开体里）。
 *
 * 两条流合并展示：stderr 接在 stdout 之后（行首的 `[stderr] ` 前缀已在数据里，
 * 视觉上能区分）。合并顺序与最终 `tool-result` 的拼法一致（stdout 在前、stderr 在后），
 * 命令结束时卡片从「实时输出」平滑换成结果直显，读起来是同一份东西。
 *
 * ⚠️ **没有输出也要照常渲染这一块**：`live` 可能是全空（命令刚起步、或压根不吐东西）。
 * 这块是用户「这条命令在跑」的唯一视觉反馈，撤掉的话长编译 / `sleep` 这类沉默命令
 * 看起来就像卡死了。状态句随之换 —— 「实时输出中…」/「命令运行中，暂无输出」。
 *
 * ⚠️ **不设自己的 max-height / overflow**：滚动统一由 `CollapsibleRow` 的展开体承担
 * （它已经带 `max-h-64` + `stickToBottom` 吸底），否则会出现「外层一个滚动条 + 这里
 * 一个滚动条」的套娃（见 AGENTS 6.18）。
 */
function LiveOutputBlock({ live }: { live: { stdout: string; stderr: string } }) {
  const text = live.stderr
    ? live.stdout + (live.stdout && !live.stdout.endsWith('\n') ? '\n' : '') + live.stderr
    : live.stdout
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-semibold tracking-wide text-muted-foreground/70">
        {text ? '实时输出中…' : '命令运行中，暂无输出'}
      </span>
      <pre
        className={cn(
          'whitespace-pre-wrap break-all rounded border border-border/70 bg-muted/40 px-2 py-1.5',
          'font-mono text-[13px] leading-relaxed text-muted-foreground'
        )}
      >
        {text || '（这个命令还没有产生任何 stdout / stderr。它可能正在跑，也可能一直沉默。）'}
      </pre>
    </div>
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
