"use client";

/**
 * 会话面板标签的拖拽契约（类型 / item 形状 / 落区判定）。
 *
 * ## 为什么统一走 `DndProvider` 而不自己造 context
 *
 * `react-dnd` 的 `DndProvider` 用 `context`（`BackendContext`）做**跨实例单例**：
 * 多传同一个 `context` 的所有 provider 会共享一个 `DragDropManager`，第二个起的
 * provider 复用第一个建的 manager，第一个卸载时还会把它清掉。也就是说「全应用一个
 * manager」这件事**由 `DndProvider` 自己保证**，不需要我们手工提一个 manager 上去。
 *
 * 所以这里只约定：面板里的拖拽源 / 放置目标统一用 `PANEL_TAB_TYPE`，
 * 与 `ChatPanel`（队列 / 插话排序）的 type 区分开 —— 一个 manager 上靠 type 隔离。
 *
 * ## HTML5 后端的取舍
 *
 * 用原生 drag & drop（HTML5）而不是 touch 后端：面板拖拽是桌面端场景，HTML5 能白拿
 * 原生拖拽预览与 `dropEffect` 光标反馈。触摸端不依赖拖拽 —— 标签右键菜单里有「移动 /
 * 分离」的显式动作（与 `ChatPanel` 的 `SortableRow` 触屏隐藏把手改用 ↑↓ 按钮同一取舍）。
 * 原生拖拽的另一面：`dragover` 里必须 `preventDefault()` 才会触发 `drop`（`useDrop`
 * 已经代劳），且 `dragstart` 必须落在一个**可拖**元素上。
 *
 * ## 落区模型（照搬上级 dogi 的 `PanelView.tsx`）
 *
 * 拖拽有两层落点，语义不同：
 * - **标签条上**：按指针在**目标标签**上的水平相对位置分三档（`before`/`inside`/`after`）——
 *   两侧各 25% 是插入到该标签前 / 后，中间 50% 是并入该标签所属的组。
 * - **内容区（组车身）**：按指针在**整个组矩形**里的相对位置分五档（四边各 1/4 = 分屏方向，
 *   中间 = 并入该组）。`EDGE_RATIO = 0.25`，`center` 之外都触发分屏。
 */
import { useCallback, useRef } from 'react'
import type { DropTargetMonitor, XYCoord } from 'react-dnd'
import type { SplitDirectionInput } from '@fizz/agent-kit/shared/lib/pane-layout'

/**
 * 面板标签拖拽的 item 类型。
 *
 * 与 `ChatPanel` 的 `QUEUE_ITEM_TYPE` / `STEER_ITEM_TYPE` **必须不同**：三者共用
 * 一个 manager，`accept` 只认自己那个 type，跨类型互不响应。
 */
export const PANEL_TAB_TYPE = 'fizz/panel-tab'

/** 一次面板标签拖拽携带的数据 */
export interface PanelTabDragItem {
  /** 被拖的标签 key */
  key: string
  /** 拖起时该标签所在的组 id（落点据此判「同组 = 重排、异组 = 移动」） */
  fromGroupId: string
  /**
   * 拖的是**整个组**时才有：该组的 id。
   *
   * 拖起整组的来源是标签条容器本身（按在标签之间的空白处拖，见 `PanelView` 里
   * `groupDragRef` 的注释）；落点处理就按「整组搬家」走，而不是把组里第一个标签单独
   * 挪走。此时 `key` 取组内第一个标签（只为占位，落点不看它）。
   */
  groupId?: string
}

/** 标签条上的落区（按目标标签的水平相对位置三档切） */
export type TabDropZone = 'before' | 'inside' | 'after'

/** 内容区（组车身）的落区：四边 = 分屏方向，`center` = 并入该组 */
export type GroupDropZone = SplitDirectionInput | 'center'

/** 判定「落在组边缘」的比例：各边内侧 1/4 视为分屏区（与 dogi 一致） */
export const EDGE_RATIO = 0.25

