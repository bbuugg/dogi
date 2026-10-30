'use client'

/**
 * 多智能体协作画布：主智能体 + 可配置子 Agent，实时显示状态 / 任务 / 消息。
 *
 * 画布只负责**可视化与配置**，真正的编排在 `@fizz/agent` 的 `CollabRuntime`；
 * 右侧那块对话区由 `ConversationTab` 组合：默认是主智能体的 `ChatPanel`，
 * 点画布上任意一个子 Agent 就换成 `CollabAgentChatPanel`（原地替换，不弹窗、不新开标签）。
 * 节点位置属于协作配置，拖拽结束后整份 PATCH。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity,
  Bot,
  ChevronRight,
  CircleStop,
  LayoutGrid,
  Link2,
  Loader2,
  MessagesSquare,
  Network,
  Pencil,
  Plus,
  Settings2,
  Sparkles,
  Trash2,
  Unlink,
  X
} from 'lucide-react'
import {
  Background,
  BackgroundVariant,
  BaseEdge,
  Controls,
  EdgeLabelRenderer,
  Handle,
  MarkerType,
  PanOnScrollMode,
  Position,
  ReactFlow,
  SelectionMode,
  getSmoothStepPath,
  useNodesState,
  type Connection,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { Button } from '@fizz/ui/button'
import { Badge } from '@fizz/ui/badge'
import { Label } from '@fizz/ui/label'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@fizz/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@fizz/ui/select'
import { Switch } from '@fizz/ui/switch'
import { cn } from '@fizz/agent-kit/shared/lib/utils'
import { toolLabel } from '@fizz/agent-kit/shared/lib/parts'
import { useConfirm } from '@fizz/agent-kit/shared/components/ConfirmProvider'
import { useIsMobile } from '@fizz/agent-kit/shared/hooks/useIsMobile'
import { useTheme } from '@fizz/agent-kit/shared/hooks/useTheme'
import { useT } from '@fizz/agent-kit/shared/lib/language'
import type { AgentApp } from '@fizz/agent-kit/shared/hooks/useAgentApp'
import { AgentConfigDialog } from '@fizz/agent-kit/features/collab/AgentConfigDialog'
import {
  EMPTY_MESSAGES,
  EMPTY_STATUSES,
  EMPTY_TASKS,
  STATUS_META,
  displayLiveText
} from '@fizz/agent-kit/features/collab/agent-messages'
import {
  COLLAB_MAIN_ID,
  DEFAULT_COLLAB_SETTINGS,
  createCollabAgent,
  normalizeCollabSettings,
  type CollabAgentConfig,
  type CollabAgentRuntime,
  type CollabAgentStatus,
  type CollabEdge,
  type CollabMessage,
  type CollabTask,
  type CollabSettings
} from '@fizz/contracts/types'

/** 主智能体在画布上的节点 id —— 与契约里的 `COLLAB_MAIN_ID` 必须同一个值 */
const MAIN_ID = COLLAB_MAIN_ID
const NODE_W = 250
const NODE_H = 148
/**
 * 接线边的画布 id 前缀。
 *
 * 画布上有两类边：**接线**（来自 `settings.edges`，配置）和**通信**（按任务运行态现算）。
 * 前缀把两类分开 —— 键盘删除只认接线，`onEdgeClick` 也靠它判断点的是哪一类。
 */
const TOPOLOGY_EDGE_PREFIX = 'topology:'

/*
 * 空值常量（`EMPTY_STATUSES` / `EMPTY_TASKS` / ...）、状态配色（`STATUS_META`）与
 * 「任务流水 → 消息列表」的拼装都搬去了 `agent-messages.ts`：右侧对话区的
 * `CollabAgentChatPanel` 与这张画布必须看到**同一份**消息与同一套状态文案，别再在这里写第二份。
 *
 * ⚠️ 那边的常量仍然是模块级稳定的 —— 它们进同步节点的 effect 依赖，`?? {}` / `?? []`
 * 每次渲染都是新引用，会 setNodes → 重渲染 → 再 setNodes，最终 React #185。
 */

interface NodeAccent {
  /** 节点边框 / 小地图颜色（与流程画布的角色色同一套观感） */
  border: string
  /** 头部底色 */
  bg: string
  color: string
}

const MAIN_ACCENT: NodeAccent = {
  border: 'border-violet-300 dark:border-violet-700',
  bg: 'bg-violet-50 dark:bg-violet-950/30',
  color: '#8b5cf6'
}

const SUB_ACCENTS: NodeAccent[] = [
  { border: 'border-sky-300 dark:border-sky-700', bg: 'bg-sky-50 dark:bg-sky-950/30', color: '#0284c7' },
  { border: 'border-emerald-300 dark:border-emerald-700', bg: 'bg-emerald-50 dark:bg-emerald-950/30', color: '#10b981' },
  { border: 'border-amber-300 dark:border-amber-700', bg: 'bg-amber-50 dark:bg-amber-950/30', color: '#f59e0b' },
  { border: 'border-rose-300 dark:border-rose-700', bg: 'bg-rose-50 dark:bg-rose-950/30', color: '#f43f5e' },
  { border: 'border-cyan-300 dark:border-cyan-700', bg: 'bg-cyan-50 dark:bg-cyan-950/30', color: '#06b6d4' }
]

interface Point {
  x: number
  y: number
}

/** 列步长：卡片宽 250 + 100 间距 */
const COL_STEP = 350
/** 行步长：卡片高约 120 + 80 间距 */
const ROW_STEP = 200
/**
 * 主节点固定落位（它不可拖，位置不落盘）：横向居中在三列之上
 * （列中心 40 + 350 + 125 = 515，节点宽 250 → x = 390）。
 */
const MAIN_POSITION: Point = { x: 390, y: 30 }
/**
 * 第一行子节点的 y。
 *
 * 主节点底部是**唯一**的接线位（出 / 入叠在同一个点上），而它的底边在 y≈150 附近：
 * 子节点要是从 190 起排，缝隙只剩 40px，第三个 Agent 加进来后卡片正好把这颗点围住 ——
 * 想从主智能体拉一条线出去，既没有地方下拖，拖出来也被卡片盖住读不出连的是谁。
 * 留 120px 的走线通道，三条线并排也看得清。
 */
const FIRST_ROW_Y = 270

function defaultPosition(index: number): Point {
  return {
    x: 40 + (index % 3) * COL_STEP,
    y: FIRST_ROW_Y + Math.floor(index / 3) * ROW_STEP
  }
}

