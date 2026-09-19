import {
  Fragment,
  type PointerEvent as ReactPointerEvent,
  useRef
} from 'react'
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Plus,
  Sparkles,
  TerminalSquare,
  X
} from 'lucide-react'
import { cn } from 'cn'
import type { SessionInfo } from '@shared/types'
import { useAppStore } from '@/stores/app-store'
import { TerminalView } from '@/components/TerminalView'
import { AiPanel } from '@/components/AiPanel'
import { ResizeHandle } from '@/components/ResizeHandle'
import { Dropdown } from 'antd'
import { useDrag, useDrop } from 'react-dnd'
import type { PaneNode, SplitDirection } from '@/lib/pane-layout'
import { resolveSshColor, tintText } from '@/lib/ssh-color'

/** react-dnd 拖拽标签的 item 类型与载荷（带来源组，drop 端据此判断跨组移动） */
const TAB_DND_TYPE = 'terminal-tab'
interface TabDragItem {
  sessionId: string
  groupId: string
}
/** 标签 drop target 收集到的状态 */
interface TabDropCollected {
  isOverGroup: boolean
  canDrop: boolean
  crossGroup: boolean
}

/** 递归渲染分屏布局树 */
export function PaneLayout({ layout }: { layout: PaneNode }) {
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
              <GroupView groupId={child.groupId} />
            ) : (
              <PaneLayout layout={child} />
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

/** 单个编辑器组：标题栏（标签页 + 拆分/关闭组按钮）+ 当前激活终端 */
function GroupView({ groupId }: { groupId: string }) {
  const group = useAppStore((s) => s.groups[groupId])
  const sessions = useAppStore((s) => s.sessions)
  const active = useAppStore((s) => s.activeGroupId === groupId)
  const setActiveGroup = useAppStore((s) => s.setActiveGroup)
  // 本组的 AI 助手（每个终端组内嵌一个，多组互不影响）
  const aiOpen = useAppStore((s) => !!s.ui.aiOpenGroups[groupId])
  const setGroupAiOpen = useAppStore((s) => s.setGroupAiOpen)
  const aiPanelWidth = useAppStore((s) => s.ui.aiPanelWidth)
  const setAiPanelWidth = useAppStore((s) => s.setAiPanelWidth)
  // 是否接收从其它组拖来的标签：仅作为放置目标时显示高亮。
  // react-dnd 在 drop 端能拿到被拖 item 的来源组，据此判断跨组。
  const moveSessionToGroup = useAppStore((s) => s.moveSessionToGroup)
  const reorderSessions = useAppStore((s) => s.reorderSessions)
  const [{ isOverGroup, canDrop, crossGroup }, dropRef] = useDrop<
    TabDragItem,
    unknown,
    TabDropCollected
  >(
    () => ({
      accept: TAB_DND_TYPE,
      drop: (item, monitor) => {
        // 落到具体标签上时已被 GroupTab 处理，这里避免重复移动
        if (monitor.didDrop()) return
        if (item.groupId === groupId) {
          // 同组拖到 tab 条末尾空白：把该标签移到组尾
          reorderSessions(groupId, item.sessionId, group?.sessionIds.length ?? 0)
        } else {
          moveSessionToGroup(item.sessionId, groupId)
        }
      },
      collect: (m) => ({
        isOverGroup: m.isOver(),
        canDrop: m.canDrop(),
        crossGroup: (m.getItem() as TabDragItem | null | undefined)?.groupId !== groupId
      })
    }),
    [groupId, moveSessionToGroup, reorderSessions, group?.sessionIds.length]
  )
  const dragOver = isOverGroup && canDrop && crossGroup

  if (!group) return null

  const focus = () => setActiveGroup(groupId)

  const dropRefFn = dropRef as (node: HTMLDivElement | null) => void

  return (
    <div
      ref={dropRefFn}
      className={cn(
        'group flex h-full w-full min-h-0 flex-col',
        active ? 'bg-background' : 'bg-background/60',
        dragOver && 'ring-2 ring-primary/70 ring-inset'
      )}
      onMouseDown={focus}
    >
      {/* 标签页条 */}
      <div
        className={cn(
          'flex h-8 shrink-0 items-stretch border-b',
          active ? 'border-border' : 'border-border/10'
        )}
      >
        <div className="no-scrollbar flex flex-1 items-stretch overflow-x-auto">
          {group.sessionIds.map((sid) => (
            <GroupTab key={sid} sessionId={sid} groupId={groupId} />
          ))}
        </div>
        {/* AI 助手开关：AI 属于终端组，不作为全局功能 */}
        <button
          type="button"
          title={aiOpen ? '隐藏 AI 助手' : '显示 AI 助手'}
          onClick={() => setGroupAiOpen(groupId, !aiOpen)}
          className={cn(
            'flex w-8 shrink-0 items-center justify-center border-l border-border/60 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground',
            aiOpen && 'text-primary'
          )}
        >
          <Sparkles className="size-3.5" />
        </button>
      </div>

      {/* 终端 +（可选）本组的 AI 助手侧栏；同组内其余标签保持挂载以保留输出 */}
      <div className="flex min-h-0 flex-1">
        <div className="min-h-0 min-w-0 flex-1">
          {group.sessionIds.map((sid) => {
            const session = sessions.find((x: SessionInfo) => x.id === sid)
            if (!session) return null
            const isActive = group.activeSessionId === sid
            return (
              <div
                key={sid}
                className={isActive ? 'h-full' : 'hidden'}
              >
                <TerminalView session={session} isActive={active && isActive} />
              </div>
            )
          })}
        </div>
        {aiOpen && group.activeSessionId && (
          <>
            <ResizeHandle
              width={aiPanelWidth}
              min={280}
              max={720}
              onResize={setAiPanelWidth}
              invert
            />
            <AiPanel sessionId={group.activeSessionId} />
          </>
        )}
      </div>
    </div>
  )
}

/** 终端组内单个标签页：可被 react-dnd 拖到其它组以分屏放置 */
function GroupTab({ sessionId, groupId }: { sessionId: string; groupId: string }) {
  const session = useAppStore((s) => s.sessions.find((x: SessionInfo) => x.id === sessionId))
  const profiles = useAppStore((s) => s.profiles)
  const sshGroups = useAppStore((s) => s.sshGroups)
  const exited = useAppStore((s) => s.exitedSessions)
  const isActive = useAppStore((s) => s.groups[groupId]?.activeSessionId === sessionId)
  const setActiveGroup = useAppStore((s) => s.setActiveGroup)
  const setActiveSession = useAppStore((s) => s.setActiveSession)
  const splitActivePane = useAppStore((s) => s.splitActivePane)
  const closeSession = useAppStore((s) => s.closeSession)
  const closeGroup = useAppStore((s) => s.closeGroup)
  const createLocalSession = useAppStore((s) => s.createLocalSession)
  const moveSessionToGroup = useAppStore((s) => s.moveSessionToGroup)
  const reorderSessions = useAppStore((s) => s.reorderSessions)
  // 本标签在组内的索引（用于计算组内重排的目标位）
  const tabIndex = useAppStore((s) => s.groups[groupId]?.sessionIds.indexOf(sessionId) ?? -1)
  const innerRef = useRef<HTMLDivElement | null>(null)
  // 标签自身也是放置目标：处理组内重排；跨组拖到本标签则移入本组
  const [{ isOverTab }, dropRef] = useDrop<TabDragItem, unknown, { isOverTab: boolean }>(
    () => ({
      accept: TAB_DND_TYPE,
      drop: (item, monitor) => {
        if (item.groupId === groupId) {
          // 组内重排：按落点在标签左/右半边决定插到其前/后
          const rect = innerRef.current?.getBoundingClientRect()
          const offset = monitor.getClientOffset()
          let before = true
          if (rect && offset) before = offset.x < rect.left + rect.width / 2
          reorderSessions(groupId, item.sessionId, tabIndex + (before ? 0 : 1))
        } else {
          // 跨组拖到本标签：移入本组（容器 drop 会经 didDrop 跳过，避免重复移动）
          moveSessionToGroup(item.sessionId, groupId)
        }
      },
      collect: (m) => ({ isOverTab: m.isOver() })
    }),
    [groupId, tabIndex, reorderSessions, moveSessionToGroup]
  )

  const isExited = exited.has(sessionId)
  // SSH 会话沿用其主机（或所属分组）的颜色，本地终端无颜色
  const profile = session?.profileId ? profiles.find((p) => p.id === session.profileId) : undefined
  const tabColor = profile ? resolveSshColor(profile, sshGroups) : undefined
  // SSH 标签显示主机名（连接名字），本地终端仍用会话标题
  const tabLabel = profile?.name ?? session?.title ?? '终端'

  const [{ isDragging }, dragRef] = useDrag(
    () => ({
      type: TAB_DND_TYPE,
      item: { sessionId, groupId } satisfies TabDragItem,
      collect: (m) => ({ isDragging: m.isDragging() })
    }),
    [sessionId, groupId]
  )

  return (
    <Dropdown
      trigger={['contextMenu']}
      onOpenChange={(o) => {
        // 右键菜单打开时，先让所在组/该标签成为激活目标，拆分才作用在正确的组上
        if (o) {
          setActiveGroup(groupId)
          setActiveSession(sessionId)
        }
      }}
      menu={{
        items: [
          { key: 'title', label: session?.title ?? '终端', disabled: true },
          { type: 'divider' },
          { key: 'split-up', icon: <ArrowUp className="size-3.5" />, label: '向上拆分' },
          { key: 'split-down', icon: <ArrowDown className="size-3.5" />, label: '向下拆分' },
          { key: 'split-left', icon: <ArrowLeft className="size-3.5" />, label: '向左拆分' },
          { key: 'split-right', icon: <ArrowRight className="size-3.5" />, label: '向右拆分' },
          { type: 'divider' },
          {
            key: 'new-in-group',
            icon: <Plus className="size-3.5" />,
            label: '在本组新建终端'
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
          if (key === 'split-up') {
            setActiveGroup(groupId)
            void splitActivePane('up')
          } else if (key === 'split-down') {
            setActiveGroup(groupId)
            void splitActivePane('down')
          } else if (key === 'split-left') {
            setActiveGroup(groupId)
            void splitActivePane('left')
          } else if (key === 'split-right') {
            setActiveGroup(groupId)
            void splitActivePane('right')
          } else if (key === 'new-in-group') {
            setActiveGroup(groupId)
            void createLocalSession()
          } else if (key === 'close-tab') {
            void closeSession(sessionId)
          } else if (key === 'close-group') {
            void closeGroup(groupId)
          }
        }
      }}
    >
      <div
        ref={dragRef as (node: HTMLDivElement | null) => void}
        onClick={() => setActiveSession(sessionId)}
        title="拖拽标签可跨组分屏放置或在本组内排序"
        className={cn(
          'group/tab flex max-w-52 shrink-0 cursor-pointer items-center border-r border-border/60 transition-colors',
          isActive
            ? 'bg-background text-foreground'
            : 'text-muted-foreground hover:text-foreground',
          isDragging && 'opacity-40'
        )}
      >
        <div
          ref={dropRef as (node: HTMLDivElement | null) => void}
          className={cn(
            'flex min-w-0 items-center gap-1.5 px-2.5 py-1 text-xs transition-colors',
            isOverTab && 'bg-primary/20'
          )}
        >
        <TerminalSquare
          className="size-3.5 shrink-0"
          style={tabColor ? { color: tabColor } : undefined}
        />
        <span
          className="truncate"
          title={session?.title}
          style={tabColor ? { color: tintText(tabColor) } : undefined}
        >
          {tabLabel}
        </span>
        <span
          title={isExited ? '已退出' : '已连接'}
          className={cn(
            'size-1.5 shrink-0 rounded-full',
            isExited ? 'bg-destructive' : 'bg-emerald-500'
          )}
        />
        <button
          onClick={(e) => {
            e.stopPropagation()
            void closeSession(sessionId)
          }}
          className="ml-0.5 rounded p-0.5 opacity-0 transition-opacity hover:bg-secondary group-hover/tab:opacity-100"
          title="关闭标签"
        >
          <X className="size-3" />
        </button>
        </div>
      </div>
    </Dropdown>
  )
}
