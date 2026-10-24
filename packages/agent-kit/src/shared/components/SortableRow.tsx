/**
 * 可排序列表的一行：左侧一把拖拽把手，**拖到哪条就插到哪条前**。
 *
 * 拖拽排序的标准写法就是「每条既是 drop 又是 drag」：拖动中经过哪条，就在那条的 `hover`
 * 回调里把数组重排一次 —— 视觉上是插到它前面、其它条目实时让位，松手时数组已经是正确
 * 顺序。排序是「指针落点即改」，所以拖到哪条就插到哪条前，不需要额外的落点提示。
 *
 * ## 指示器只有把手一种（两种设备一致）
 *
 * 鼠标走 react-dnd 的 HTML5 后端；触屏上 HTML5 后端**根本起不动**（浏览器不给 touch 派发
 * `dragstart`），那一路由把手自己扛：指针捕获 + 「指针下是哪一行就插到哪一行前」，规则与
 * 桌面 `hover` 完全一致。此前队列列表在触屏上是 ↑↓ 两颗箭头，两套指示器并排会让
 * 「这条能不能拖、怎么拖」在换设备后整个变样 —— 快捷功能弹窗的排序也从 ↑↓ 换成了这把
 * 把手，**别再加回箭头**。
 *
 * ## 只共用排序那部分
 *
 * 把手 / 拖拽淡出 / 行容器与 hover 底色在这里；正文与右侧按钮由调用方给 —— 各列表的按钮
 * 语义不同（队列是「现在发 / 编辑 / 删除」，插话是「编辑 / 撤回」，快捷功能是「编辑 /
 * 删除」），硬塞进一套只会长出一堆 `mode` 分支。`dragType` 也由调用方传：跨列表拖拽没有
 * 语义，靠类型让各列表互不接受对方的拖拽。
 *
 * ## `moveTo` 与「什么时候落库」
 *
 * `moveTo(draggedId, beforeId)` **每一次经过都会调**，所以它只该改**内存里的顺序**：
 * 队列 / 插话那两张列表由 store 就地重排并同步；需要「松手才提交」的调用方（快捷功能要整份
 * 重写 `workspace.json`）传 `onDragEnd`，在那里落库。别在 `moveTo` 里直接写盘 / 发请求。
 *
 * ⚠️ `DndProvider` 全应用只有 `app-shell` 根上那一份，这里**不要**再挂（见
 * `shared/lib/dnd-context.ts`）。
 */
import { type ReactNode, useCallback, useRef } from 'react'
import { GripVertical } from 'lucide-react'
import { useDrag, useDrop } from 'react-dnd'
import { Tooltip, TooltipContent, TooltipTrigger } from '@fizz/ui/tooltip'
import { cn } from '@fizz/agent-kit/shared/lib/utils'
import { useT } from '@fizz/agent-kit/shared/lib/language'

