/**
 * 终端分屏布局的纯函数与类型。
 *
 * 模型：一棵面板树（PaneNode）。叶子（leaf）承载一个「编辑器组」（groupId），
 * 组内含多个会话（标签页）；分隔节点（split）按方向排列多个子节点，
 * 方向 row=左右并排、col=上下堆叠。sizes 为各子节点的弹性权重（flex-grow），
 * 只取相对比例，无需归一化。
 *
 * 这与 VS Code 的「编辑器拆分」语义一致：向某个组的上/下/左/右拆分，
 * 会新建一个组并排放在其旁（必要时自动套一层同方向的分隔节点）。
 */

/** 拆分方向（相对当前组） */
export type SplitDirectionInput = 'up' | 'down' | 'left' | 'right'
/** 布局中分隔节点的排列方向 */
export type SplitDirection = 'row' | 'col'

export interface PaneLeaf {
  id: string
  type: 'leaf'
  groupId: string
}

export interface PaneSplit {
  id: string
  type: 'split'
  direction: SplitDirection
  /** 与各 child 一一对应的弹性权重，相对比例即可 */
  sizes: number[]
  children: PaneNode[]
}

export type PaneNode = PaneLeaf | PaneSplit

export function genPaneId(): string {
  return `pane-${crypto.randomUUID()}`
}

/** 由组 ID 生成叶子节点 */
export function makeLeaf(groupId: string): PaneLeaf {
  return { id: genPaneId(), type: 'leaf', groupId }
}

/** 拆分方向 -> 布局排列方向：左右为 row，上下为 col */
function directionToSplit(d: SplitDirectionInput): SplitDirection {
  return d === 'left' || d === 'right' ? 'row' : 'col'
}

/** 新组应放在原组之前（左/上）还是之后（右/下） */
function isBefore(d: SplitDirectionInput): boolean {
  return d === 'left' || d === 'up'
}

function childContainsGroup(node: PaneNode, groupId: string): boolean {
  if (node.type === 'leaf') return node.groupId === groupId
  return node.children.some((c) => childContainsGroup(c, groupId))
}

function indexOfChildWithGroup(node: PaneSplit, groupId: string): number {
  return node.children.findIndex((c) => childContainsGroup(c, groupId))
}

/** 在已有分隔节点的 sizes 中，把 source 槽位一分为二，为新插入的兄弟留出等宽 */
function splitSize(sizes: number[], idx: number, before: boolean): number[] {
  const n = sizes.length || 1
  const total = sizes.reduce((a, b) => a + b, 0) || n
  const cur = sizes[idx] ?? total / n
  const half = cur / 2
  const next = sizes.map((s, i) => (i === idx ? half : s))
  next.splice(before ? idx : idx + 1, 0, half)
  return next
}

/**
 * 围绕 sourceGroupId 对应叶子，按 direction 在其旁插入 newLeaf（承载新组）。
 * 若其直接父分隔节点方向一致，则直接作为兄弟插入（保证同方向相邻）；
 * 否则把该叶子（或其所在子分隔）包进一个新的同方向分隔节点。
 */
export function insertSibling(
  layout: PaneNode,
  sourceGroupId: string,
  direction: SplitDirectionInput,
  newLeaf: PaneLeaf
): PaneNode {
  const splitDir = directionToSplit(direction)
  const before = isBefore(direction)

  // 根就是目标叶子：直接包一层分隔节点
  if (layout.type === 'leaf') {
    if (layout.groupId !== sourceGroupId) return layout
    const children = before ? [newLeaf, layout] : [layout, newLeaf]
    return { id: genPaneId(), type: 'split', direction: splitDir, sizes: [0.5, 0.5], children }
  }

  // 遍历直接子节点，定位包含目标组的那个
  for (let i = 0; i < layout.children.length; i++) {
    const child = layout.children[i]
    if (!childContainsGroup(child, sourceGroupId)) continue

    if (child.type === 'leaf') {
      const wrapped: PaneSplit = {
        id: genPaneId(),
        type: 'split',
        direction: splitDir,
        sizes: [0.5, 0.5],
        children: before ? [newLeaf, child] : [child, newLeaf]
      }
      const children = [...layout.children]
      children[i] = wrapped
      return { ...layout, children }
    }

    // child 也是分隔节点
    if (child.direction === splitDir) {
      const idx = indexOfChildWithGroup(child, sourceGroupId)
      const newChildren = [...child.children]
      newChildren.splice(before ? idx : idx + 1, 0, newLeaf)
      const updated: PaneSplit = {
        ...child,
        children: newChildren,
        sizes: splitSize(child.sizes, idx, before)
      }
      const children = [...layout.children]
      children[i] = updated
      return { ...layout, children }
    }

    // 方向不同：把 child 整体包进一层同方向分隔
    const wrapped: PaneSplit = {
      id: genPaneId(),
      type: 'split',
      direction: splitDir,
      sizes: [0.5, 0.5],
      children: before ? [newLeaf, child] : [child, newLeaf]
    }
    const children = [...layout.children]
    children[i] = wrapped
    return { ...layout, children }
  }

  return layout
}

/** 删除承载 groupId 的叶子，并折叠仅剩单子节点的分隔节点 */
export function removeLeaf(layout: PaneNode | null, groupId: string): PaneNode | null {
  if (!layout) return null
  if (layout.type === 'leaf') {
    return layout.groupId === groupId ? null : layout
  }
  const children = layout.children
    .map((c) => removeLeaf(c, groupId))
    .filter((c): c is PaneNode => c !== null)
  if (children.length === 0) return null
  if (children.length === 1) return children[0]
  const sizes =
    layout.sizes.length === children.length
      ? layout.sizes
      : children.map(() => 1 / children.length)
  return { ...layout, children, sizes }
}

/** 收集布局中所有组 ID */
export function collectGroupIds(layout: PaneNode | null): string[] {
  if (!layout) return []
  if (layout.type === 'leaf') return [layout.groupId]
  return layout.children.flatMap((c) => collectGroupIds(c))
}

/** 取布局中第一个叶子对应的组 ID（关闭当前组后作为新的焦点候选） */
export function firstGroupId(layout: PaneNode | null): string | null {
  if (!layout) return null
  if (layout.type === 'leaf') return layout.groupId
  for (const c of layout.children) {
    const id = firstGroupId(c)
    if (id) return id
  }
  return null
}

/** 找到承载 groupId 的叶子（用于聚焦） */
export function findLeafByGroup(
  layout: PaneNode | null,
  groupId: string
): PaneLeaf | null {
  if (!layout) return null
  if (layout.type === 'leaf') return layout.groupId === groupId ? layout : null
  for (const c of layout.children) {
    const found = findLeafByGroup(c, groupId)
    if (found) return found
  }
  return null
}

/** 更新指定分隔节点的 sizes 权重 */
export function updateSizes(
  layout: PaneNode,
  splitId: string,
  sizes: number[]
): PaneNode {
  if (layout.type === 'leaf') return layout
  if (layout.id === splitId) return { ...layout, sizes }
  return {
    ...layout,
    children: layout.children.map((c) => updateSizes(c, splitId, sizes))
  }
}
