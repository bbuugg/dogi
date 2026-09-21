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
  ArrowRight,
  ArrowUp,
  Boxes,
  FileCode2,
  FileText,
  Globe,
  Plus,
  Puzzle,
  TerminalSquare,
  X
} from 'lucide-react'
import { cn } from 'cn'
import type { SessionInfo } from '@shared/types'
import { groupTerminalSessionId, useAppStore, type PanelTab, type PanelTabType } from '@/stores/app-store'
import { TerminalView } from '@/components/TerminalView'
import { AiPanel } from '@/components/AiPanel'
import { ApiPage } from '@/components/ApiPage'
import { ScriptsPage } from '@/components/ScriptsPage'
import { NotesPage } from '@/components/NotesPage'
import { PluginsPage } from '@/components/PluginsPage'
import { Button, Dropdown } from 'antd'
import { useDrag, useDrop } from 'react-dnd'
import type { PaneNode, SplitDirection, SplitDirectionInput } from '@/lib/pane-layout'
import { resolveSshColor, tintText } from '@/lib/ssh-color'

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

/** 各标签类型的图标 */
function TabIcon({ type }: { type: PanelTabType }) {
  switch (type) {
    case 'terminal':
      return <TerminalSquare className="size-3.5 shrink-0" />
    case 'script':
      return <FileCode2 className="size-3.5 shrink-0" />
    case 'note':
      return <FileText className="size-3.5 shrink-0" />
    case 'api':
      return <Globe className="size-3.5 shrink-0" />
    case 'plugins':
      return <Boxes className="size-3.5 shrink-0" />
    case 'plugin':
      return <Puzzle className="size-3.5 shrink-0" />
  }
}

/** 空状态：还没有打开任何标签页 */
function EmptyState() {
  const setSshDialog = useAppStore((s) => s.setSshDialog)
  const createLocalSession = useAppStore((s) => s.createLocalSession)
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 text-muted-foreground">
      <TerminalSquare className="size-12 opacity-30" />
      <div className="text-sm">还没有打开任何面板</div>
      <div className="text-xs">双击左侧主机即可连接，或在下方新建一个本地终端</div>
      <div className="flex items-center gap-2">
        <Button
          type='primary'
          onClick={() => void createLocalSession()}
        >
          新建本地终端
        </Button>
        <Button onClick={() => setSshDialog(true, null)}>
          添加主机
        </Button>
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
    <div className="flex h-full min-h-0 w-full flex-col">
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
    const MIN = 0.05 * total

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
      document.body.style.cursor = ''
    }
    document.body.style.cursor = direction === 'row' ? 'col-resize' : 'row-resize'
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  return (
    <div
      ref={ref}
      onPointerDown={onPointerDown}
      className={cn(
        'shrink-0 bg-border transition-colors hover:bg-primary',
        direction === 'row' ? 'w-px cursor-col-resize' : 'h-px cursor-row-resize'
      )}
    />
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
      <div
        className={cn(
          'flex h-8 shrink-0 items-stretch border-b',
          active ? 'border-border' : 'border-border/10'
        )}
      >
        <div
          ref={stripRef as (node: HTMLDivElement | null) => void}
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
          <NewTabButton groupId={groupId} />
        </div>
        {/* 组操作：关闭整个组（AI 助手开关在状态栏，见 AiStatusButton） */}
        {groupCount > 1 && (
          <button
            type="button"
            title="关闭整个组"
            onClick={() => requestCloseGroup(groupId)}
            className="flex w-8 shrink-0 items-center justify-center border-l border-border/60 text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
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
              <div key={tid} className={isActive ? 'h-full' : 'hidden'}>
                <TabContent tab={tab} active={active && isActive} />
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
  const createApiRequest = useAppStore((s) => s.createApiRequest)
  const openApiTab = useAppStore((s) => s.openApiTab)
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
          { key: 'host', icon: <Plus className="size-3.5" />, label: '添加主机…' }
        ],
        onClick: ({ key }) => {
          if (key === 'local') void createLocalSession()
          else if (key === 'api') {
            void createApiRequest().then((id) => {
              if (id) openApiTab(id)
            })
          } else setSshDialog(true, null)
        }
      }}
    >
      <button
        type="button"
        title="新建终端 / 接口请求 / 添加主机"
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
  const reorderTabs = useAppStore((s) => s.reorderTabs)
  const moveTabToGroup = useAppStore((s) => s.moveTabToGroup)
  const innerRef = useRef<HTMLDivElement | null>(null)

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
  const label = profile?.name ?? session?.title ?? tab.title

  const focus = useCallback(() => {
    setActiveGroup(groupId)
    if (tab.sessionId) setActiveSession(tab.sessionId)
    else activatePanelTab(tab.id)
  }, [groupId, tab.id, tab.sessionId, setActiveGroup, setActiveSession, activatePanelTab])

  return (
    <Dropdown
      trigger={['contextMenu']}
      onOpenChange={(o) => {
        // 右键菜单打开时先聚焦，拆分/关闭才作用在正确的组与标签上
        if (o) focus()
      }}
      menu={{
        items: [
          { key: 'title', label, disabled: true },
          { type: 'divider' },
          // 拆分只搬动标签本身（把它拎到该方向的新组）。组内只有这一个标签时没有可拆的
          // 东西，置灰 —— 不再「顺手新建一个终端」来凑分屏，标签功能不牵连其它功能。
          {
            key: 'split-up',
            icon: <ArrowUp className="size-3.5" />,
            label: '向上拆分',
            disabled: tabCount === 1
          },
          {
            key: 'split-down',
            icon: <ArrowDown className="size-3.5" />,
            label: '向下拆分',
            disabled: tabCount === 1
          },
          {
            key: 'split-left',
            icon: <ArrowLeft className="size-3.5" />,
            label: '向左拆分',
            disabled: tabCount === 1
          },
          {
            key: 'split-right',
            icon: <ArrowRight className="size-3.5" />,
            label: '向右拆分',
            disabled: tabCount === 1
          },
          { type: 'divider' },
          {
            key: 'close-tab',
            icon: <X className="size-3.5" />,
            label: '关闭标签',
            danger: true
          },
          {
            key: 'close-group',
            icon: <X className="size-3.5" />,
            label: '关闭整个组',
            danger: true
          }
        ],
        onClick: ({ key }) => {
          if (key.startsWith('split-')) {
            if (tabCount === 1) return
            splitTabToGroup(tab.id, groupId, key.slice('split-'.length) as SplitDirectionInput)
          } else if (key === 'close-tab') {
            requestClosePanelTab(tab.id)
          } else if (key === 'close-group') {
            requestCloseGroup(groupId)
          }
        }
      }}
    >
      <div
        ref={dragRef as (node: HTMLDivElement | null) => void}
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
          <TabIcon type={tab.type} />
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
  )
}

