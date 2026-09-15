import {
  Fragment,
  type DragEvent as ReactDragEvent,
  type PointerEvent as ReactPointerEvent,
  useRef,
  useState
} from 'react'
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Plus,
  TerminalSquare,
  X
} from 'lucide-react'
import { cn } from 'cn'
import type { SessionInfo } from '@shared/types'
import { useAppStore } from '@/stores/app-store'
import { TerminalView } from '@/components/TerminalView'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import type { PaneNode, SplitDirection, SplitDirectionInput } from '@/lib/pane-layout'

/** 拖拽标签时用于跨组传递的 dataTransfer 类型标识 */
const SESSION_DRAG_TYPE = 'application/x-session-id'
/** 当前正在被拖拽的会话 ID（dragover 阶段拿不到 dataTransfer，用模块变量判断来源组） */
let draggingSessionId: string | null = null

/** 递归渲染分屏布局树 */
export function PaneLayout({ layout }: { layout: PaneNode }) {
  if (layout.type === 'leaf') {
    return <GroupView groupId={layout.groupId} />
  }
  return (
    <div
      className={cn(
        'flex h-full w-full min-h-0',
        layout.direction === 'row' ? 'flex-row' : 'flex-col'
      )}
    >
      {layout.children.map((child, i) => (
        <Fragment key={child.id}>
          <div
            className="min-h-0 min-w-0"
            style={{ flexGrow: layout.sizes[i] ?? 1, flexBasis: 0 }}
          >
            <PaneLayout layout={child} />
          </div>
          {i < layout.children.length - 1 && (
            <Splitter
              splitId={layout.id}
              index={i}
              direction={layout.direction}
              sizes={layout.sizes}
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
  const exited = useAppStore((s) => s.exitedSessions)
  const active = useAppStore((s) => s.activeGroupId === groupId)
  const setActiveGroup = useAppStore((s) => s.setActiveGroup)
  const setActiveSession = useAppStore((s) => s.setActiveSession)
  const splitActivePane = useAppStore((s) => s.splitActivePane)
  const closeGroup = useAppStore((s) => s.closeGroup)
  const closeSession = useAppStore((s) => s.closeSession)
  const createLocalSession = useAppStore((s) => s.createLocalSession)
  const moveSessionToGroup = useAppStore((s) => s.moveSessionToGroup)

  // 是否有标签正被拖到本组上方（用于高亮放置目标）；用模块变量排除来源组
  const [dragOver, setDragOver] = useState(false)

  if (!group) return null

  const focus = () => setActiveGroup(groupId)
  // 在本组内新建终端：先让本组成为激活组，再追加标签
  const newInGroup = () => {
    setActiveGroup(groupId)
    void createLocalSession()
  }
  // 向某方向拆分：先让本组成为激活组，再在旁新建组
  const doSplit = (d: SplitDirectionInput) => {
    setActiveGroup(groupId)
    void splitActivePane(d)
  }

  // 仅当被拖拽会话不属于本组时才作为有效放置目标
  const canDrop = !!draggingSessionId && !group.sessionIds.includes(draggingSessionId)

  const onDragOver = (e: ReactDragEvent<HTMLDivElement>) => {
    if (!draggingSessionId) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    if (canDrop && !dragOver) setDragOver(true)
  }
  const onDragLeave = (e: ReactDragEvent<HTMLDivElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(false)
  }
  const onDrop = (e: ReactDragEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()
    setDragOver(false)
    const sid = e.dataTransfer.getData(SESSION_DRAG_TYPE) || draggingSessionId
    if (sid) moveSessionToGroup(sid, groupId)
    draggingSessionId = null
  }

  return (
    <div
      className={cn(
        'group flex h-full w-full min-h-0 flex-col',
        active ? 'bg-background' : 'bg-background/60',
        dragOver && 'ring-2 ring-primary/70 ring-inset'
      )}
      onMouseDown={focus}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {/* 标签页条 */}
      <div
        className={cn(
          'select-none flex h-8 shrink-0 items-stretch border-b',
          active ? 'border-border' : 'border-border/60'
        )}
      >
        <div className="no-scrollbar flex flex-1 items-stretch overflow-x-auto">
          {group.sessionIds.map((sid) => {
            const session = sessions.find((x: SessionInfo) => x.id === sid)
            const isActiveTab = group.activeSessionId === sid
            const isExited = exited.has(sid)
            return (
              <ContextMenu
                key={sid}
                onOpenChange={(o) => {
                  // 右键菜单打开时，先让所在组/该标签成为激活目标，拆分才作用在正确的组上
                  if (o) {
                    setActiveGroup(groupId)
                    setActiveSession(sid)
                  }
                }}
              >
                <ContextMenuTrigger asChild>
                  <div
                    draggable
                    onDragStart={(e) => {
                      draggingSessionId = sid
                      e.dataTransfer.setData(SESSION_DRAG_TYPE, sid)
                      e.dataTransfer.effectAllowed = 'move'
                    }}
                    onDragEnd={() => {
                      draggingSessionId = null
                      setDragOver(false)
                    }}
                    onClick={() => setActiveSession(sid)}
                    title="拖拽到其它面板可分屏放置"
                    className={cn(
                      'group/tab flex max-w-52 shrink-0 cursor-pointer items-center gap-1.5 border-r border-border/60 px-2.5 text-xs transition-colors',
                      isActiveTab
                        ? 'bg-background text-foreground'
                        : 'text-muted-foreground hover:text-foreground'
                    )}
                  >
                    <TerminalSquare className="size-3.5 shrink-0" />
                    <span className="truncate" title={session?.title}>
                      {session?.title ?? '终端'}
                    </span>
                    {isExited && (
                      <span className="shrink-0 text-[10px] text-destructive">已退出</span>
                    )}
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        void closeSession(sid)
                      }}
                      className="ml-0.5 rounded p-0.5 opacity-0 transition-opacity hover:bg-secondary group-hover/tab:opacity-100"
                      title="关闭标签"
                    >
                      <X className="size-3" />
                    </button>
                  </div>
                </ContextMenuTrigger>
                <ContextMenuContent>
                  <ContextMenuLabel className="truncate">
                    {session?.title ?? '终端'}
                  </ContextMenuLabel>
                  <ContextMenuSeparator />
                  <ContextMenuItem onSelect={() => doSplit('up')}>
                    <ArrowUp /> 向上拆分
                  </ContextMenuItem>
                  <ContextMenuItem onSelect={() => doSplit('down')}>
                    <ArrowDown /> 向下拆分
                  </ContextMenuItem>
                  <ContextMenuItem onSelect={() => doSplit('left')}>
                    <ArrowLeft /> 向左拆分
                  </ContextMenuItem>
                  <ContextMenuItem onSelect={() => doSplit('right')}>
                    <ArrowRight /> 向右拆分
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem onSelect={newInGroup}>
                    <Plus /> 在本组新建终端
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem variant="destructive" onSelect={() => void closeSession(sid)}>
                    <X /> 关闭标签
                  </ContextMenuItem>
                  <ContextMenuItem
                    variant="destructive"
                    onSelect={() => void closeGroup(groupId)}
                  >
                    <X /> 关闭整个组
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            )
          })}
        </div>
      </div>

      {/* 当前激活终端（同组内其余标签保持挂载以保留输出） */}
      <div className="min-h-0 flex-1">
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
    </div>
  )
}
