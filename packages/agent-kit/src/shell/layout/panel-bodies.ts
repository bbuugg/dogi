"use client";

/**
 * 主区域「面板车身」元素的登记表：`groupId → 该组内容区的 DOM 元素`。
 *
 * ## 为什么需要它
 *
 * 标签内容**不能**由 `PanelGroupView` 自己渲染。那样内容的 React 父节点就是「组」，
 * 而标签一旦换组（拖到别的组 / 被「向右拆分」拎到新的一格），父节点就变了 ——
 * React 卸载重挂，`TerminalPanel` 的 cleanup 会把那条 PTY kill 掉、xterm 连同
 * scrollback 一起没（用户看到的：拆一下终端，输出全清空）。
 *
 * 所以内容统一在 `PanelView` 根部渲染**一次**（`PanelContentLayer`），再按「各组车身的
 * 矩形」摆到对应位置。本文件是两者之间的桥：组把车身元素登记进来，内容层订阅它、量矩形。
 *
 * ## ⚠️ 为什么不是 `createPortal(内容, 车身)` —— 那条路是走不通的
 *
 * React 19 的 `updatePortal`（`react-dom-client`）里有一句判定：
 *
 * ```js
 * if (current === null || 4 !== current.tag ||
 *     current.stateNode.containerInfo !== portal.containerInfo ||   // ← 容器变了
 *     current.stateNode.implementation !== portal.implementation) {
 *   current = createFiberFromPortal(portal, ...)   // ← 新建 fiber = 整棵子树重挂
 * }
 * ```
 *
 * 也就是说 **portal 的容器一变，React 就当新节点重建**。标签从 A 组移到 B 组时容器
 * 正是要变（A 的车身 → B 的车身），于是 portal 版和想修掉的 bug 表现一模一样，只是
 * 更隐蔽。参考实现 dogi 走的是另一条路：接受重挂，再靠「主进程环形缓冲回放」把输出
 * 补回来（`TerminalView.tsx` 里 `REPLAY_MAX_CHARS` 那一段注释写得很清楚）。这里选了
 * 第三条：**干脆不让内容换父节点**，用测出来的矩形把它摆到目标组的车身上。
 *
 * ## 只活在内存里
 *
 * 车身元素是 DOM，随组件挂载 / 卸载自然来去；这里不落盘、也不做任何持久化。
 */

const bodies = new Map<string, HTMLElement>()

const listeners = new Set<() => void>()

/** 车身**集合**的版本号：只有「某个组的车身换了 / 来了 / 走了」时才 +1 */
let version = 0

function emit(): void {
  version++
  for (const listener of listeners) listener()
}

/**
 * 登记（或注销）一个组的车身元素。
 *
 * 直接当 ref 回调传给车身 div 用（`registerPanelBody(groupId, node)`）：React 在卸载时
 * 会以 `null` 调它，正好是注销。同一个 `groupId` 重复登记**同一个元素**是空操作 ——
 * 否则每次渲染都会 +1 版本号，把内容层的 ResizeObserver 白重挂一遍。
 */
export function registerPanelBody(groupId: string, el: HTMLElement | null): void {
  const prev = bodies.get(groupId)
  if (el) {
    if (prev === el) return
    bodies.set(groupId, el)
  } else {
    if (prev === undefined) return
    bodies.delete(groupId)
  }
  emit()
}

export function subscribePanelBodies(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * `useSyncExternalStore` 的 snapshot：**集合**的版本号。
 *
 * 内容层还需要「集合变了就重挂 ResizeObserver」这个时机，而 `panelBodies()` 每次返回
 * 同一个 Map 实例（引用不变），不能直接当 snapshot（React 会认为没变）。所以单独维护
 * 一个自增的版本号。
 */
export function panelBodiesVersion(): number {
  return version
}

/** 当前所有已登记的车身（内容层遍历它量矩形） */
export function panelBodies(): Map<string, HTMLElement> {
  return bodies
}