export function SortableRow({
  id,
  dragType,
  canTouch,
  moveTo,
  onDragEnd,
  className,
  children
}: {
  id: string
  /** 拖拽类型（各列表各一份，互不接受对方的拖拽） */
  dragType: string
  /** 触屏设备：HTML5 拖拽起不动，改由把手自己扛（见下面那个指针捕获） */
  canTouch: boolean
  /** 拖到某条上：把 `draggedId` 挪到 `beforeId` 前面（下标由调用方从最新数组算） */
  moveTo: (draggedId: string, beforeId: string) => void
  /** 拖拽结束（松手 / 取消）：需要「松手才落库」的调用方在这里提交 */
  onDragEnd?: () => void
  /** 追加到行容器上的类名（各列表的行外壳样式不同：队列是裸行，快捷功能是带边框的卡片） */
  className?: string
  children: ReactNode
}) {
  const t = useT()
  /** 用 ref 兜住回调：`useDrag` 的 spec 在拖拽开始时才读，闭包里的旧函数会拿到旧 state */
  const onDragEndRef = useRef(onDragEnd)
  onDragEndRef.current = onDragEnd

  const [{ isDragging }, dragRef, dragPreviewRef] = useDrag({
    type: dragType,
    item: () => ({ id }),
    collect: (monitor) => ({ isDragging: monitor.isDragging() }),
    end: () => onDragEndRef.current?.()
  })
  const [, dropRef] = useDrop({
    accept: dragType,
    hover(dragged: { id: string }) {
      // 自己拖自己不用动；下标交给调用方从最新数组里算（它才是权威）
      if (dragged.id === id) return
      moveTo(dragged.id, id)
    }
  })

  /**
   * 触屏上的排序：按下把手 → 捕获指针 → 指针每落到**另一行**上就按那条重排
   * （与上面 `hover` 的规则完全一致：插到它前面）。视觉与桌面那条 `dragstart` 路径同款。
   *
   * 判据用 `elementFromPoint` 而非算位移：行高会随正文行数变，拿固定行高换算迟早错位；
   * 直接问「指针下是哪一行」则永远对。
   *
   * ⚠️ 指针捕获期间 `elementFromPoint` 不受影响（捕获只改事件派发目标），所以移到把手外面
   * 也照样能命中下面的行 —— 这正是要的：拖着越过边界时仍要让位。
   */
  const touchDraggingRef = useRef(false)
  const onGripPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>): void => {
      if (!canTouch) return
      // 触屏之外（鼠标）那条路交给 react-dnd，别抢它的活
      if (e.pointerType === 'mouse') return
      touchDraggingRef.current = true
      e.currentTarget.setPointerCapture(e.pointerId)
    },
    [canTouch]
  )
  const onGripPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>): void => {
      if (!touchDraggingRef.current) return
      const el = document.elementFromPoint(e.clientX, e.clientY)
      const row = el?.closest<HTMLElement>('[data-sortable-id]')
      const overId = row?.dataset.sortableId
      if (!overId || overId === id) return
      moveTo(id, overId)
    },
    [id, moveTo]
  )
  const onGripPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>): void => {
    const wasDragging = touchDraggingRef.current
    touchDraggingRef.current = false
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
    // 触屏这条路没有 react-dnd 的 `end`，落库时机得在这里补上
    if (wasDragging) onDragEndRef.current?.()
  }, [])
  /**
   * 行本体既是拖拽源（拖动它）又是放置目标（拖到哪条就插到哪条前）。
   *
   * 用回调 ref 把 **DOM 节点**直接交给 react-dnd 的 connector，而不是先 `useRef` 再
   * `dragRef(ref)`：connector 本来就收节点（官方示例就是这种 callback ref 写法），
   * 而传 ref 对象等于让别人在渲染期去读它的 `.current`。卸载时 React 回调 null，
   * 正好让 connector 把节点断开。
   */
  const attachRow = useCallback(
    (node: HTMLDivElement | null) => {
      dragRef(dragPreviewRef(node))
      dropRef(node)
    },
    [dragRef, dragPreviewRef, dropRef]
  )
  return (
    <div
      ref={attachRow}
      data-sortable-id={id}
      className={cn(
        'group flex items-center gap-1.5 rounded-md px-1 py-1 transition-colors hover:bg-foreground/5',
        isDragging && 'opacity-40',
        className
      )}
    >
      {/*
        排序把手：**两种设备都是它**。`touch-action: none` 是必需的，否则浏览器的滚动手势
        会把纵向拖拽吃掉。
      */}
      <Tooltip>
        <TooltipTrigger asChild>
          <div
            onPointerDown={onGripPointerDown}
            onPointerMove={onGripPointerMove}
            onPointerUp={onGripPointerUp}
            onPointerCancel={onGripPointerUp}
            className="shrink-0 cursor-grab touch-none text-muted-foreground/40 transition-colors hover:text-muted-foreground active:cursor-grabbing"
          >
            <GripVertical className="size-3.5" />
          </div>
        </TooltipTrigger>
        <TooltipContent side="top">{t('按住拖动调整顺序')}</TooltipContent>
      </Tooltip>
      {children}
    </div>
  )
}
