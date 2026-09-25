import { type PointerEvent as ReactPointerEvent } from 'react'
import { cn } from 'cn'

interface Props {
  /** 当前面板宽度（px） */
  width: number
  /** 最小宽度（px） */
  min: number
  /** 最大宽度（px） */
  max: number
  onResize: (width: number) => void
  /** 面板位于拖拽条右侧时传 true：向左拖动才是增大宽度 */
  invert?: boolean
  className?: string
}

/**
 * 竖直拖拽条：拖动改变相邻面板宽度。
 * 视觉上是 1px 分隔线，但用 -mx 扩出更宽的抓取热区，不占额外布局宽度。
 */
export function ResizeHandle({ width, min, max, onResize, invert = false, className }: Props) {
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    const startX = e.clientX
    const startWidth = width

    const move = (ev: PointerEvent) => {
      const delta = (ev.clientX - startX) * (invert ? -1 : 1)
      onResize(Math.max(min, Math.min(max, startWidth + delta)))
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  return (
    <div
      onPointerDown={onPointerDown}
      title="拖动调整宽度"
      className={cn(
        'group/resize relative z-10 -mx-1 w-2 shrink-0 cursor-col-resize',
        className
      )}
    >
      {/* 指示线默认透明（不指向就不显示），悬浮/拖动时才亮起 */}
      <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-transparent transition-colors group-hover/resize:bg-primary group-active/resize:bg-primary" />
    </div>
  )
}
