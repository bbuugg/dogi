import {
  Fragment,
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent
} from 'react'
import {
  ArrowDown,
  ArrowLeft,
  ArrowLeftToLine,
  ArrowRight,
  ArrowRightToLine,
  ArrowUp,
  Bot,
  Boxes,
  Cable,
  FileCode2,
  FileText,
  FolderOpen,
  Globe,
  Monitor,
  Network,
  Pencil,
  Plus,
  Puzzle,
  ScrollText,
  Split,
  TerminalSquare,
  X
} from 'lucide-react'
import { cn } from 'cn'
import type { SessionInfo } from '@shared/types'
import { groupTerminalSessionId, useAppStore, type PanelTab, type PanelTabType } from '@/stores/app-store'
import { TerminalView } from '@/features/terminal/TerminalView'
import { AiPanel } from '@/features/agent/AiPanel'
import { AgentPage } from '@/features/agent/AgentPage'
import { ApiPage } from '@/features/api/ApiPage'
import { WsPage } from '@/features/api/WsPage'
import { ScriptsPage } from '@/features/scripts/ScriptsPage'
import { NotesPage } from '@/features/notes/NotesPage'
import { PluginsPage } from '@/features/plugins/PluginsPage'
import { SftpPage } from '@/features/sftp/SftpPage'
import { RdpPage } from '@/features/rdp/RdpPage'
import { TunnelsPanel } from '@/features/tunnels/TunnelsPanel'
import { HostLogsPanel } from '@/features/logs/HostLogsPanel'
import { Dropdown, Input, Modal } from 'antd'
import { useDrag, useDrop } from 'react-dnd'
import type { PaneNode, SplitDirection, SplitDirectionInput } from '@/app/layout/pane-layout'
import { resolveSshColor } from '@/features/hosts/ssh-color'
import { getTabBus, releaseTabBus } from '@/shared/lib/tab-event-bus'
import { useInlineConfirm } from '@/shared/components/InlineConfirm'
import { tintText } from '@/shared/lib/color'

/** react-dnd 拖拽标签的 item 类型与载荷（带来源组，drop 端据此判断跨组移动） */
const TAB_DND_TYPE = 'panel-tab'
interface TabDragItem {
  tabId: string
  groupId: string
}
/** 拖拽落点分区：四边 = 分屏方向，center = 并入该组 */
type DropZone = SplitDirectionInput | 'center'
/** 判定边缘落区的比例（各边内侧 1/4 视为分屏区） */
const EDGE_RATIO = 0.25
/** 标签条高度（px）：落在这一带内不做分屏判定，交给标签自己的排序逻辑 */
const STRIP_HEIGHT = 32
/** 把激活标签滚进可视区时两侧留的余量（px），贴着边缘不好点 */
const TAB_SCROLL_CLEAR = 8
/** 标签条右缘 sticky「新建」按钮的宽度（w-8）：它会盖住滚到最右侧的标签，得避开 */
const NEW_TAB_BUTTON_WIDTH = 32
/** 左右分屏时每个面板的最小宽度（px）：再窄终端/文件树就没法用了 */
const MIN_PANE_WIDTH = 340
/** 上下分屏时每个面板的最小高度占比（容器高度不足时按此兜底） */
const MIN_PANE_RATIO = 0.05

/** 根据指针位置判断落在组内的哪个分区 */
function zoneOf(rect: DOMRect, x: number, y: number): DropZone {
  const px = (x - rect.left) / (rect.width || 1)
  const py = (y - rect.top) / (rect.height || 1)
  const d = [px, 1 - px, py, 1 - py]
  const min = Math.min(...d)
  if (min > EDGE_RATIO) return 'center'
  if (min === d[0]) return 'left'
  if (min === d[1]) return 'right'
  if (min === d[2]) return 'up'
  return 'down'
}

/**
 * 各标签类型的图标。
 *
 * 收整个 `tab` 而不是 `type`：`api` 标签同时承载 HTTP 请求与 WebSocket 调试，
 * 两者用不同的图标（Globe / Cable），只看 type 区分不出来。
 */
function TabIcon({ tab }: { tab: PanelTab }) {
  switch (tab.type) {
    case 'terminal':
      return <TerminalSquare className="size-3.5 shrink-0" />
    case 'script':
      return <FileCode2 className="size-3.5 shrink-0" />
    case 'note':
      return <FileText className="size-3.5 shrink-0" />
    case 'api':
      return tab.apiProtocol === 'ws' ? (
        <Cable className="size-3.5 shrink-0" />
      ) : (
        <Globe className="size-3.5 shrink-0" />
      )
    case 'plugins':
      return <Boxes className="size-3.5 shrink-0" />
    case 'plugin':
      return <Puzzle className="size-3.5 shrink-0" />
    case 'sftp':
      return <FolderOpen className="size-3.5 shrink-0" />
    case 'rdp':
      return <Monitor className="size-3.5 shrink-0" />
    case 'tunnels':
      return <Network className="size-3.5 shrink-0" />
    case 'logs':
      return <ScrollText className="size-3.5 shrink-0" />
    case 'agent':
      return <Bot className="size-3.5 shrink-0" />
  }
}

