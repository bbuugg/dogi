"use client";

import {
  Fragment,
  useRef,
  type ReactNode,
} from 'react'
import { cn } from '@fizz/agent-kit/shared/lib/utils'
import { type PaneNode } from '@fizz/agent-kit/shared/lib/pane-layout'
import { Splitter } from './Splitter'
import { PanelGroupView } from './PanelGroupView'

/**
 * 布局树递归。
 *
 * ## ⚠️ 叶子与分隔节点必须渲染**同构**结构（否则拆分会把整组终端拆没）
 *
 * 一个叶子和一个分隔节点，渲染出来都是「同一个外层 flex 容器 + 若干个
 * `Fragment key=<子节点 id>`」，**区别只在 children 是 `[自己]` 还是 `node.children`**：
 *
 * ```text
 * 叶子 A          →  <div class="flex flex-col">
 *                      <Fragment key=A><div>{PanelGroupView A}</div></Fragment>
 *                    </div>
 * A 拆出 B 之后    →  <div class="flex flex-row">
 *                      <Fragment key=A><div>{PanelGroupView A}</div></Fragment>
 *                      <Fragment key=B><div>{PanelGroupView B}</div></Fragment>
 *                    </div>
 * ```
 *
 * 这样 React 在结构切换时能**按 key 命中原有子树**（外层 div 类型不变 → 就地更新；
 * `Fragment key=A` 命中 → 里面的 `PanelGroupView A` 同类型同 props → **复用实例，不卸载**）。
 * 于是 A 组里的终端、xterm 滚动缓冲、正在跑的程序全都留着 —— 拆分只影响被搬走的那一个标签。
 *
 * 反面教材（本次修掉的写法）：叶子直接 `return <PanelGroupView/>`、分隔节点才包一层 `div`。
 * 那样 leaf → split 时，根元素类型从 `PanelGroupView` 变成 `div`，React **整棵子树卸载重建**
 * ⇒ 组里每一条终端都被 kill 掉、输出清空（`TerminalPanel` 的 cleanup 会杀 PTY）。
 *
 * 还有一条同样致命、但不显眼的约束：**内容 div 必须排在 `Splitter` 前面**。
 * Fragment 内部的子节点是按**位置**（无 key）对账的 —— 把 Splitter 写在前面的话，
 * 一个孩子从「末位」变成「非末位」时，位置 0 会从内容 div 变成 Splitter（类型不同）
 * ⇒ 内容照样被卸载。内容 div 固定在位置 0，才是真的稳。
 *
 * （参考实现 dogi 的 `PaneTree` 就是这么写的，注释里明说「leaf → split 结构切换时
 * React 按 key 命中原有子树，既有组/终端不会卸载」。）
 */
export function PaneNodeView({ node }: { node: PaneNode }): ReactNode {
  const containerRef = useRef<HTMLDivElement | null>(null)

  const split = node.type === 'split' ? node : null
  const children: PaneNode[] = split ? split.children : [node]

  return (
    <div
      ref={containerRef}
      className={cn(
        'flex min-h-0 min-w-0 flex-1 overflow-hidden',
        split && split.direction === 'row' ? 'flex-row' : 'flex-col'
      )}
    >
      {children.map((child, i) => (
        <Fragment key={child.id}>
          {/* 内容 div 恒在位置 0（见上面第 3 段注释：位置一变，React 就会重建内容） */}
          {/*
            权重直接当 `flex-grow` 用 ⇒ **必须由 `pane-layout` 保证总和为 1**
            （`normalizeSizes`）。flexbox 对「flex-grow 之和 < 1」只分配
            「剩余空间 × 总和」，剩下的会空出来透出容器底色 —— 这正是「关掉最右栏后
            右边一片灰、左边内容也不变宽」那个 bug 的成因，别在这里再改回裸比例。
          */}
          <div
            style={{ flexGrow: split ? (split.sizes[i] ?? 1) : 1, flexBasis: 0 }}
            className="flex min-h-0 min-w-0"
          >
            {child.type === 'leaf' ? (
              <PanelGroupView groupId={child.groupId} />
            ) : (
              <PaneNodeView node={child} />
            )}
          </div>
          {/* 分隔条排在内容**后面**：`index` 的语义仍是「children[index] 与 [index+1] 之间」 */}
          {split && i < children.length - 1 && (
            <Splitter split={split} index={i} containerRef={containerRef} />
          )}
        </Fragment>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// 根
// ---------------------------------------------------------------------------