/**
 * 新增 Agent 的落位：跳过已被占用的槽位。
 *
 * 直接按 `agents.length` 取第 N 个槽有个坑 —— 删过 Agent 之后 index 会撞上仍在用的位置，
 * 新卡片直接叠在老卡片上（表现就是「点了添加，画布上什么都没多出来」）。
 */
function freePosition(agents: readonly CollabAgentConfig[]): Point {
  const occupied = (spot: Point): boolean =>
    agents.some((agent, index) => {
      const at = agent.position ?? defaultPosition(index)
      return Math.abs(at.x - spot.x) < COL_STEP / 2 && Math.abs(at.y - spot.y) < ROW_STEP / 2
    })
  for (let index = 0; index < 500; index += 1) {
    const spot = defaultPosition(index)
    if (!occupied(spot)) return spot
  }
  return defaultPosition(agents.length)
}

function mainSpec(settings: CollabSettings): CollabAgentConfig {
  return {
    id: MAIN_ID,
    name: settings.mainName || '主智能体',
    role: '与用户对话、拆解任务、派活、汇总结果',
    instructions: '',
    permissionMode: 'confirm',
    tools: []
  }
}

/** React Flow 的协作节点数据（位置由节点自身持有，运行态每次渲染重新灌进来） */
interface CollabFlowNodeData {
  /** React Flow 要求 data 可索引（v12 的 Node 约束） */
  [key: string]: unknown
  agent: CollabAgentConfig
  isMain: boolean
  /** 主智能体连不上的子 Agent（画布上标出来，否则用户不知道为什么派不过去） */
  unreachable?: boolean
  accent: NodeAccent
  status: CollabAgentRuntime
  /**
   * ⚠️ 这里**刻意不放任务正文与流式文本**：那两样一秒能变十几次，灌进节点 data 会让
   * `useNodesState` 的同步 effect 每帧重建节点（画布闪烁），而且卡片上也读不全。
   * 要看内容就点节点把右侧对话区换成它（`CollabAgentChatPanel` 从 `tasks` 现取）。
   */
  selected: boolean
  onSelect: () => void
  onEdit?: () => void
  onDelete?: () => void
  onCancel?: () => void
}

type CollabFlowNode = Node<CollabFlowNodeData, 'collab'>