/** 空状态：还没有打开任何标签页 —— 简单欢迎页 */
function EmptyState() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
      <TerminalSquare className="size-14 opacity-20" />
      <div className="text-base font-medium text-foreground/80">欢迎使用</div>
      <div className="text-xs text-muted-foreground/70">
        双击左侧主机即可连接，或新建一个本地终端开始
      </div>
    </div>
  )
}

/**
 * PanelView：主区域的面板视图。
 *
 * 模型与 VS Code 的编辑器区一致：分屏树（PaneNode）的每个叶子是一个「面板组」，
 * 组内是一排平级标签页（终端会话 / 脚本 / 笔记 / 插件管理 / 插件视图）。
 * 标签支持拖拽排序、跨组移动，拖到组的四边则分屏（上下左右）。
 */
export function PanelView() {
  const layout = useAppStore((s) => s.layout)
  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-background rounded-lg overflow-hidden">
      {layout ? <PaneTree layout={layout} /> : <EmptyState />}
    </div>
  )
}

/** 递归渲染分屏布局树 */
function PaneTree({ layout }: { layout: PaneNode }) {
  // 叶子与分隔节点渲染同构结构（同类型根 div + 按 pane id 的 Fragment key）：
  // leaf -> split 结构切换时 React 按 key 命中原有子树，既有组/终端不会卸载，
  // 组件内状态（xterm 滚动缓冲、ZMODEM 传输会话等）得以保留
  const split = layout.type === 'split' ? layout : null
  const children: PaneNode[] = layout.type === 'split' ? layout.children : [layout]
  return (
    <div
      className={cn(
        'flex h-full w-full min-h-0',
        split ? (split.direction === 'row' ? 'flex-row' : 'flex-col') : 'flex-col'
      )}
    >
      {children.map((child, i) => (
        <Fragment key={child.id}>
          <div
            className="min-h-0 min-w-0"
            style={{ flexGrow: split ? split.sizes[i] ?? 1 : 1, flexBasis: 0 }}
          >
            {child.type === 'leaf' ? (
              <PanelGroupView groupId={child.groupId} />
            ) : (
              <PaneTree layout={child} />
            )}
          </div>
          {split && i < children.length - 1 && (
            <Splitter
              splitId={split.id}
              index={i}
              direction={split.direction}
              sizes={split.sizes}
            />
          )}
        </Fragment>
      ))}
    </div>
  )
}

