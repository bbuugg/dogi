"use client";

/**
 * 分组树列表的**拖拽落点**公共件：接口请求树、脚本分组树、主机 / 终端分组树
 * 三处侧栏的「行」用的是同一套落点逻辑，所以抽在这里一份。
 *
 * 三处的树模型（同目录的 `group-tree`）本来就共用，
 * 落点再各写一份的话，「拖动时判定上半还是下半」这种边界改一处就得记着改三处。
 *
 * ## 约定
 *
 * - 载荷只带 `id`（`DragItem`）：落点按 id 在**完整块结构**里定位，行本身不搬数据；
 * - 行内动作（删除 / 重命名…）一律 `stopPropagation`，别让拖拽起点吃掉点击。
 */
import { useCallback, useRef, useState } from 'react'
import { useDrop } from 'react-dnd'
import { useDndRef } from '@fizz/agent-kit/shared/lib/dnd-context'
import { cn } from '@fizz/agent-kit/shared/lib/utils'

/** 拖拽载荷：只带 id（落点按 id 在完整块结构里定位） */
export interface DragItem {
  id: string
}

/**
 * 行拖放落点：返回合并了「放置连接器 + 元素 ref（+ 可选拖动连接器）」的 ref，
 * 以及「是否悬停在可放置位置」「落在行的下半（insert-after）还是上半（insert-before）」。
 *
 * ⚠️ `useDrop` 必须用**工厂函数 + deps 数组**形式（照 `PanelView` 的范式）：
 * 直接传字面量会因 handlerId 漂移而永远不触发 hover / drop。回调放进 ref 里取最新。
 */
export function useRowDrop<T extends HTMLElement>(
  itemType: string,
  groupType: string,
  canDrop: (item: DragItem, type: string) => boolean,
  drop: (item: DragItem, type: string, after: boolean) => void,
  dragConnect?: unknown
): { ref: (node: T | null) => void; over: boolean; after: boolean } {
  const cfg = useRef({ canDrop, drop })
  cfg.current = { canDrop, drop }
  const elRef = useRef<T | null>(null)
  const afterRef = useRef(false)
  const [after, setAfter] = useState(false)

  const [{ isOver }, connect] = useDrop<DragItem, void, { isOver: boolean }>(
    () => ({
      accept: [itemType, groupType],
      canDrop: (item, monitor) => cfg.current.canDrop(item, monitor.getItemType() as string),
      hover: (_item, monitor) => {
        const el = elRef.current
        const off = monitor.getClientOffset()
        if (!el || !off) return
        const rect = el.getBoundingClientRect()
        const next = off.y > rect.top + rect.height / 2
        afterRef.current = next
        setAfter(next)
      },
      drop: (item, monitor) => {
        cfg.current.drop(item, monitor.getItemType() as string, afterRef.current)
      },
      collect: (m) => ({ isOver: m.isOver() && m.canDrop() })
    }),
    []
  )

  const setEl = useCallback((node: T | null) => {
    elRef.current = node
  }, [])
  const extras: Array<(node: T | null) => void> = [setEl]
  if (dragConnect) {
    extras.push((node) => {
      ;(dragConnect as (n: T | null) => void)(node)
    })
  }
  const ref = useDndRef<T>(connect, ...extras)
  return { ref, over: isOver, after }
}

/** 拖拽落点指示线（行内绝对定位，顶边或底边） */
export function DropLine({ after }: { after: boolean }) {
  return (
    <div
      className={cn(
        'pointer-events-none absolute inset-x-0.5 z-10 h-0.5 rounded bg-primary',
        after ? 'bottom-0' : 'top-0'
      )}
    />
  )
}
