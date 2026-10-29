"use client";

import { cn } from '@fizz/agent-kit/shared/lib/utils'
import { useDragResize } from '@fizz/agent-kit/shared/components/ResizeHandle'
import { type PaneSplit } from '@fizz/agent-kit/shared/lib/pane-layout'
import { resizeSplit } from '@fizz/agent-kit/shared/lib/panel-store'

/**
 * 拖动分隔条改权重。
 *
 * ⚠️ `sizes` 会被**直接当 `flex-grow` 用**，所以总和必须保持 1（`pane-layout.ts` 的
 * `normalizeSizes` 负责兜住）：flexbox 在「flex-grow 之和 < 1」时只分配
 * 「剩余空间 × 总和」，会空出一截、露出容器底色。这里的增量按当前总和换算，
 * 写回时再由 `resizeSplit` → `normalizeSizes` 归一到 1。
 */
export function Splitter({
  split,
  index,
  containerRef
}: {
  split: PaneSplit
  /** 边界位于 `children[index]` 与 `children[index + 1]` 之间 */
  index: number
  containerRef: React.RefObject<HTMLDivElement | null>
}) {
  const horizontal = split.direction === 'row'

  /** 指针管线走 `useDragResize`（`touch-action` + 幂等收尾，见该 hook 的文件头） */
  const onPointerDown = useDragResize<{
    total: number
    totalWeight: number
    startSizes: number[]
    minWeight: number
  }>({
    axis: horizontal ? 'x' : 'y',
    onStart: () => {
      const container = containerRef.current
      if (!container) return null
      const rect = container.getBoundingClientRect()
      const total = horizontal ? rect.width : rect.height
      if (total <= 0) return null
      const totalWeight = split.sizes.reduce((a, b) => a + b, 0) || 1
      return {
        total,
        totalWeight,
        startSizes: [...split.sizes],
        /** 每一侧最少留 6% —— 别让用户把某一格拖到看不见（看不见就再也拖不回来） */
        minWeight: totalWeight * 0.06
      }
    },
    onMove: (delta, drag) => {
      const deltaWeight = (delta / drag.total) * drag.totalWeight
      const a = drag.startSizes[index] + deltaWeight
      const b = drag.startSizes[index + 1] - deltaWeight
      if (a < drag.minWeight || b < drag.minWeight) return
      const next = [...drag.startSizes]
      next[index] = a
      next[index + 1] = b
      resizeSplit(split.id, next)
    }
  })

  return (
    <div
      role="separator"
      aria-orientation={horizontal ? 'vertical' : 'horizontal'}
      onPointerDown={onPointerDown}
      className={cn(
        /*
         * 命中热区 8px（窄屏 16px），但用 -mx-* / -my-* 的负 margin 把**占位抵成 0** —— 两侧面板
         * 直接相邻，缝里只剩下面那一条 1px 的线（与 dogi 的 ViewPanel 同一套做法）。
         *
         * ⚠️ 负 margin 不能省：以前这里是裸的 `w-1`，那 4px 是**实打实占位**的。未激活组用
         * `bg-background/60`，容器底色从这 4px 里透出来，看起来就是「一道缝 + 一条线」。
         *
         * ⚠️ `touch-none` 也不能省：少了它手机上手指一动就被浏览器当成滚动手势抢走
         * （`pointercancel`），表现是「一次只能拖一点点」。
         */
        'group/split relative z-10 shrink-0 touch-none select-none [-webkit-touch-callout:none]',
        horizontal
          ? '-mx-2 w-4 cursor-col-resize sm:-mx-1 sm:w-2'
          : '-my-2 h-4 cursor-row-resize sm:-my-1 sm:h-2'
      )}
    >
      <div
        className={cn(
          'absolute bg-border transition-colors group-hover/split:bg-primary/60',
          horizontal
            ? 'inset-y-0 left-1/2 w-px -translate-x-1/2'
            : 'inset-x-0 top-1/2 h-px -translate-y-1/2'
        )}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// 标签条上的一个标签
// ---------------------------------------------------------------------------