/** 可拖拽的分隔条：调整相邻两个子面板的弹性权重 */
function Splitter({
  splitId,
  index,
  direction,
  sizes
}: {
  splitId: string
  index: number
  direction: SplitDirection
  sizes: number[]
}) {
  const resizeSplit = useAppStore((s) => s.resizeSplit)
  const ref = useRef<HTMLDivElement>(null)

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    const parent = ref.current?.parentElement
    if (!parent) return
    const rect = parent.getBoundingClientRect()
    const axisSize = direction === 'row' ? rect.width : rect.height
    const start = direction === 'row' ? e.clientX : e.clientY
    const a0 = sizes[index] ?? 1
    const b0 = sizes[index + 1] ?? 1
    const total = a0 + b0
    /**
     * 相邻两侧的最小权重。sizes 是**相对比例**（实际像素 = axisSize × 权重 ÷ 权重总和），
     * 所以最小像素要先折算成权重：
     * - 左右分屏：每个面板至少 MIN_PANE_WIDTH（px）；
     * - 上下分屏：宽度不受分隔条影响，维持按比例的最小高度；
     * 再统一封顶到「两侧各一半」—— 容器本身就塞不下两个最小面板时（窗口很窄 / 嵌套很深），
     * 不封顶会让两侧互相顶死、分隔条完全拖不动。
     */
    const sumWeight = sizes.reduce((a, b) => a + b, 0) || total || 1
    const minWeight =
      direction === 'row'
        ? (MIN_PANE_WIDTH / (axisSize || 1)) * sumWeight
        : MIN_PANE_RATIO * total
    const MIN = Math.min(minWeight, total / 2)

    const move = (ev: PointerEvent) => {
      const cur = direction === 'row' ? ev.clientX : ev.clientY
      const delta = ((cur - start) / (axisSize || 1)) * total
      const a = Math.max(MIN, Math.min(total - MIN, a0 + delta))
      const next = sizes.slice()
      next[index] = a
      next[index + 1] = total - a
      resizeSplit(splitId, next)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    document.body.style.cursor = direction === 'row' ? 'col-resize' : 'row-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }

  return (
    <div
      ref={ref}
      onPointerDown={onPointerDown}
      title="拖动调整大小"
      className={cn(
        // 视觉上仍是 1px 细线，但用负 margin 扩出 8px 的抓取热区，且不占布局空间。
        // 原来是个裸的 1px 元素，指针几乎落不上去（与侧边栏的 ResizeHandle 同一套做法）。
        // relative + z-10：相邻面板的内容可能溢出盖住这条线，抬一层才抓得到。
        'group/split relative z-10 shrink-0',
        direction === 'row' ? '-mx-1 w-2 cursor-col-resize' : '-my-1 h-2 cursor-row-resize'
      )}
    >
      <div
        className={cn(
          'absolute bg-border transition-colors group-hover/split:bg-primary',
          direction === 'row'
            ? 'inset-y-0 left-1/2 w-px -translate-x-1/2'
            : 'inset-x-0 top-1/2 h-px -translate-y-1/2'
        )}
      />
    </div>
  )
}

/** 单个面板组：标签条 + 内容区（+ 激活标签是终端时可能出现的 AI 助手） */
function PanelGroupView({ groupId }: { groupId: string }) {
  const group = useAppStore((s) => s.groups[groupId])
  const tabs = useAppStore((s) => s.ui.panelTabs)
  const active = useAppStore((s) => s.activeGroupId === groupId)
  const groupCount = useAppStore((s) => Object.keys(s.groups).length)
  const setActiveGroup = useAppStore((s) => s.setActiveGroup)
  const moveTabToGroup = useAppStore((s) => s.moveTabToGroup)
  const splitTabToGroup = useAppStore((s) => s.splitTabToGroup)
  const reorderTabs = useAppStore((s) => s.reorderTabs)
  const requestCloseGroup = useAppStore((s) => s.requestCloseGroup)
  // AI 助手属于终端页面：以本组「激活标签对应的会话」为 key。
  // 同组内切标签即换实例 —— 切到脚本/笔记时没有终端会话，面板自动收起，
  // 切回原来的终端标签时它自己那份开关状态还在。
  const aiSessionId = useAppStore((s) => groupTerminalSessionId(s, groupId))
  const aiOpen = useAppStore((s) => {
    const sid = groupTerminalSessionId(s, groupId)
    return sid ? !!s.ui.aiOpenSessions[sid] : false
  })

  /** 当前悬停的分屏落区（null = 没有拖拽悬停） */
  const [zone, setZone] = useState<DropZone | null>(null)
  const bodyRef = useRef<HTMLDivElement | null>(null)
  /**
   * 标签条 DOM：dnd 连接器也要挂它，所以用一个 ref 回调把两者合起来（见下面的 JSX）。
   * 拿它是为了量滚动位置 —— 激活标签要能自动滚进可视区。
   */
  const stripElRef = useRef<HTMLDivElement | null>(null)

  const [{ isOver }, dropRef] = useDrop<TabDragItem, unknown, { isOver: boolean }>(
    () => ({
      accept: TAB_DND_TYPE,
      hover: (_item, monitor) => {
        const offset = monitor.getClientOffset()
        const rect = bodyRef.current?.getBoundingClientRect()
        if (!offset || !rect) return
        // 标签条那一带不做分屏判定（由标签自己处理排序/并入）
        if (offset.y < rect.top + STRIP_HEIGHT) {
          setZone(null)
          return
        }
        setZone(zoneOf(rect, offset.x, offset.y))
      },
      drop: (item, monitor) => {
        // 落在标签/标签条上时已由内层目标处理，避免重复
        if (monitor.didDrop()) return { handled: true }
        const offset = monitor.getClientOffset()
        const rect = bodyRef.current?.getBoundingClientRect()
        const z = offset && rect ? zoneOf(rect, offset.x, offset.y) : 'center'
        setZone(null)
        if (z === 'center') {
          if (item.groupId !== groupId) moveTabToGroup(item.tabId, groupId)
        } else {
          splitTabToGroup(item.tabId, groupId, z)
        }
        return { handled: true }
      },
      collect: (m) => ({ isOver: m.isOver() })
    }),
    [groupId, moveTabToGroup, splitTabToGroup]
  )

  /** 标签条本身也是放置目标：拖到标签条空白处 = 追加到本组末尾 */
  const [{ isOverStrip }, stripRef] = useDrop<TabDragItem, unknown, { isOverStrip: boolean }>(
    () => ({
      accept: TAB_DND_TYPE,
      drop: (item, monitor) => {
        // 落在具体标签上时由标签处理（插入到该位置），这里只兜底「拖到空白处」
        if (monitor.didDrop()) return { handled: true }
        if (item.groupId === groupId) reorderTabs(groupId, item.tabId, group?.tabIds.length ?? 0)
        else moveTabToGroup(item.tabId, groupId)
        return { handled: true }
      },
      collect: (m) => ({ isOverStrip: m.isOver() })
    }),
    [groupId, reorderTabs, moveTabToGroup, group?.tabIds.length]
  )

  /**
   * 激活标签变化时把它横向滚进可视区。
   *
   * 标签多到溢出时，新建标签 / 从别处（命令面板、侧边栏、AI 助手）切换视图都可能把
   * 激活的那一个留在视口外 —— 用户看到的却是「内容变了但标签条没跟上」。
   * 只在本组**自己**的激活标签变化（或标签增删）时才滚，不干扰用户手动横向滚动。
   */
  const activeTabId = group?.activeTabId
  useEffect(() => {
    const strip = stripElRef.current
    if (!strip || !activeTabId) return
    const el = strip.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(activeTabId)}"]`)
    if (!el) return
    const tabRect = el.getBoundingClientRect()
    const stripRect = strip.getBoundingClientRect()
    // 右缘要避开 sticky 的「新建」按钮：滚到它底下等于没露出来
    const visibleRight = stripRect.right - NEW_TAB_BUTTON_WIDTH
    let delta = 0
    if (tabRect.left < stripRect.left + TAB_SCROLL_CLEAR) {
      delta = tabRect.left - stripRect.left - TAB_SCROLL_CLEAR
    } else if (tabRect.right > visibleRight - TAB_SCROLL_CLEAR) {
      delta = tabRect.right - visibleRight + TAB_SCROLL_CLEAR
    }
    if (Math.abs(delta) < 1) return
    strip.scrollBy({ left: delta, behavior: 'smooth' })
  }, [activeTabId, group?.tabIds.length])

  if (!group) return null

  return (
    <div
      ref={dropRef as (node: HTMLDivElement | null) => void}
      className={cn(
        'flex h-full w-full min-h-0 flex-col',
        active ? 'bg-background' : 'bg-background/60'
      )}
      onMouseDown={() => setActiveGroup(groupId)}
    >
      {/* 标签条：整条铺一层淡底色，激活标签再用「纯底色 + 顶部主色条」浮起来 */}
      <div className={cn('flex h-8 shrink-0 items-stretch')}>
        <div
          ref={(node) => {
            stripElRef.current = node
            ;(stripRef as (el: HTMLDivElement | null) => void)(node)
          }}
          className={cn(
            'no-scrollbar flex flex-1 items-stretch overflow-x-auto',
            isOverStrip && 'bg-primary/5'
          )}
        >
          {group.tabIds.map((tid, i) => {
            const tab = tabs.find((t) => t.id === tid)
            if (!tab) return null
            return (
              <PanelTabItem
                key={tid}
                tab={tab}
                groupId={groupId}
                index={i}
                tabCount={group.tabIds.length}
              />
            )
          })}
          {/*
            「新建」入口用 sticky 钉在标签条的右缘：
            - 标签没排满时，它就跟在最后一个标签后面（与普通流式布局一致）；
            - 标签多到横向溢出时，最多停在右缘，不会再被推到滚动区外面（即「不随滚动跑掉」）。
            底色必须实心 —— 横向滚动时标签会从它下面经过，半透明底会露出穿帮。
          */}
          <div
            className={cn(
              'sticky right-0 z-10 flex shrink-0 items-stretch',
              active ? 'bg-background' : 'bg-background/60'
            )}
          >
            <NewTabButton groupId={groupId} />
          </div>
        </div>
        {/* 组操作：关闭整个组（AI 助手开关在状态栏，见 AiStatusButton） */}
        {groupCount > 1 && (
          <button
            type="button"
            title="关闭整个组"
            onClick={() => requestCloseGroup(groupId)}
            className="flex w-8 shrink-0 items-center justify-center text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
          >
            <X className="size-3.5" />
          </button>
        )}
      </div>

      {/* 内容区：组内所有标签都保持挂载（切走用 hidden），终端输出与编辑器状态不丢 */}
      <div ref={bodyRef} className="relative flex min-h-0 flex-1">
        <div className="min-h-0 min-w-0 flex-1">
          {group.tabIds.map((tid) => {
            const tab = tabs.find((t) => t.id === tid)
            if (!tab) return null
            const isActive = group.activeTabId === tid
            return (
              // 内容宿主必须是 flex 列：面板根的 flex-1 才有定义高度可言 ——
              // 否则列表页（日志 / 隧道 / 插件）会长到内容高度，内部 overflow-auto 永远不触发滚动。
              // relative：标签内确认框（InlineConfirm）的遮罩以它定位，只盖住本标签
              <div key={tid} className={isActive ? 'relative flex h-full flex-col' : 'hidden'}>
                <TabContentGuard tab={tab} active={active && isActive} />
              </div>
            )
          })}
        </div>
        {/* AI 助手浮窗叠在终端之上（absolute 定位，不占布局）：只在「激活标签是终端且该页面开了 AI」时出现 */}
        {aiOpen && aiSessionId && <AiPanel sessionId={aiSessionId} />}

        {/* 分屏落区高亮 */}
        {isOver && zone && zone !== 'center' && <DropZoneOverlay zone={zone} />}
        {isOver && zone === 'center' && (
          <div className="pointer-events-none absolute inset-0 bg-primary/10" />
        )}
      </div>
    </div>
  )
}

