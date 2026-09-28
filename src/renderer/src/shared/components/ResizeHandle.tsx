import { type PointerEvent as ReactPointerEvent } from 'react'
import { cn } from 'cn'

interface Props {
  /** 当前面板尺寸（px）：orientation='x' 时是宽度，'y' 时是高度 */
  width: number
  /** 最小尺寸（px） */
  min: number
  /** 最大尺寸（px） */
  max: number
  onResize: (size: number) => void
  /** 拖拽方向：'x'（默认）竖直条拖宽；'y' 水平条拖高 */
  orientation?: 'x' | 'y'
  /** 面板位于拖拽条右侧（'x'）/ 下方（'y'）时传 true：反向拖动才是增大 */
  invert?: boolean
  /**
   * 拖拽开始 / 结束。
   * 典型用途：面板宽度平时带过渡动画（展开/收起），拖动时要临时关掉 —— 否则外层动画
   * 追不上内层的即时宽度，拖动过程里会露出空白，松手后才慢慢补上。
   */
  onDragStart?: () => void
  onDragEnd?: () => void
  className?: string
}

/**
 * 拖拽条：拖动改变相邻面板的宽度（orientation='x'）或高度（orientation='y'）。
 * 视觉上是 1px 分隔线，但用负 margin 扩出更宽的抓取热区，不占额外布局尺寸。
 */
export function ResizeHandle({
  width,
  min,
  max,
  onResize,
  orientation = 'x',
  invert = false,
  onDragStart,
  onDragEnd,
  className
}: Props) {
  const isVertical = orientation === 'y'
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    const startPos = isVertical ? e.clientY : e.clientX
    const startSize = width
    onDragStart?.()

    const move = (ev: PointerEvent) => {
      const delta = ((isVertical ? ev.clientY : ev.clientX) - startPos) * (invert ? -1 : 1)
      onResize(Math.max(min, Math.min(max, startSize + delta)))
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      onDragEnd?.()
    }
    document.body.style.cursor = isVertical ? 'row-resize' : 'col-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  return (
    <div
      onPointerDown={onPointerDown}
      title={isVertical ? '拖动调整高度' : '拖动调整宽度'}
      className={cn(
        'group/resize relative z-10 shrink-0',
        isVertical ? '-my-1 h-2 cursor-row-resize' : '-mx-1 w-2 cursor-col-resize',
        className
      )}
    >
      {/* 指示线默认透明（不指向就不显示），悬浮/拖动时才亮起 */}
      <div
        className={cn(
          'absolute bg-transparent transition-colors group-hover/resize:bg-primary group-active/resize:bg-primary',
          isVertical
            ? 'inset-x-0 top-1/2 h-px -translate-y-1/2'
            : 'inset-y-0 left-1/2 w-px -translate-x-1/2'
        )}
      />
    </div>
  )
}
