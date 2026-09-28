import { useMemo, useRef, useState } from 'react'
import { useDrop } from 'react-dnd'
import { cn } from 'cn'

/**
 * 侧栏「分组行 / 资源行」的 react-dnd 通用套件
 * （主机 / 脚本 / 笔记 / 接口 / 自动化共用）。
 *
 * 这套东西原先在 5 个面板里各抄了一份，抽出来后各行只关心两件事：
 * 自己的拖拽类型（itemType / groupType）与落点语义（canDrop / drop）。
 */

/** 拖拽载荷：资源与分组两种类型都只需要被拖对象的 id */
export interface RowDragItem {
  id: string
}

/**
 * react-dnd 的连接器签名是 `(node) => ReactElement | null`，与 React 的 ref 回调
 * （返回 void 或清理函数）不兼容，这里显式转成 ref 回调。
 * 必须配合 useMemo 使用：每次渲染新建 ref 会导致 React 卸载/重挂节点，拖拽中途断链。
 */
export function asRef<T extends HTMLElement>(connect: unknown) {
  return (node: T | null): void => {
    ;(connect as (el: T | null) => void)(node)
  }
}

/** 同一个节点既要拖拽又要接掉落：合并两个 ref 回调 */
export function mergeRefs<T extends HTMLElement>(
  a: (node: T | null) => void,
  b: (node: T | null) => void
) {
  return (node: T | null): void => {
    a(node)
    b(node)
  }
}

/**
 * 行的落点：接受「资源」与「分组」两种拖拽。
 * 用指针落在行的上/下半区判定插入位置（after），行边缘画一条插入指示线。
 */
export function useRowDrop<T extends HTMLElement>(opts: {
  /** 资源（连接 / 笔记 / 请求 / 脚本）的 react-dnd 类型 */
  itemType: string
  /** 分组的 react-dnd 类型 */
  groupType: string
  /** 拖的是资源时固定视为「追加到末尾」（拖到分组标题上 = 放进组尾） */
  appendWhenItemDrag?: boolean
  canDrop?: (item: RowDragItem, type: string) => boolean
  drop: (item: RowDragItem, type: string, after: boolean) => void
}) {
  const { itemType, groupType, appendWhenItemDrag, canDrop, drop } = opts
  const nodeRef = useRef<T | null>(null)
  /** 落点在上半区还是下半区：drop 时读取（不放进 deps，避免拖拽中反复重建 spec） */
  const afterRef = useRef(false)
  const [after, setAfter] = useState(false)

  const [{ over }, connectDrop] = useDrop<RowDragItem, void, { over: boolean }>(
    () => ({
      accept: [itemType, groupType],
      canDrop: (item, monitor) => (canDrop ? canDrop(item, String(monitor.getItemType())) : true),
      hover: (_item, monitor) => {
        const node = nodeRef.current
        const offset = monitor.getClientOffset()
        if (!node || !offset) return
        const rect = node.getBoundingClientRect()
        const next =
          appendWhenItemDrag && String(monitor.getItemType()) === itemType
            ? true
            : offset.y > rect.top + rect.height / 2
        afterRef.current = next
        setAfter(next)
      },
      drop: (item, monitor) => drop(item, String(monitor.getItemType()), afterRef.current),
      collect: (m) => ({ over: m.isOver() && m.canDrop() })
    }),
    [itemType, groupType, appendWhenItemDrag, canDrop, drop]
  )

  const ref = useMemo(
    () => (node: T | null) => {
      nodeRef.current = node
      ;(connectDrop as (el: T | null) => void)(node)
    },
    [connectDrop]
  )

  return { ref, over, after }
}

/** 插入指示线（行内绝对定位，配合行的 relative） */
export function DropLine({ after }: { after: boolean }) {
  return (
    <span
      className={cn(
        'pointer-events-none absolute inset-x-0 h-0.5 rounded bg-primary',
        after ? '-bottom-px' : '-top-px'
      )}
    />
  )
}