/** 分屏落区高亮：按方向覆盖半区 */
function DropZoneOverlay({ zone }: { zone: SplitDirectionInput }) {
  const pos: Record<SplitDirectionInput, string> = {
    left: 'inset-y-0 left-0 w-1/2',
    right: 'inset-y-0 right-0 w-1/2',
    up: 'inset-x-0 top-0 h-1/2',
    down: 'inset-x-0 bottom-0 h-1/2'
  }
  return (
    <div
      className={cn(
        'pointer-events-none absolute rounded-sm bg-primary/15 ring-1 ring-primary/50 ring-inset',
        pos[zone]
      )}
    />
  )
}

/** 标签条末尾的「新建」入口（替代过去常驻的「终端」标签） */
function NewTabButton({ groupId }: { groupId: string }) {
  const createLocalSession = useAppStore((s) => s.createLocalSession)
  const openNewApiDraft = useAppStore((s) => s.openNewApiDraft)
  const setSshDialog = useAppStore((s) => s.setSshDialog)
  const setActiveGroup = useAppStore((s) => s.setActiveGroup)
  return (
    <Dropdown
      trigger={['click']}
      onOpenChange={(o) => {
        if (o) setActiveGroup(groupId)
      }}
      menu={{
        items: [
          { key: 'local', icon: <TerminalSquare className="size-3.5" />, label: '新建本地终端' },
          { key: 'api', icon: <Globe className="size-3.5" />, label: '新建接口请求' },
          { key: 'ws', icon: <Cable className="size-3.5" />, label: '新建 WebSocket' },
          { key: 'host', icon: <Plus className="size-3.5" />, label: '添加主机…' }
        ],
        onClick: ({ key }) => {
          if (key === 'local') void createLocalSession()
          // 与侧边栏「新建」一致：只开一个未保存草稿标签，Ctrl/Cmd+S 输名称后才落盘。
          // （以前这里直接 createApiRequest 落盘，会在列表里留一条空请求，与侧边栏行为不一致）
          else if (key === 'api') openNewApiDraft(groupId)
          else if (key === 'ws') openNewApiDraft(groupId, 'ws')
          else setSshDialog(true, null)
        }
      }}
    >
      <button
        type="button"
        title="新建终端 / 接口请求 / WebSocket / 添加主机"
        className="flex w-8 shrink-0 items-center justify-center text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
      >
        <Plus className="size-3.5" />
      </button>
    </Dropdown>
  )
}