/** 单个标签的内容 */
function TabContent({ tab, active }: { tab: PanelTab; active: boolean }) {
  switch (tab.type) {
    case 'terminal': {
      if (!tab.sessionId) return null
      return <TerminalTab sessionId={tab.sessionId} active={active} />
    }
    case 'script':
      return tab.scriptId ? <ScriptsPage scriptId={tab.scriptId} /> : null
    case 'note':
      return tab.noteId ? <NotesPage noteId={tab.noteId} /> : null
    case 'api':
      return tab.apiRequestId ? <ApiPage requestId={tab.apiRequestId} /> : null
    case 'plugins':
      return <PluginsPage />
    case 'plugin':
      return tab.pluginViewId ? <PluginTabContent tab={tab} /> : null
    default:
      return null
  }
}

/** 终端标签内容 */
function TerminalTab({ sessionId, active }: { sessionId: string; active: boolean }) {
  const session = useAppStore((s) => s.sessions.find((x: SessionInfo) => x.id === sessionId))
  if (!session) return null
  return <TerminalView session={session} isActive={active} />
}

/** 插件标签内容：webview 或组件 */
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
  if (view.renderType === 'webview' && view.webviewEntry) {
    return <PluginWebviewTab entry={view.webviewEntry} preload={view.webviewPreload} active />
  }
  return <view.Component />
}

/** 插件 webview 渲染器：创建 <webview> 标签加载插件独立构建的 HTML */
function PluginWebviewTab({
  entry,
  preload,
  active
}: {
  entry: string
  preload?: string | null
  active: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [loading, setLoading] = useState(true)

  const isDark = useAppStore((s) => s.preferences.theme === 'dark')
  const colorTheme = useAppStore((s) => s.preferences.colorTheme)
  const customColor = useAppStore((s) => s.preferences.customColor)

  const pushTheme = useCallback(() => {
    const container = ref.current
    if (!container) return
    const wv = container.querySelector('webview') as (Electron.WebviewTag & { send: (ch: string, ...args: unknown[]) => void }) | null
    if (!wv) return
    if (!wv.isConnected) return
    const data = {
      isDark,
      colorTheme,
      customVars: customColor ? { '--primary': customColor } : undefined
    }
    try {
      wv.send('plugin:theme', data)
    } catch {
      // ignore
    }
  }, [isDark, colorTheme, customColor])

  useEffect(() => {
    const container = ref.current
    if (!container) return

    const oldWv = container.querySelector('webview')
    if (oldWv) {
      try {
        oldWv.remove()
      } catch {
        container.innerHTML = ''
      }
    }

    setLoading(true)

    let webview: (Electron.WebviewTag & { send: (ch: string, ...args: unknown[]) => void }) | null = null
    let cancelled = false

    const createWv = () => {
      if (cancelled || !container) return
      webview = document.createElement('webview') as Electron.WebviewTag & {
        send: (ch: string, ...args: unknown[]) => void
      }
      webview.src = entry
      webview.style.width = '100%'
      webview.style.height = '100%'
      webview.style.border = 'none'
      webview.setAttribute(
        'webpreferences',
        'contextIsolation=yes,nodeIntegration=no,spellcheck=no'
      )
      if (preload) {
        webview.setAttribute('preload', preload)
      }

      const onStopLoading = () => {
        if (!webview?.isConnected) return
        setLoading(false)
        pushTheme()
      }
      const onDomReady = () => {
        if (!webview?.isConnected) return
        pushTheme()
      }
      webview.addEventListener('did-stop-loading', onStopLoading)
      webview.addEventListener('dom-ready', onDomReady)

      try {
        container.appendChild(webview)
      } catch {
        // ignore
      }
    }

    queueMicrotask(createWv)

    return () => {
      cancelled = true
      if (webview) {
        try {
          webview.remove()
        } catch {
          // ignore
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry, preload])

  useEffect(() => {
    pushTheme()
  }, [pushTheme])

  return (
    <div
      ref={ref}
      className="relative h-full w-full"
      style={{ display: active ? 'block' : 'none' }}
    >
      {loading && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-background">
          <div className="text-muted-foreground text-sm">加载中…</div>
        </div>
      )}
    </div>
  )
}