/** 指针在某个元素上的水平相对位置（0 = 左边缘，1 = 右边缘） */
export function horizontalRatio(monitor: DropTargetMonitor, el: HTMLElement | null): number {
  if (!el) return 0.5
  const offset = monitor.getClientOffset() as XYCoord | null
  if (!offset) return 0.5
  const rect = el.getBoundingClientRect()
  if (rect.width <= 0) return 0.5
  return (offset.x - rect.left) / rect.width
}

/** 由水平相对位置得到落点区域（见 `TabDropZone` 的三段划分） */
export function zoneOf(ratio: number): TabDropZone {
  if (ratio < 0.25) return 'before'
  if (ratio > 0.75) return 'after'
  return 'inside'
}

/**
 * 根据指针在**组矩形**里的位置判定落区（与 dogi `PanelView.zoneOf` 同一算法）。
 *
 * 取「到四边最近的距离」里最小的那条边，若它还在 1/4 以内就归那一侧，否则归 `center`。
 * 例如指针贴在左边 = `left`（向左分屏）、正中间 = `center`（并入本组）。
 */
export function groupZoneOf(rect: DOMRect, x: number, y: number): GroupDropZone {
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

/**
 * 把 react-dnd 的连接器 + 自定义逻辑合成一个 ref 回调。
 *
 * ## 为什么不能「永久稳定」（这里踩过两次坑）
 *
 * react-dnd 的连接器签名是 `(node) => ReactElement | null`，与 React 的 ref 回调不兼容，
 * 所以要包一层箭头函数。包法有两个坑，方向正好相反：
 *
 * **坑一：裸箭头函数（每次渲染都是新函数）。** React 于是每次渲染都先以 `null` 调旧 ref、
 * 再以节点调新 ref —— 连接器被反复 `disconnect` / `reconnect`，注册状态一变就触发
 * `collect` → `setCollected` → 重渲染 → 又一个新 ref，形成**无限更新循环**
 * （React 报 `Maximum update depth exceeded`）。
 *
 * **坑二：`useCallback(…, [])` 钉死成永久稳定。** 这一版曾经用过，代价更隐蔽：
 * React 只在 ref **身份变化**时才会重调它，身份永不变 ⇒ 节点一辈子只连一次。
 * 而连接器是跟着 `manager` 走的（`useDropTargetConnector` 的 `useMemo(…, [manager])`），
 * **manager 一旦被换掉（见 `app-shell.tsx` 里 `DND_CONTEXT` 的注释：StrictMode 会让
 * 单例槽归零、之后重渲染再造一个），旧后端挂在节点上的监听器就再也没人摘、新连接器也
 * 没人接上**。症状极具迷惑性：`dragenter` 照常冒泡到节点、监听器照常执行，但它把
 * targetId 推进的是**那个已废弃后端**的数组，而顶层 `handleTopDragEnter` 读的是新后端的
 * 空数组 —— 于是「有 dragstart、有 dragenter，却永远没有 hover / canDrop / drop」。
 *
 * 正解：**依赖连接器本身**（`[connect]`）。连接器由 react-dnd 按 manager 记忆化、引用稳定，
 * 所以正常情况下身份不变、只连一次（不会触发坑一）；一旦连接器真的换了，React 会先以
 * `null` 调旧 ref（连接器自己会把旧监听器摘干净）再以节点调新 ref —— 正好是我们需要的迁移。
 *
 * `extra` 里的附加逻辑每次渲染都是新数组 / 新函数，**不能进依赖**，放进 ref 里取最新。
 */
export function useDndRef<T extends HTMLElement>(
  connect: unknown,
  ...extra: Array<(node: T | null) => void>
): (node: T | null) => void {
  const extraRef = useRef(extra)
  extraRef.current = extra
  return useCallback(
    (node: T | null) => {
      ;(connect as (el: T | null) => void)(node)
      for (const fn of extraRef.current) fn(node)
    },
    [connect]
  )
}