/** 组内单个标签：可拖拽（组内排序 / 跨组移动 / 拖到组边缘分屏） */
function PanelTabItem({
  tab,
  groupId,
  index,
  tabCount
}: {
  tab: PanelTab
  groupId: string
  index: number
  tabCount: number
}) {
  const session = useAppStore((s) =>
    tab.sessionId ? s.sessions.find((x: SessionInfo) => x.id === tab.sessionId) : undefined
  )
  const profiles = useAppStore((s) => s.profiles)
  const sshGroups = useAppStore((s) => s.sshGroups)
  const exited = useAppStore((s) => !!tab.sessionId && s.exitedSessions.has(tab.sessionId))
  const isActive = useAppStore((s) => s.groups[groupId]?.activeTabId === tab.id)
  const setActiveGroup = useAppStore((s) => s.setActiveGroup)
  const setActiveSession = useAppStore((s) => s.setActiveSession)
  const activatePanelTab = useAppStore((s) => s.activatePanelTab)
  const splitTabToGroup = useAppStore((s) => s.splitTabToGroup)
  const requestClosePanelTab = useAppStore((s) => s.requestClosePanelTab)
  const requestCloseGroup = useAppStore((s) => s.requestCloseGroup)
  const requestCloseSiblingTabs = useAppStore((s) => s.requestCloseSiblingTabs)
  const renamePanelTab = useAppStore((s) => s.renamePanelTab)
  const reorderTabs = useAppStore((s) => s.reorderTabs)
  const moveTabToGroup = useAppStore((s) => s.moveTabToGroup)
  /** 重命名弹窗：草稿值跟着当前标题走，save 时trim 后交给 store（空 = 恢复自动标题） */
  const [renaming, setRenaming] = useState(false)
  const [renameDraft, setRenameDraft] = useState('')
  const innerRef = useRef<HTMLDivElement | null>(null)

  const submitRename = useCallback(() => {
    setRenaming(false)
    renamePanelTab(tab.id, renameDraft)
  }, [renameDraft, renamePanelTab, tab.id])

  /** 标签自身是放置目标：组内重排 / 跨组插入到本标签位置 */
  const [{ isOverTab }, dropRef] = useDrop<TabDragItem, unknown, { isOverTab: boolean }>(
    () => ({
      accept: TAB_DND_TYPE,
      drop: (item, monitor) => {
        if (monitor.didDrop()) return { handled: true }
        const rect = innerRef.current?.getBoundingClientRect()
        const offset = monitor.getClientOffset()
        let before = true
        if (rect && offset) before = offset.x < rect.left + rect.width / 2
        const at = index + (before ? 0 : 1)
        if (item.groupId === groupId) reorderTabs(groupId, item.tabId, at)
        else moveTabToGroup(item.tabId, groupId, at)
        return { handled: true }
      },
      collect: (m) => ({ isOverTab: m.isOver() })
    }),
    [groupId, index, reorderTabs, moveTabToGroup]
  )

  const [{ isDragging }, dragRef] = useDrag(
    () => ({
      type: TAB_DND_TYPE,
      item: { tabId: tab.id, groupId } satisfies TabDragItem,
      collect: (m) => ({ isDragging: m.isDragging() })
    }),
    [tab.id, groupId]
  )

  // SSH 会话沿用其主机（或所属分组）的颜色，本地终端/其它标签无颜色
  const profile = session?.profileId
    ? profiles.find((p) => p.id === session.profileId)
    : undefined
  const tabColor = profile ? resolveSshColor(profile, sshGroups) : undefined
  // Agent 标签的标题实时取会话自己的 title：会话重命名 / 首条消息自动定标题都会跟着走，
  // 不用再维护「标签标题 ↔ 会话标题」的同步（与终端标签取 session.title 同一套路）
  const agentConversation = useAppStore((s) =>
    tab.agentConversationId
      ? s.agentConversations.find((c) => c.id === tab.agentConversationId)
      : undefined
  )
  // 用户重命名过的标签优先显示自定义标题：自动标题那条链（主机名 / 会话标题 / 请求名 / 文件名）
  // 照旧实时推导，只在没有 customTitle 时生效
  const autoLabel = profile?.name ?? session?.title ?? agentConversation?.title ?? tab.title
  const label = tab.customTitle?.trim() ? tab.customTitle.trim() : autoLabel

  // ⚠️ useCallback 的依赖数组在渲染期就求值，所以 startRename 必须写在 label 声明之后
  // （提前写会抛 "Cannot access 'label' before initialization"）
  const startRename = useCallback(() => {
    setRenameDraft(label)
    setRenaming(true)
  }, [label])

  const focus = useCallback(() => {
    setActiveGroup(groupId)
    if (tab.sessionId) setActiveSession(tab.sessionId)
    else activatePanelTab(tab.id)
  }, [groupId, tab.id, tab.sessionId, setActiveGroup, setActiveSession, activatePanelTab])

  return (
    <>
      <Dropdown
        trigger={['contextMenu']}
        onOpenChange={(o) => {
          // 右键菜单打开时先聚焦，拆分/关闭才作用在正确的组与标签上
          if (o) focus()
        }}
        menu={{
          items: [
            // 拆分只搬动标签本身（把它拎到该方向的新组）。组内只有这一个标签时没有可拆的
            // 东西，置灰 —— 不再「顺手新建一个终端」来凑分屏，标签功能不牵连其它功能。
            // 四个方向收进二级菜单，一级只留一项：菜单不被四行同质的方向项撑长。
            {
              key: 'split',
              icon: <Split className="size-3.5" />,
              label: '拆分',
              disabled: tabCount === 1,
              children: [
                { key: 'split-up', icon: <ArrowUp className="size-3.5" />, label: '向上拆分' },
                { key: 'split-down', icon: <ArrowDown className="size-3.5" />, label: '向下拆分' },
                { key: 'split-left', icon: <ArrowLeft className="size-3.5" />, label: '向左拆分' },
                { key: 'split-right', icon: <ArrowRight className="size-3.5" />, label: '向右拆分' }
              ]
            },
            { type: 'divider' },
            {
              key: 'rename',
              icon: <Pencil className="size-3.5" />,
              label: '重命名标签'
            },
            {
              key: 'close-tab',
              icon: <X className="size-3.5" />,
              label: '关闭标签',
              danger: true
            },
            // 其余关闭方式收进「关闭」二级菜单（与「拆分」同款收法），一级只留最常用的关闭标签。
            // 组内批量关闭：都只作用于本组（跨组的标签不碰），且都保留当前这个标签，
            // 所以各范围「无可关项」时置灰 —— 组内只剩自己 / 自己是首（末）个标签。
            {
              key: 'close-more',
              icon: <X className="size-3.5" />,
              label: '关闭',
              children: [
                {
                  key: 'close-others',
                  label: '关闭其他标签',
                  danger: true,
                  disabled: tabCount === 1
                },
                {
                  key: 'close-left',
                  icon: <ArrowLeftToLine className="size-3.5" />,
                  label: '关闭左侧标签',
                  danger: true,
                  disabled: index === 0
                },
                {
                  key: 'close-right',
                  icon: <ArrowRightToLine className="size-3.5" />,
                  label: '关闭右侧标签',
                  danger: true,
                  disabled: index === tabCount - 1
                },
                { type: 'divider' },
                {
                  key: 'close-group',
                  label: '关闭整个组',
                  danger: true
                }
              ]
            }
          ],
          onClick: ({ key }) => {
            if (key.startsWith('split-')) {
              if (tabCount === 1) return
              splitTabToGroup(tab.id, groupId, key.slice('split-'.length) as SplitDirectionInput)
            } else if (key === 'rename') {
              startRename()
            } else if (key === 'close-tab') {
              requestClosePanelTab(tab.id)
            } else if (key === 'close-others') {
              requestCloseSiblingTabs(tab.id, 'others')
            } else if (key === 'close-left') {
              requestCloseSiblingTabs(tab.id, 'left')
            } else if (key === 'close-right') {
              requestCloseSiblingTabs(tab.id, 'right')
            } else if (key === 'close-group') {
              requestCloseGroup(groupId)
            }
          }
        }}
      >
        <div
          ref={dragRef as (node: HTMLDivElement | null) => void}
          // 标签条按这个属性定位激活项，好把它滚进可视区
          data-tab-id={tab.id}
          onClick={focus}
          title="拖拽标签可排序、跨组移动，拖到面板边缘可分屏"
          className={cn(
            // 顶部 2px 主色条：激活时着色、未激活透明 —— 两者都占位，切换时不跳行高
            'group/tab flex max-w-52 shrink-0 cursor-pointer items-center border-r border-border/60 border-t-2 transition-colors select-none',
            isActive
              ? 'border-t-primary bg-background text-foreground'
              : 'border-t-transparent text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground',
            isDragging && 'opacity-40'
          )}
        >
          <div
            ref={(node) => {
              innerRef.current = node
              dropRef(node)
            }}
            className={cn(
              'flex min-w-0 items-center gap-1.5 px-2.5 py-1 text-xs transition-colors',
              isOverTab && 'bg-primary/20'
            )}
          >
            <TabIcon tab={tab} />
            <span
              className="truncate"
              title={label}
              style={tabColor ? { color: tintText(tabColor) } : undefined}
            >
              {label}
            </span>
            {tab.type === 'terminal' && (
              <span
                title={exited ? '已退出' : '已连接'}
                className={cn(
                  'size-1.5 shrink-0 rounded-full',
                  exited ? 'bg-destructive' : 'bg-emerald-500'
                )}
              />
            )}
            {tab.closable && (
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  startRename()
                }}
                className="ml-0.5 rounded p-0.5 opacity-0 transition-opacity hover:bg-foreground/10 group-hover/tab:opacity-100"
                title="重命名标签"
                aria-label="重命名标签"
              >
                <Pencil className="size-3" />
              </button>
            )}
            {tab.closable && (
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  requestClosePanelTab(tab.id)
                }}
                className="ml-0.5 rounded p-0.5 opacity-0 transition-opacity hover:bg-foreground/10 group-hover/tab:opacity-100"
                title="关闭标签"
              >
                <X className="size-3" />
              </button>
            )}
          </div>
        </div>
      </Dropdown>

      {/*
        重命名弹窗：与 AgentPanel 的会话重命名同款（antd Modal + Input，Enter 直接保存）。
        每个标签一份、只在重命名时挂载（destroyOnHidden），portal 到 body 所以不受标签条裁切。
      */}
      <Modal
        open={renaming}
        onCancel={() => setRenaming(false)}
        onOk={submitRename}
        title="重命名标签"
        okText="保存"
        cancelText="取消"
        centered
        width={400}
        destroyOnHidden
      >
        <Input
          autoFocus
          placeholder="标签标题"
          value={renameDraft}
          onChange={(e) => setRenameDraft(e.target.value)}
          onPressEnter={submitRename}
        />
        <div className="mt-2 text-xs text-muted-foreground">留空保存可恢复自动标题</div>
      </Modal>
    </>
  )
}