function CollabAgentNode({ data }: NodeProps<CollabFlowNode>) {
  const meta = STATUS_META[data.status.status]
  /**
   * 按下时的指针位置。
   *
   * 点一下卡片要弹消息窗，但**拖完松手浏览器照样会补一个 click** —— 不区分的话每次拖完
   * 节点都会莫名其妙弹一次窗。用位移判断：超过 4px 就当拖拽（React Flow 的
   * `nodeDragThreshold` 是 1，4px 之内基本没动，仍算点击）。
   */
  const downRef = useRef<{ x: number; y: number } | null>(null)
  return (
    <div
      className={cn(
        // 高度**跟着内容走**：卡片上只剩名字 / 职责 / 状态，任务与流式正文都搬进了
        // 点开后的弹窗（和主会话同一套消息列表）—— 写死高度只会留一片空白。
        'flex w-[250px] flex-col overflow-hidden rounded-xl border-2 bg-card text-card-foreground shadow-lg transition-all',
        data.accent.border,
        data.selected && 'ring-2 ring-offset-2 ring-offset-background'
      )}
      style={data.selected ? { ['--tw-ring-color' as string]: data.accent.color } : undefined}
      onPointerDown={(event) => {
        downRef.current = { x: event.clientX, y: event.clientY }
      }}
      onClick={(event) => {
        const down = downRef.current
        downRef.current = null
        if (down && Math.hypot(event.clientX - down.x, event.clientY - down.y) > 4) return
        data.onSelect()
      }}
    >
      {data.isMain ? (
        /*
         * 主智能体：底边**一个**接线位，出 / 入两个 Handle 叠在同一个点上（视觉上只有一个）。
         * 以前是「每个子 Agent 一个接线位」，但那样拖线时用户根本分不清哪个点对应谁 ——
         * 现在接线可编辑了，统一成一个点才拖得动。
         *
         * ⚠️ 顺序不能反：后渲染的那个盖在上面，**必须让 source 在上**。
         * 反过来的话从这颗点拖出来的是一条「以主智能体为终点」的线（严格模式下要去连
         * 别人的 source），而 `isValidConnection` 又禁掉 target === main —— 表现就是
         * 「怎么拖都连不上」。
         */
        <>
          <Handle
            id="main-in"
            type="target"
            position={Position.Bottom}
            className="h-3 w-3 border-2 border-background"
            style={{ backgroundColor: data.accent.color, left: '50%' }}
          />
          <Handle
            id="main-out"
            type="source"
            position={Position.Bottom}
            className="h-3 w-3 border-2 border-background"
            style={{ backgroundColor: data.accent.color, left: '50%' }}
          />
        </>
      ) : (
        // 子 Agent：进出都在顶边（同一个点），线从上方进来、也从上方出去。
        // 同样让 source 后渲染（压在上面）：从这颗点拖出来的线是「我派给别人」。
        <>
          <Handle
            id="sub-in"
            type="target"
            position={Position.Top}
            className="h-3 w-3 border-2 border-background"
            style={{ backgroundColor: data.accent.color, left: '50%' }}
          />
          <Handle
            id="sub-out"
            type="source"
            position={Position.Top}
            className="h-3 w-3 border-2 border-background"
            style={{ backgroundColor: data.accent.color, left: '50%' }}
          />
        </>
      )}
      <div className={cn('flex items-center gap-2 rounded-t-[10px] px-3 py-2', data.accent.bg)}>
        <div
          className="flex size-7 shrink-0 items-center justify-center rounded-lg"
          style={{ backgroundColor: data.accent.color }}
        >
          {data.isMain ? (
            <Sparkles className="size-4 text-white" />
          ) : (
            <Bot className="size-4 text-white" />
          )}
        </div>
        <span className="truncate text-sm font-semibold text-foreground">{data.agent.name}</span>
        <span className={cn('ml-auto flex shrink-0 items-center gap-1 text-[0.625rem]', meta.text)}>
          <span className={cn('size-2 rounded-full', meta.dot)} />
          {meta.label}
        </span>
      </div>
      {/*
        卡片上**不显示任务与流式正文**：这两样变化最快，写在卡片上会让节点高度一直抖，
        也读不全。点卡片把右侧对话区换成这个 Agent（`CollabAgentChatPanel`，与主会话
        同一套 `MessageList`），完整历史在那里看。
      */}
      <div className="px-3 py-2">
        <p className="line-clamp-2 text-xs leading-snug text-muted-foreground">
          {data.agent.role || '通用协作助手'}
        </p>
        {data.unreachable && (
          <p className="mt-1 text-[0.65rem] leading-snug text-amber-600 dark:text-amber-400">
            未接线：主智能体派不到它
          </p>
        )}
      </div>
      <div className="flex items-center gap-1 px-2 py-1">
        {data.status.toolName && (
          <span className="truncate text-[0.65rem] text-muted-foreground">
            {toolLabel(data.status.toolName)}
          </span>
        )}
        <div className="nodrag ml-auto flex items-center gap-0.5">
          {data.onCancel && (
            <Button
              size="sm"
              variant="ghost"
              className="h-6 w-6 p-0"
              title="取消这个任务"
              onClick={(event) => {
                event.stopPropagation()
                data.onCancel?.()
              }}
            >
              <CircleStop className="size-3.5" />
            </Button>
          )}
          {data.onEdit && (
            <Button
              size="sm"
              variant="ghost"
              className="h-6 w-6 p-0"
              title="编辑"
              onClick={(event) => {
                event.stopPropagation()
                data.onEdit?.()
              }}
            >
              <Pencil className="size-3.5" />
            </Button>
          )}
          {data.onDelete && (
            <Button
              size="sm"
              variant="ghost"
              className="h-6 w-6 p-0 text-muted-foreground hover:text-destructive"
              title="删除"
              onClick={(event) => {
                event.stopPropagation()
                data.onDelete?.()
              }}
            >
              <Trash2 className="size-3.5" />
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}

const COLLAB_NODE_TYPES = { collab: CollabAgentNode }

interface CollabEdgeData {
  label: string
  fromLabel: string
  toLabel: string
  tool?: string
  completed?: boolean
  [key: string]: unknown
}

type CollabFlowEdge = Edge<CollabEdgeData, 'comm'>

function CollabCommEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  style,
  data
}: EdgeProps<CollabFlowEdge>) {
  const [path, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition
  })
  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} style={style} />
      <EdgeLabelRenderer>
        <div
          className={cn(
            'pointer-events-none absolute max-w-[190px] rounded-md border bg-card/95 px-2 py-1 text-[0.65rem] leading-snug shadow-sm backdrop-blur',
            data?.completed && 'border-dashed bg-muted/80'
          )}
          style={{
            transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`
          }}
        >
          <span className="block font-medium text-foreground/70">
            {data?.fromLabel} → {data?.toLabel}
          </span>
          <span className="line-clamp-2 break-words text-foreground/85">{data?.label}</span>
          {data?.tool && (
            <span className="mt-0.5 inline-flex max-w-full items-center truncate rounded bg-muted px-1 py-px font-mono text-[0.6rem] text-muted-foreground">
              {data.tool}
            </span>
          )}
        </div>
      </EdgeLabelRenderer>
    </>
  )
}

/**
 * 「接线」边：谁可以派活给谁。**虚线 + 常驻的小叉**，与运行时那条实线（真实发生的
 * 派活 / 交结果）区分开 —— 一条是配置，一条是这次跑出来的事实。
 *
 * 删除按钮挂在线的中点：`EdgeLabelRenderer` 的内容默认 `pointer-events: none`
 * （否则整块画布都点不动），所以按钮自己必须显式 `pointer-events-auto`。
 */
interface CollabTopologyEdgeData {
  onRemove?: () => void
  [key: string]: unknown
}

type CollabTopologyFlowEdge = Edge<CollabTopologyEdgeData, 'topology'>

function CollabTopologyEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  style,
  selected,
  data
}: EdgeProps<CollabTopologyFlowEdge>) {
  const [path, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition
  })
  return (
    <>
      {/*
        选中态自己画：`style` 里的 stroke 是内联的，会盖掉 React Flow 默认的
        `.selected` 样式，所以「被选中」得显式换成主色 + 加粗，否则按 Delete 前
        根本看不出删的是哪条线。
      */}
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        style={{
          ...style,
          stroke: selected ? 'var(--primary)' : 'var(--border)',
          strokeWidth: selected ? 2.5 : 1.5
        }}
      />
      <EdgeLabelRenderer>
        <div
          className="absolute"
          style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
        >
          <button
            type="button"
            title="断开这条接线"
            aria-label="断开这条接线"
            className="pointer-events-auto flex size-5 items-center justify-center rounded-full border border-border bg-card text-muted-foreground shadow-sm transition-colors hover:border-destructive hover:text-destructive"
            onClick={(event) => {
              event.stopPropagation()
              data?.onRemove?.()
            }}
          >
            <X className="size-3" />
          </button>
        </div>
      </EdgeLabelRenderer>
    </>
  )
}

const COLLAB_EDGE_TYPES = { comm: CollabCommEdge, topology: CollabTopologyEdge }

export function CollabWorkspace({
  app,
  viewingAgentId,
  onViewAgent
}: {
  app: AgentApp
  /**
   * 右侧对话区正在看哪个子 Agent（null = 主智能体）。
   *
   * 状态**由 `ConversationTab` 持有**，不在这里：右侧那块面板不是画布的子节点
   * （画布在左、对话在右，手机上画布在上、对话在下），只有共同的父级能同时影响两边。
   */
  viewingAgentId: string | null
  /** 请求右侧对话区换成某个 Agent 的消息（null = 换回主智能体） */
  onViewAgent: (agentId: string | null) => void
}) {
  // 订阅语言：画布顶栏那几个按钮 / 角标的文案在渲染期用 `tr()` 现算
  const tr = useT()
  const confirm = useConfirm()
  const mobile = useIsMobile()
  const conversation = app.conversations.find((c) => c.id === app.activeConversationId)
  const settings = useMemo(
    () => normalizeCollabSettings(conversation?.collab ?? DEFAULT_COLLAB_SETTINGS),
    [conversation?.collab]
  )
  const state = app.collab?.state
  const [selected, setSelected] = useState<string>(MAIN_ID)
  const [editing, setEditing] = useState<{ agent: CollabAgentConfig; isNew: boolean } | null>(null)
  const [logOpen, setLogOpen] = useState(false)
  /*
   * 对话区被**外部**切回主智能体时（面板头部那颗返回箭头），画布上的选中环也要回到主节点 ——
   * 否则会出现「右侧已经是主对话、画布还圈着某个子 Agent」的错位，键盘 Delete 也会删错人。
   */
  useEffect(() => {
    setSelected(viewingAgentId ?? MAIN_ID)
  }, [viewingAgentId])
  /**
   * 协作设置弹窗。
   *
   * 并行 / 深度 / 互问 / 交互记录这几样都是**低频**动作，全摆在工具栏上会把「添加 Agent」
   * 这个真正常用的按钮挤到边角，窄屏还要折行 —— 所以统一收进一个弹窗，工具栏只留添加。
   */
  const [settingsOpen, setSettingsOpen] = useState(false)
  /**
   * 被选中的**接线**（存 `settings.edges` 里的原始 id，不是画布上的 `topology:<id>`）。
   *
   * 接线边是派生的（`settings.edges` 算出来的），没走 `useEdgesState`，所以 React Flow
   * 自己的选中态存不住 —— 选中哪条、怎么高亮都由这个 state 说了算，键盘 Delete 也只认它。
   */
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null)
  /**
   * 画布是否真的**看得见**。
   *
   * `PanelView` 里非活动标签是 `hidden`（`display: none`）藏起来的、**不卸载**，
   * 所以窗口级 keydown 在后台标签里照样会响 —— 没有这道闸，在别的标签里按 Delete
   * 会删掉这个后台画布上选中的 Agent。`display: none` 的元素 IntersectionObserver
   * 直接报「不可见」，正好当判据。
   */
  const [visible, setVisible] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const { theme } = useTheme()

  const agents = settings.agents
  /**
   * 主智能体连得上的子 Agent。
   *
   * 接线是**唯一**的路由依据（服务端 `CollabRuntime` 也按它拦派活），所以画布上必须
   * 把「连不上」的那些标出来 —— 否则用户只会看到「派活失败：没有接线」而不知道
   * 该去哪里连。老配置在 `normalizeCollabSettings` 里已补成 main → 每个 Agent。
   */
  const mainReachable = useMemo(() => {
    const ids = new Set(settings.edges.filter((edge) => edge.source === MAIN_ID).map((edge) => edge.target))
    return ids
  }, [settings.edges])
  const statuses = state?.statuses ?? EMPTY_STATUSES
  const tasks = state?.tasks ?? EMPTY_TASKS
  const messages = state?.messages ?? EMPTY_MESSAGES
  const running = Object.values(statuses).filter((s) => s.status === 'running').length
  /** 主智能体连不上的子 Agent 数（工具栏角标 + 节点上的提示用） */
  const unreachable = agents.filter((agent) => !mainReachable.has(agent.id)).length

  const saveSettings = (next: CollabSettings): void => {
    void app.saveCollabSettings(next)
  }

  /**
   * 删 Agent（节点上的垃圾桶按钮、键盘 Delete 共用）。
   *
   * 收成「一批」是因为键盘可以一次选中多个节点：一条一条确认会把用户按 N 次，
   * 而且中途取消会留下「删了一半」的状态。单条时文案仍然带名字。
   */
  const removeAgents = async (list: CollabAgentConfig[]): Promise<void> => {
    if (list.length === 0) return
    const ok = await confirm({
      title: list.length === 1 ? `删除「${list[0]!.name}」？` : `删除这 ${list.length} 个 Agent？`,
      description: '这些 Agent 的配置会从画布移除；已产生的任务记录仍保留在消息流里。',
      confirmLabel: '删除',
      destructive: true
    })
    if (!ok) return
    const ids = new Set(list.map((agent) => agent.id))
    // 顺手把挂在它们身上的接线一起断掉：服务端归一化也会丢，但这里立刻生效，
    // 画布上不会留一条「指向已删除节点」的残线
    const nextEdges = settings.edges.filter(
      (edge) => !ids.has(edge.source) && !ids.has(edge.target)
    )
    saveSettings({
      ...settings,
      agents: settings.agents.filter((agent) => !ids.has(agent.id)),
      edges: nextEdges
    })
    if (ids.has(selected)) setSelected(MAIN_ID)
    if (selectedEdge && !nextEdges.some((edge) => edge.id === selectedEdge)) {
      setSelectedEdge(null)
    }
  }

  const removeAgent = (agent: CollabAgentConfig): Promise<void> => removeAgents([agent])

  /**
   * 拖一条线 = 加一条接线。
   *
   * 只做「加」：重连（拖已有线的端点改目标）在 React Flow 里默认也是走 `onConnect`，
   * 但会先触发 `onEdgesChange` 的 remove —— 我们没接那个回调，所以表现为「加了一条新的、
   * 旧的还在」，用户再点一次小叉即可。刻意不做得更聪明：接线是低频动作，删一条线一次点击。
   */
  const connectAgents = (connection: Connection): void => {
    const { source, target } = connection
    if (!source || !target || source === target) return
    // 主智能体只发不收：指向它的线没有语义（结果是走消息流回的，不是任务）
    if (target === MAIN_ID) return
    if (settings.edges.some((edge) => edge.source === source && edge.target === target)) return
    saveSettings({
      ...settings,
      edges: [...settings.edges, { id: `${source}->${target}`, source, target }]
    })
  }

  /** 断开一条接线（线上那颗小叉 / 键盘 Delete） */
  const removeEdge = (id: string): void => {
    saveSettings({ ...settings, edges: settings.edges.filter((edge) => edge.id !== id) })
    // 选中的那条被删掉了，选中态跟着清 —— 否则 Delete 第二次还会去找一条不存在的线
    if (selectedEdge === id) setSelectedEdge(null)
  }

  /**
   * 手机版没有画布，也就没法拖线 —— 用一颗按钮表达同一件事：接上 / 断开。
   *
   * 只动「主智能体 ↔ 这个 Agent」这一条线，子 Agent 之间的线仍然只能在画布上连
   * （手机上那是低频操作，塞进列表反而更乱）。
   */
  const toggleMainEdge = (agentId: string): void => {
    const existing = settings.edges.find(
      (edge) => edge.source === MAIN_ID && edge.target === agentId
    )
    if (existing) removeEdge(existing.id)
    else connectAgents({ source: MAIN_ID, target: agentId, sourceHandle: null, targetHandle: null })
  }

  const nameOf = (id: string): string =>
    id === MAIN_ID ? settings.mainName : agents.find((agent) => agent.id === id)?.name ?? id

  /**
   * 画布节点：所有子 Agent 都围绕主智能体摆放。
   *
   * 连线有两类（见下面 `flowEdges`）：**接线**（配置，常驻虚线）与**通信**
   * （这次跑出来的事实，按任务运行态现算）。
   */
  function buildFlowNodes(): CollabFlowNode[] {
    const mainStatus: CollabAgentRuntime = {
      status: app.streaming ? 'running' : 'idle',
      updatedAt: 0
    }
    return [
      {
        id: MAIN_ID,
        type: 'collab',
        position: MAIN_POSITION,
        draggable: false,
        data: {
          agent: mainSpec(settings),
          isMain: true,
          accent: MAIN_ACCENT,
          status: mainStatus,
          selected: selected === MAIN_ID,
          // 点主智能体 = 右侧对话区回到主会话（从任何子 Agent 的面板切回来都走这里）
          onSelect: () => {
            setSelected(MAIN_ID)
            setSelectedEdge(null)
            onViewAgent(null)
          }
        }
      },
      ...agents.map((agent, index) => {
        const runtime = statuses[agent.id] ?? { status: 'idle', updatedAt: 0 }
        return {
          id: agent.id,
          type: 'collab' as const,
          position: agent.position ?? defaultPosition(index),
          data: {
            agent,
            isMain: false,
            unreachable: !mainReachable.has(agent.id),
            accent: SUB_ACCENTS[index % SUB_ACCENTS.length]!,
            status: runtime,
            selected: selected === agent.id,
            // 点节点 = 右侧对话区换成这个 Agent（原地换内容，不弹窗、不新开标签）
            onSelect: () => {
              setSelected(agent.id)
              setSelectedEdge(null)
              onViewAgent(agent.id)
            },
            onEdit: () => setEditing({ agent, isNew: false }),
            onDelete: () => void removeAgent(agent),
            onCancel:
              runtime.taskId && runtime.status === 'running'
                ? () => void app.cancelCollabTask(runtime.taskId!)
                : undefined
          }
        }
      })
    ]
  }

  // 节点状态必须交给 useNodesState / onNodesChange 管：React Flow 会通过 dimensions
  // 变更写回 measured 宽高，丢掉它每次渲染都会重新测量节点 —— 拖拽时表现为画布闪烁。
  const [flowNodes, setFlowNodes, onFlowNodesChange] = useNodesState<CollabFlowNode>(
    buildFlowNodes()
  )

  useEffect(() => {
    const next = buildFlowNodes()
    setFlowNodes((prev) => {
      const previous = new Map(prev.map((node) => [node.id, node]))
      return next.map((node) => {
        const old = previous.get(node.id)
        if (!old) return node
        return {
          ...node,
          position: old.position,
          selected: old.selected,
          measured: old.measured,
          width: old.width,
          height: old.height
        }
      })
    })
    // buildFlowNodes 每帧都是新闭包，依赖只取会影响节点内容 / 选中的真值。
    // ⚠️ 刻意**不含** `tasks` / `liveText`：节点上不显示任务与流式正文（那两样一秒变十几次，
    // 每帧重建节点会让画布闪），它们只喂弹窗。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agents, statuses, selected, app.streaming, mainReachable])

  /**
   * 连线方向跟着数据流向走：
   * - 任务排队 / 执行中：`发起方 → 执行方`（派活）;
   * - 任务结束（完成 / 出错）：`执行方 → 发起方`（交结果），保留该 Agent 最近一次结果线。
   * 同一 Agent 有新任务在跑时不再显示旧结果线，避免方向互相打架。
   */
  const latestMessageFor = (task: CollabTask): CollabMessage | undefined =>
    [...messages].reverse().find((message) => message.taskId === task.id) ??
    [...messages]
      .reverse()
      .find(
        (message) =>
          (message.from === task.from && message.to === task.agentId) ||
          (message.from === task.agentId && message.to === task.from)
      )

  const runtimeEdges: CollabFlowEdge[] = []
  const seenEdges = new Set<string>()
  const pushEdge = (
    task: CollabTask,
    source: string,
    target: string,
    completed: boolean
  ): void => {
    const key = `${source}->${target}`
    if (seenEdges.has(key)) return
    seenEdges.add(key)
    const latest = latestMessageFor(task)
    const toolName = completed ? undefined : statuses[task.agentId]?.toolName
    runtimeEdges.push({
      id: key,
      source,
      target,
      sourceHandle: source === MAIN_ID ? 'main-out' : 'sub-out',
      targetHandle: target === MAIN_ID ? 'main-in' : 'sub-in',
      type: 'comm',
      animated: !completed,
      style: completed
        ? {
            stroke: 'var(--muted-foreground)',
            strokeWidth: 1.5,
            strokeDasharray: '5 4',
            opacity: 0.65
          }
        : { stroke: 'var(--primary)', strokeWidth: 2 },
      markerEnd: {
        type: MarkerType.ArrowClosed,
        color: completed ? 'var(--muted-foreground)' : 'var(--primary)',
        width: 18,
        height: 18
      },
      data: {
        fromLabel: nameOf(source),
        toLabel: nameOf(target),
        label: completed
          ? task.error ?? latest?.text ?? task.output ?? task.prompt
          : latest?.text ?? task.prompt,
        completed,
        ...(toolName ? { tool: toolLabel(toolName) } : {})
      }
    })
  }

  const activeTasks = tasks.filter(
    (task) => task.status === 'queued' || task.status === 'running'
  )
  const activeAgents = new Set(activeTasks.map((task) => task.agentId))
  for (const task of activeTasks) {
    if (task.from === task.agentId) continue
    const fromExists = task.from === MAIN_ID || agents.some((agent) => agent.id === task.from)
    const toExists = agents.some((agent) => agent.id === task.agentId)
    if (!fromExists || !toExists) continue
    pushEdge(task, task.from, task.agentId, false)
  }

  const completedByAgent = new Map<string, CollabTask>()
  for (const task of tasks) {
    if (task.status !== 'done' && task.status !== 'error') continue
    if (task.from === task.agentId || activeAgents.has(task.agentId)) continue
    if (task.from !== MAIN_ID && !agents.some((agent) => agent.id === task.from)) continue
    if (!agents.some((agent) => agent.id === task.agentId)) continue
    completedByAgent.set(task.agentId, task)
  }
  for (const task of completedByAgent.values()) {
    pushEdge(task, task.agentId, task.from, true)
  }

  /**
   * 接线边：常驻的虚线，带一颗「断开」小叉。
   *
   * 同一个方向上正有通信线在画时**让位**（不画接线）：两条边共用同一对 Handle，
   * 路径完全重合，叠在一起既看不清哪条是配置、哪条是运行态。通信线一走完就自动回来。
   *
   * `selectable: true` 只为「点得中」：点中之后由 `selectedEdge` 记下来自己高亮
   * （边是派生的，没走 `useEdgesState`，React Flow 的选中态存不住），键盘 Delete 认它。
   */
  const busyPairs = new Set(runtimeEdges.map((edge) => `${edge.source}->${edge.target}`))
  const topologyEdges: CollabTopologyFlowEdge[] = settings.edges
    .filter((edge) => !busyPairs.has(`${edge.source}->${edge.target}`))
    .map((edge) => ({
      id: `${TOPOLOGY_EDGE_PREFIX}${edge.id}`,
      source: edge.source,
      target: edge.target,
      sourceHandle: edge.source === MAIN_ID ? 'main-out' : 'sub-out',
      targetHandle: 'sub-in',
      type: 'topology',
      selectable: true,
      selected: selectedEdge === edge.id,
      style: {
        stroke: 'var(--border)',
        strokeWidth: 1.5,
        strokeDasharray: '4 4'
      },
      markerEnd: {
        type: MarkerType.ArrowClosed,
        color: 'var(--border)',
        width: 16,
        height: 16
      },
      data: { onRemove: () => removeEdge(edge.id) }
    }))

  const flowEdges: Edge[] = [...topologyEdges, ...runtimeEdges]

  const persistNodePosition = (id: string, position: Point): void => {
    if (id === MAIN_ID) return
    const agent = settings.agents.find((item) => item.id === id)
    if (!agent) return
    saveSettings({
      ...settings,
      agents: settings.agents.map((item) =>
        item.id === id
          ? { ...item, position: { x: Math.round(position.x), y: Math.round(position.y) } }
          : item
      )
    })
  }

  /**
   * 把节点摊回默认网格。
   *
   * 给**老会话**留的出路：默认布局的走线通道（见 `FIRST_ROW_Y`）只对新建的 Agent 生效，
   * 已经落盘的 `position` 不会自己挪 —— 用户把第三张卡拖到主节点底下之后，画布就一直是挤的。
   * 一键重排比让他逐张拖回去省事，也不会动模型 / 工具这些配置。
   */
  const tidyLayout = (): void => {
    saveSettings({
      ...settings,
      agents: settings.agents.map((agent, index) => ({
        ...agent,
        position: defaultPosition(index)
      }))
    })
  }

  /**
   * 键盘删除（Delete / Backspace）。
   *
   * 删的是**看得见的那个选中**：接线优先（点中它才会进选中态，而点节点会把接线选中清掉，
   * 见 `onNodeClick` / `onEdgeClick`，所以「最后点的那个」说了算），其次是被选中环圈住的
   * 子 Agent。主智能体不删。
   *
   * 处理函数放 ref 里每帧更新：直接进 effect 依赖会让这个 window 监听每次渲染都重挂一遍；
   * 而把 `settings` / `removeAgent` 留在旧闭包里，又会让「刚改过的接线」被旧快照写回去。
   */
  const deleteKeyRef = useRef<(event: KeyboardEvent) => void>(() => {})
  deleteKeyRef.current = (event) => {
    if (event.key !== 'Delete' && event.key !== 'Backspace') return
    if (event.isComposing || event.repeat) return
    // 弹窗开着时这一下属于弹窗：编辑框里的 Backspace 是删字，确认框里可能是「不要」
    if (editing || settingsOpen || logOpen) return
    const target = event.target as HTMLElement | null
    if (
      target &&
      (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
    ) {
      return
    }
    if (selectedEdge) {
      event.preventDefault()
      removeEdge(selectedEdge)
      return
    }
    if (selected === MAIN_ID) return
    const agent = agents.find((item) => item.id === selected)
    if (!agent) return
    event.preventDefault()
    void removeAgent(agent)
  }

  useEffect(() => {
    if (!visible) return
    const onKeyDown = (event: KeyboardEvent): void => deleteKeyRef.current(event)
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [visible])

  // 判据：`display: none` 的标签页里 IntersectionObserver 直接报不可见
  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    const observer = new IntersectionObserver(([entry]) =>
      setVisible(Boolean(entry?.isIntersecting))
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  return (
    <div ref={rootRef} className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {/*
        单行工具栏。之前是 `flex-col md:flex-row` + 5 个控件，手机上只能折成两行；
        现在控件只剩「设置齿轮 + 添加 Agent」，再折就是白占一行高度，所以**任何宽度都是一行**：
        名字 `min-w-0 truncate` 让位，右侧两块 `shrink-0` 钉住。
        两个角标在 <sm 隐藏 —— 一行放不下（360px 下名字会被压没），而手机版的列表卡片
        逐条显示了状态点和接线按钮（未接线的那个是琥珀色 + 提示「接到主智能体」），不丢信息。
      */}
      <div className="flex items-center gap-2 border-b px-3 pb-2">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {/* 与 sidebar 里多智能体会话的行首图标同一颗，方便把两边对上号 */}
          <Network className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate text-sm font-medium">{settings.mainName}</span>
          {unreachable > 0 && (
            <Badge
              variant="outline"
              className="hidden shrink-0 gap-1 border-amber-500/60 text-[0.65rem] text-amber-600 sm:inline-flex dark:text-amber-400"
              title={tr('这些子 Agent 没有从主智能体连过来的线，派不到它们')}
            >
              <Unlink className="size-3" />
              {tr('{count} 个未接线', { count: unreachable })}
            </Badge>
          )}
          {running > 0 && (
            <Badge
              className="hidden shrink-0 gap-1 text-[0.65rem] sm:inline-flex"
              variant="secondary"
            >
              <Loader2 className="size-3 animate-spin" />
              {tr('{count} 个在跑', { count: running })}
            </Badge>
          )}
        </div>
        {/*
          工具栏只留「设置 / 重排 / 添加 Agent」。并行 / 深度 / 互问 / 交互记录全部进了设置弹窗
          —— 状态角标留在左边当读数，不占操作位。
        */}
        <div className="flex shrink-0 items-center gap-1.5">
          <Button
            size="icon-sm"
            variant="ghost"
            className="size-7 text-muted-foreground"
            aria-label={tr('协作设置')}
            title={tr('协作设置：并行 / 深度 / 互问 / 交互记录')}
            onClick={() => setSettingsOpen(true)}
          >
            <Settings2 className="size-3.5" />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            className="size-7 text-muted-foreground"
            aria-label={tr('重新排列节点')}
            title={tr('重新排列节点：卡片挤在一起、主 Agent 底部没有走线空间时用')}
            disabled={agents.length === 0}
            onClick={tidyLayout}
          >
            <LayoutGrid className="size-3.5" />
          </Button>
          <Button
            size="sm"
            className="h-7 gap-1 text-xs"
            onClick={() =>
              setEditing({
                isNew: true,
                agent: createCollabAgent({
                  position: freePosition(settings.agents)
                })
              })
            }
          >
            <Plus className="size-3.5" />
            {tr('添加 Agent')}
          </Button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        {mobile ? (
          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto bg-muted/20 p-3">
            {[
              {
                id: MAIN_ID,
                agent: mainSpec(settings),
                status: (app.streaming ? 'running' : 'idle') as CollabAgentStatus,
                editable: false
              },
              ...agents.map((agent) => ({
                id: agent.id,
                agent,
                status: statuses[agent.id]?.status ?? 'idle',
                editable: true
              }))
            ].map(({ id, agent, status, editable }) => {
              const runtime = id === MAIN_ID ? undefined : statuses[id]
              const meta = STATUS_META[status]
              /** 手机上画布折成了列表，点一行同样把**下方**的对话区换成这个 Agent */
              const open = (): void => {
                setSelected(id)
                onViewAgent(id === MAIN_ID ? null : id)
              }
              return (
                <div
                  key={id}
                  role="button"
                  tabIndex={0}
                  onClick={open}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter' && event.key !== ' ') return
                    event.preventDefault()
                    open()
                  }}
                  className={cn(
                    'rounded-lg border bg-background p-3 transition-shadow',
                    selected === id
                      ? 'border-primary shadow-sm ring-1 ring-primary/20'
                      : 'border-border'
                  )}
                >
                  <div className="flex min-w-0 items-center gap-2">
                    {id === MAIN_ID ? (
                      <Sparkles className="size-4 shrink-0 text-primary" />
                    ) : (
                      <Bot className="size-4 shrink-0 text-muted-foreground" />
                    )}
                    <span className="truncate text-sm font-medium">{agent.name}</span>
                    <span className={cn('flex shrink-0 items-center gap-1 text-xs', meta.text)}>
                      <span className={cn('size-1.5 rounded-full', meta.dot)} />
                      {meta.label}
                    </span>
                    <div className="ml-auto flex shrink-0 items-center gap-0.5">
                      {runtime?.taskId && status === 'running' && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 w-7 p-0"
                          title="取消这个任务"
                          onClick={(event) => {
                            event.stopPropagation()
                            void app.cancelCollabTask(runtime.taskId!)
                          }}
                        >
                          <CircleStop className="size-3.5" />
                        </Button>
                      )}
                      {editable && (
                        <>
                          <Button
                            size="sm"
                            variant="ghost"
                            className={cn(
                              'h-7 w-7 p-0',
                              mainReachable.has(agent.id)
                                ? 'text-muted-foreground'
                                : 'text-amber-600 dark:text-amber-400'
                            )}
                            title={
                              mainReachable.has(agent.id)
                                ? '断开与主智能体的接线'
                                : '接到主智能体（否则派不到它）'
                            }
                            onClick={(event) => {
                              event.stopPropagation()
                              toggleMainEdge(agent.id)
                            }}
                          >
                            {mainReachable.has(agent.id) ? (
                              <Unlink className="size-3.5" />
                            ) : (
                              <Link2 className="size-3.5" />
                            )}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 w-7 p-0"
                            title="编辑"
                            onClick={(event) => {
                              event.stopPropagation()
                              setEditing({ agent, isNew: false })
                            }}
                          >
                            <Pencil className="size-3.5" />
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                            title="删除"
                            onClick={(event) => {
                              event.stopPropagation()
                              void removeAgent(agent)
                            }}
                          >
                            <Trash2 className="size-3.5" />
                          </Button>
                        </>
                      )}
                      <ChevronRight className="size-4 text-muted-foreground" />
                    </div>
                  </div>
                  <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                    {agent.role || '通用协作助手'}
                  </p>
                  {/* 任务与流式正文不进卡片：点一行把下方对话区换成它（与主会话同一套 UI） */}
                </div>
              )
            })}
            {agents.length === 0 && (
              <div className="flex flex-col items-center gap-2 py-10 text-center">
                <Bot className="size-8 text-muted-foreground/50" />
                <p className="text-sm text-muted-foreground">还没有子 Agent</p>
                <p className="max-w-xs text-xs text-muted-foreground">
                  点上方「添加 Agent」，然后在下方对话框把任务派给它们。
                </p>
              </div>
            )}
          </div>
        ) : (
          <div className="relative min-h-0 flex-1">
            <ReactFlow
            nodes={flowNodes}
            edges={flowEdges}
            nodeTypes={COLLAB_NODE_TYPES}
            edgeTypes={COLLAB_EDGE_TYPES}
            onNodesChange={onFlowNodesChange}
            onNodeClick={() => {
              // 选中 / 切换右侧对话区都在节点自己的 `onSelect` 里（那是卡片根节点的 onClick，
              // 卡片上的按钮 stopPropagation 之后不会误触发）；这里只负责「换目标」这一件事：
              // 接线不再算选中，否则 Delete 会删到上次点的那条线
              setSelectedEdge(null)
            }}
            onEdgeClick={(_, edge) => {
              if (!edge.id.startsWith(TOPOLOGY_EDGE_PREFIX)) return
              setSelectedEdge(edge.id.slice(TOPOLOGY_EDGE_PREFIX.length))
            }}
            onPaneClick={() => setSelectedEdge(null)}
            onNodeDragStop={(_, node) => persistNodePosition(node.id, node.position)}
            colorMode={theme}
            // 接线可编辑：从节点上的接线位拖到另一个节点 = 加一条派活路径。
            // 主智能体只发不收、也不允许自环（`isValidConnection` 先拦一道，
            // 服务端 `normalizeCollabSettings` 还会再拦一次）。
            nodesConnectable
            onConnect={connectAgents}
            isValidConnection={(connection) =>
              connection.source !== connection.target && connection.target !== MAIN_ID
            }
            edgesFocusable={false}
            selectionOnDrag
            selectionMode={SelectionMode.Partial}
            panOnDrag={[1, 2]}
            panOnScroll
            panOnScrollMode={PanOnScrollMode.Free}
            zoomOnScroll={false}
            // 键盘删除**不走** React Flow 的 `deleteKeyCode`：它删的是自己内部那份状态，
            // 而我们的删除要过确认框（用户点「取消」时节点就再也回不来了），也得区分
            // 「接线」与「运行态通信线」。所以整件事自己做，见上面的 `deleteKeyRef`。
            deleteKeyCode={null}
            fitView
            fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
            proOptions={{ hideAttribution: true }}
          >
            <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
            <Controls className="!rounded-lg !border-border !bg-card !shadow-md" />
            </ReactFlow>
          </div>
        )}
      </div>

      {settingsOpen && (
        <Dialog open onOpenChange={setSettingsOpen}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>协作设置</DialogTitle>
              <DialogDescription>
                「{settings.mainName}」调度子 Agent 的上限。改完立即生效，不用重开会话。
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="grid min-w-0 gap-1.5">
                  <Label>并行</Label>
                  <Select
                    value={String(settings.maxParallel)}
                    onValueChange={(value) =>
                      saveSettings({ ...settings, maxParallel: Number(value) })
                    }
                  >
                    <SelectTrigger size="sm" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {[1, 2, 3, 4, 5, 6].map((n) => (
                        <SelectItem key={n} value={String(n)}>
                          并行 {n}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-[0.7rem] leading-relaxed text-muted-foreground">
                    同一轮最多同时派几个 Agent
                  </p>
                </div>
                <div className="grid min-w-0 gap-1.5">
                  <Label>深度</Label>
                  <Select
                    value={String(settings.maxDepth)}
                    onValueChange={(value) =>
                      saveSettings({ ...settings, maxDepth: Number(value) })
                    }
                  >
                    <SelectTrigger size="sm" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {[1, 2, 3].map((n) => (
                        <SelectItem key={n} value={String(n)}>
                          深度 {n}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-[0.7rem] leading-relaxed text-muted-foreground">
                    往下派几层；1 表示只由主智能体派
                  </p>
                </div>
              </div>
              <div className="flex items-start justify-between gap-3 rounded-md border px-3 py-2.5">
                <div className="min-w-0">
                  <Label
                    htmlFor="collab-allow-messaging"
                    className="flex items-center gap-1.5 text-sm"
                  >
                    <Activity className="size-3.5 text-muted-foreground" />
                    子 Agent 互问
                  </Label>
                  <p className="mt-1 text-[0.7rem] leading-relaxed text-muted-foreground">
                    允许子 Agent 用 ask_agent 互相提问。只能问「有接线」的同伴，环路仍由编排器检测。
                  </p>
                </div>
                <Switch
                  id="collab-allow-messaging"
                  className="mt-0.5"
                  checked={settings.allowAgentMessaging}
                  onCheckedChange={(checked) =>
                    saveSettings({ ...settings, allowAgentMessaging: checked })
                  }
                />
              </div>
              <Button
                variant="outline"
                className="h-auto justify-start gap-2 py-2.5"
                onClick={() => {
                  // 两个弹窗同时开只会互相抢焦点，先关设置再开记录
                  setSettingsOpen(false)
                  setLogOpen(true)
                }}
              >
                <MessagesSquare className="size-4 text-muted-foreground" />
                <span className="text-sm">交互记录</span>
                <span className="ml-auto text-[0.7rem] text-muted-foreground">
                  {messages.length} 条消息 · {tasks.length} 个任务
                </span>
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}

      {logOpen && (
        <Dialog open onOpenChange={setLogOpen}>
          <DialogContent className="flex max-h-[82dvh] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
            <DialogHeader className="shrink-0 border-b px-4 py-3">
              <DialogTitle>交互记录</DialogTitle>
              <DialogDescription>所有 Agent 的任务与消息，按最新在前排列。</DialogDescription>
            </DialogHeader>
            <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4 text-xs">
              <section>
                <h3 className="mb-2 text-[0.7rem] font-medium uppercase tracking-wide text-muted-foreground">
                  消息
                </h3>
                {messages.length === 0 ? (
                  <p className="text-muted-foreground">还没有消息</p>
                ) : (
                  <div className="space-y-1.5">
                    {messages
                      .slice()
                      .reverse()
                      .map((message) => (
                        <div key={message.id} className="rounded-md border px-2.5 py-2">
                          <div className="mb-1 flex items-center gap-2 text-[0.65rem] text-muted-foreground">
                            <span className="font-medium text-foreground/80">
                              {nameOf(message.from)} → {nameOf(message.to)}
                            </span>
                            <Badge variant="outline" className="text-[0.6rem]">
                              {message.kind}
                            </Badge>
                          </div>
                          <p className="whitespace-pre-wrap break-words leading-relaxed text-foreground/85">
                            {message.text}
                          </p>
                        </div>
                      ))}
                  </div>
                )}
              </section>
              <section>
                <h3 className="mb-2 text-[0.7rem] font-medium uppercase tracking-wide text-muted-foreground">
                  任务
                </h3>
                {tasks.length === 0 ? (
                  <p className="text-muted-foreground">还没有任务</p>
                ) : (
                  <div className="space-y-1.5">
                    {tasks
                      .slice()
                      .reverse()
                      .map((task) => (
                        <div key={task.id} className="rounded-md border px-2.5 py-2">
                          <div className="mb-1 flex items-center gap-2 text-[0.65rem] text-muted-foreground">
                            <span className="font-medium text-foreground/80">
                              {nameOf(task.from)} → {nameOf(task.agentId)}
                            </span>
                            <Badge variant="outline" className="text-[0.6rem]">
                              {task.status}
                            </Badge>
                          </div>
                          <p className="whitespace-pre-wrap break-words leading-relaxed text-foreground/85">
                            {task.prompt}
                          </p>
                          {(task.output || task.error) && (
                            <p className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded bg-muted/50 p-2 leading-relaxed text-muted-foreground">
                              {task.error ?? task.output}
                            </p>
                          )}
                        </div>
                      ))}
                  </div>
                )}
              </section>
            </div>
          </DialogContent>
        </Dialog>
      )}

      {editing && (
        <AgentConfigDialog
          app={app}
          agent={editing.agent}
          isNew={editing.isNew}
          onOpenChange={(open) => {
            if (!open) setEditing(null)
          }}
          onSave={(next) => {
            const exists = settings.agents.some((a) => a.id === next.id)
            /*
             * 新建的 Agent 默认带一条「主智能体 → 它」的接线（与 `normalizeCollabSettings`
             * 给老配置补的默认接线同一个口径）：主节点底部只有**一个**接线位，卡片一多
             * 就没有地方下拖，「加了 Agent 却派不到它」不该靠一次精确拖拽去解决。
             * 不想要这条线，点线上那颗小叉即可。
             */
            const wired = settings.edges.some(
              (edge) => edge.source === MAIN_ID && edge.target === next.id
            )
            saveSettings({
              ...settings,
              agents: exists
                ? settings.agents.map((a) => (a.id === next.id ? next : a))
                : [...settings.agents, next],
              edges:
                exists || wired
                  ? settings.edges
                  : [
                      ...settings.edges,
                      { id: `${MAIN_ID}->${next.id}`, source: MAIN_ID, target: next.id }
                    ]
            })
            setSelected(next.id)
            setEditing(null)
          }}
        />
      )}
    </div>
  )
}