/** 有自带关闭确认的页面（经 useTabEventBus 注册 close-request handler）：防手滑不再叠加，避免双重弹窗 */
const PAGE_MANAGED_CLOSE_TYPES: ReadonlySet<PanelTabType> = new Set(['note', 'agent'])

/**
 * 包装 TabContent 的关闭确认层：标签关闭总线的**所有者**（mount 创建、unmount 释放，
 * 见 `shared/lib/tab-event-bus.ts`），并给没有自带确认的页面注册防手滑通用确认
 * （受 confirmCloseTab 偏好控制）。
 *
 * Dirty 确认（未保存改动）/ 运行中确认由各页面自己经 useTabEventBus 注册
 * close-request handler 负责 —— 只有页面自己最清楚自己的保存状态。两类 handler
 * 在同一条总线上依次执行、任一 false 即阻止；确认框一律画在标签面板内部
 * （InlineConfirm），不再用 portal 到 body 的全局 Modal.confirm。
 */
function TabContentGuard({ tab, active }: { tab: PanelTab; active: boolean }) {
  const { confirm, element } = useInlineConfirm()
  /** 通用确认里「以后都不再提示」勾选（uncontrolled，点「关闭」时读一次） */
  const dontAskRef = useRef(false)
  const pageManagedClose = PAGE_MANAGED_CLOSE_TYPES.has(tab.type)
  // 确认框里用标签**当前显示**的名字：用户重命名过（customTitle）时不能还报自动标题
  const shownTitle = tab.customTitle?.trim() || tab.title

  // 总线所有者：标签内容挂载期间持有总线；unmount 释放（未决的确认会由
  // useInlineConfirm 的卸载结算按取消收尾，批量关闭路径不会悬挂）
  useEffect(() => {
    getTabBus(tab.id)
    return () => releaseTabBus(tab.id)
  }, [tab.id])

  useEffect(() => {
    if (pageManagedClose) return
    const off = getTabBus(tab.id).on('close-request', () => {
      const s = useAppStore.getState()
      // 防手滑确认（受偏好控制）
      if (!s.preferences.confirmCloseTab) return true
      dontAskRef.current = false
      return confirm({
        title: '关闭标签',
        content: `确定关闭标签「${shownTitle}」？`,
        extra: (
          <label className="mt-3 flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
            <input type="checkbox" onChange={(e) => (dontAskRef.current = e.target.checked)} />
            以后都不再提示
          </label>
        ),
        actions: [
          { label: '取消', value: false },
          {
            label: '关闭',
            kind: 'danger',
            value: true,
            run: async () => {
              if (dontAskRef.current) await useAppStore.getState().setConfirmCloseTab(false)
              return true
            }
          }
        ]
      })
    })
    return off
  }, [tab.id, shownTitle, pageManagedClose, confirm])

  return (
    <>
      <TabContent tab={tab} active={active} />
      {element}
    </>
  )
}

/** 单个标签的内容 */
function TabContent({ tab, active }: { tab: PanelTab; active: boolean }) {
  switch (tab.type) {
    case 'terminal': {
      if (!tab.sessionId) return null
      return <TerminalTab tabId={tab.id} sessionId={tab.sessionId} active={active} />
    }
    case 'script':
      return tab.scriptId ? <ScriptsPage tabId={tab.id} scriptId={tab.scriptId} /> : null
    case 'note':
      // active 传进去：标签保活（切走只是 hidden），笔记页要靠它「每次切回来都
      // 重新探一次文件是否还在」，否则被外部删掉的文件会一直安静地留着。
      return tab.noteFilePath ? <NotesPage tabId={tab.id} filePath={tab.noteFilePath} active={active} /> : null
    case 'api':
      if (!tab.apiRequestId) return null
      // 同一张表两种协议：ws 走 WebSocket 调试页，其余走 HTTP 请求页
      return tab.apiProtocol === 'ws' ? (
        <WsPage tabId={tab.id} requestId={tab.apiRequestId} />
      ) : (
        <ApiPage tabId={tab.id} requestId={tab.apiRequestId} />
      )
    case 'plugins':
      return <PluginsPage />
    case 'plugin':
      return tab.pluginViewId ? <PluginTabContent tab={tab} /> : null
    case 'sftp':
      return tab.sftpProfileId ? <SftpPage tabId={tab.id} profileId={tab.sftpProfileId} /> : null
    case 'rdp':
      return tab.rdpProfileId ? <RdpPage tabId={tab.id} profileId={tab.rdpProfileId} /> : null
    case 'tunnels':
      return <TunnelsPanel />
    case 'logs':
      return <HostLogsPanel />
    case 'agent':
      // 会话视图完全由 conversationId 驱动，所以一个标签一份实例、互不串台。
      // `visible` 给会话页用来「切过来的那一帧先把内容区宽度量准」（见 AgentPage 的 contentWidth）
      return tab.agentConversationId ? (
        <AgentPage tabId={tab.id} conversationId={tab.agentConversationId} visible={active} />
      ) : null
    default:
      return null
  }
}

/** 终端标签内容 */
function TerminalTab({ tabId, sessionId, active }: { tabId: string; sessionId: string; active: boolean }) {
  const session = useAppStore((s) => s.sessions.find((x: SessionInfo) => x.id === sessionId))
  if (!session) return null
  return <TerminalView tabId={tabId} session={session} isActive={active} />
}

/** 插件标签内容：渲染插件在 activate 时注册的视图组件 */
function PluginTabContent({ tab }: { tab: PanelTab }) {
  const plugins = useAppStore((s) => s.plugins)
  const view = plugins.find((p) => p.viewId === tab.pluginViewId)
  if (!view) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        插件视图未加载
      </div>
    )
  }
  return <view.Component />
}
