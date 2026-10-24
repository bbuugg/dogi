/**
 * 右侧面板的**分屏布局树**（纯函数、零 React / 零 DOM）。
 *
 * ## 模型（与上级 dogi 的 `app/layout/pane-layout.ts` 一致）
 *
 * 一棵 `PaneNode` 树：
 * - **叶子**（`PaneLeaf`）代表一个「面板组」，它**只记住自己的 `groupId`**：
 *   `{ id, type: 'leaf', groupId }`。组里有哪些标签、当前显示哪一个，**不在这棵树里**
 *   —— 它们存在「组」上（见 `PanelGroup`）。这是本模型与旧实现最本质的区别：
 *   树是**纯骨架**，只回答「哪一块在哪」，不回答「哪一块里有谁」。
 * - **分隔节点**（`PaneSplit`）按 `direction` 排列**任意多个**子节点：
 *   `row` = 左右并排、`col` = 上下堆叠；`sizes` 是与子节点一一对应的**弹性权重**
 *   （flex-grow）。⚠️ 权重**总和恒为 1**，不是「随便什么比例都行」—— 原因见
 *   `normalizeSizes`：flexbox 对「flex-grow 之和 < 1」有一套单独的分配规则。
 *
 * 与 VS Code 的「编辑器拆分」语义一致：向某个组的上/下/左/右拆分，会在它旁边新建一格
 * （必要时自动套一层同方向的分隔节点，见 `insertSibling`）。
 *
 * ## 为什么树里不含标签（这是被上一版实现坑出来的结论）
 *
 * 上一版把「组内标签数组」塞进叶子（`leaf.inc`），于是每个动作都要同时改树与标签，
 * 逼出一堆记账（`leafId` 命中判定、`splitOff` 单列入口、`verify` 安全网），
 * 还要另做一层内容定位来防止标签换父节点。把标签挪到「组」上之后：
 * - 拖拽载荷里只要带 `groupId`，落点语义就全清楚了（同组 = 重排、异组 = 移动）；
 * - 组的身份是稳定的 `groupId`（`pane-<uuid>`），树重建不会换掉任何一格的 key；
 * - 布局变更全是**这几个纯函数**，组件里不手改树（与 dogi `AGENTS.md` 3.5 同一条纪律）。
 *
 * ## 不变量
 *
 * 1. **叶子不空**：`removeLeaf` 会顺带折叠「只剩一个子节点」的分隔节点，不会留下空壳。
 * 2. **组 id 唯一**：每片叶子的 `groupId` 在整棵树里只出现一次。
 * 3. **sizes 与 children 等长、且总和恒为 1**：任何结构变化后都过一遍 `normalizeSizes`。
 *    「总和为 1」不是洁癖：渲染层把 `sizes` **直接当 `flex-grow` 用**，而 flexbox 规定
 *    **flex-grow 之和小于 1 时只分配「剩余空间 × 这个和」**（CSS Flexbox §9.7.4）——
 *    裁掉一栏后剩下的旧权重（如 `[0.25, 0.25]`，总和 0.5）会让两栏只占一半宽，空出来的
 *    那一整块直接露出容器底色（用户报过「关掉最右栏后右边一片灰、左边内容也不变宽」）。
 */

/** 拆分方向（相对当前组）：左右为 `row`，上下为 `col`。与 dogi 的 `SplitDirectionInput` 同名同义 */
export type SplitDirectionInput = 'up' | 'down' | 'left' | 'right'
/** 分隔节点里子节点的排列方向 */
export type SplitDirection = 'row' | 'col'

export interface PaneLeaf {
  id: string
  type: 'leaf'
  /** 这一格承载的组 id（组里有哪些标签由 `PanelGroup` 决定） */
  groupId: string
}

export interface PaneSplit {
  id: string
  type: 'split'
  direction: SplitDirection
  /**
   * 与各 child 一一对应的弹性权重，**总和恒为 1**（渲染层直接当 `flex-grow` 用）。
   * 任何结构变化后都要过 `normalizeSizes` —— 总和小于 1 会被 flexbox 截掉一部分空间。
   */
  sizes: number[]
  children: PaneNode[]
}

export type PaneNode = PaneLeaf | PaneSplit

/** 生成稳定的节点 id。`crypto.randomUUID` 在浏览器 / Node 18+ 都有；退化时用时间戳兜底 */
export function genPaneId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  return `pane-${c?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`
}

/** 由组 ID 生成叶子节点 */
export function makeLeaf(groupId: string): PaneLeaf {
  return { id: genPaneId(), type: 'leaf', groupId }
}

/** 拆分方向 → 排列方向：左右为 row，上下为 col */
function directionToSplit(d: SplitDirectionInput): SplitDirection {
  return d === 'left' || d === 'right' ? 'row' : 'col'
}

/** 新组应放在原组之前（左 / 上）还是之后（右 / 下） */
function isBefore(d: SplitDirectionInput): boolean {
  return d === 'left' || d === 'up'
}

/**
 * 把 sizes 归一到「与 children 等长」**且总和为 1**（缺失的按均分补），维持不变量 3。
 *
 * ⚠️ 不能只裁到等长就把原数组还回去：`removeLeaf` 摘掉一栏后，留下的旧权重不再满和
 * （三栏 `[0.25, 0.25, 0.5]` 关掉最后一栏 → `[0.25, 0.25]`，总和 0.5）。渲染层把它们
 * 原样当 `flex-grow`，而 flexbox 的规则是「**flex-grow 之和小于 1 时，只分配
 * 「剩余空间 × 这个和」**」（CSS Flexbox §9.7.4）—— 于是剩下的两栏各占 25%、右边空掉
 * 一半，空处透出容器底色：看起来就是「关掉最右栏后右边一片灰，左边内容也不跟着变宽」。
 * 除以总和即可：相对比例不变，和恒为 1。
 */
function normalizeSizes(sizes: number[], count: number): number[] {
  if (count <= 0) return []
  const kept = Array.from({ length: count }, (_, i) => sizes[i] ?? 1)
  const total = kept.reduce((a, b) => a + b, 0)
  // 权重坏掉（全 0 / NaN）时退回均分，别把某一格算成 0 宽（0 宽就再也拖不回来了）
  if (!Number.isFinite(total) || total <= 0) return Array.from({ length: count }, () => 1 / count)
  return kept.map((s) => s / total)
}

function childContainsGroup(node: PaneNode, groupId: string): boolean {
  if (node.type === 'leaf') return node.groupId === groupId
  return node.children.some((c) => childContainsGroup(c, groupId))
}

function indexOfChildWithGroup(node: PaneSplit, groupId: string): number {
  return node.children.findIndex((c) => childContainsGroup(c, groupId))
}

/**
 * 在已有分隔节点的 `sizes` 中，把 `idx` 这一槽位**一分为二**，给新插入的兄弟留出等宽。
 *
 * 同方向拆分时走它（而不是整体重新均分），这样其它兄弟的**相对大小不会跳变** ——
 * 用户在别处调好的比例不该因为一次分屏而被打乱。
 */
function splitSize(sizes: number[], idx: number, before: boolean): number[] {
  const n = sizes.length || 1
  const total = sizes.reduce((a, b) => a + b, 0) || n
  const cur = sizes[idx] ?? total / n
  const half = cur / 2
  const next = sizes.map((s, i) => (i === idx ? half : s))
  next.splice(before ? idx : idx + 1, 0, half)
  return next
}

/** 包一层新的同方向分隔节点，把 `target` 与新组并排放在里面 */
function wrapWith(target: PaneNode, newLeaf: PaneLeaf, splitDir: SplitDirection, before: boolean): PaneSplit {
  return {
    id: genPaneId(),
    type: 'split',
    direction: splitDir,
    sizes: [0.5, 0.5],
    children: before ? [newLeaf, target] : [target, newLeaf]
  }
}

/**
 * 围绕 `sourceGroupId` 对应的叶子，按 `direction` 在其旁插入 `newLeaf`（承载新组）。
 *
 * 落点始终是**目标叶子自身所在的那一格**，所以要先**递归下降**到承载它的节点（`descend`），
 * 再在该层判断新组怎么并排进去：
 *
 * - 承载它的分隔节点**方向一致** → 作为兄弟插进去（同方向相邻，不加深嵌套）；
 * - 方向不同 → 把**承载它的那个节点**包进一层同方向分隔；
 * - 它自己就是叶子 → 直接包一层。
 *
 * ⚠️ 「递归下降」这一步不能省。曾经只在**传入层的直接孩子**里找「第一个包含目标组的
 * 子节点」，命中后异方向就把**整棵子树**套壳 —— 于是「拖到下方那组的右侧」被解释成
 * 「拖到上下两栏整体的右侧」，新列落到整个面板最外层（用户报过）。锚点必须是目标叶子
 * 的**紧邻父节点**，不是根的孩子。
 */
export function insertSibling(
  layout: PaneNode,
  sourceGroupId: string,
  direction: SplitDirectionInput,
  newLeaf: PaneLeaf
): PaneNode {
  const splitDir = directionToSplit(direction)
  const before = isBefore(direction)
  // 根就是目标叶子：直接包一层
  if (layout.type === 'leaf') {
    if (layout.groupId !== sourceGroupId) return layout
    return wrapWith(layout, newLeaf, splitDir, before)
  }
  return descend(layout, sourceGroupId, splitDir, before, newLeaf)
}

/**
 * 下降到承载 `sourceGroupId` 的那个**叶子**的紧邻父节点，在那里把 `newLeaf` 插到它旁边。
 *
 * 每层只需问一句：「目标叶子是不是我某个**直接孩子**？」
 *
 * - 是，且我的方向与 `splitDir` 一致 → `newLeaf` 作为兄弟 splice 进来（同方向相邻，
 *   不加深嵌套；走 `splitSize` 只细分目标那一槽，其它兄弟比例不跳变）；
 * - 是，但方向不同 → 只把**那个叶子**包一层新方向的分隔（不是把整个 `node` 包起来 ——
 *   那就等于把同层其它兄弟也一起卷进去了）；
 * - 不是 → 顺着包含目标的那棵子树继续往下，回填结果。
 *
 * 返回同一引用 = 这棵子树里没有目标，调用方原样保留（避免无谓的新引用导致整块重渲染）。
 */
function descend(
  node: PaneSplit,
  sourceGroupId: string,
  splitDir: SplitDirection,
  before: boolean,
  newLeaf: PaneLeaf
): PaneNode {
  const idx = node.children.findIndex(
    (c) => c.type === 'leaf' && c.groupId === sourceGroupId
  )

  // 目标叶子就在本层的直接孩子里 —— 这才是「紧邻父节点」
  if (idx >= 0) {
    const leaf = node.children[idx] as PaneLeaf
    if (node.direction === splitDir) {
      const children = [...node.children]
      children.splice(before ? idx : idx + 1, 0, newLeaf)
      return { ...node, children, sizes: splitSize(node.sizes, idx, before) }
    }
    const children = [...node.children]
    children[idx] = wrapWith(leaf, newLeaf, splitDir, before)
    return { ...node, children }
  }

  // 目标还埋在更深一层：找到包含它的那个 child，继续下降并回填
  const deepIdx = node.children.findIndex((c) => childContainsGroup(c, sourceGroupId))
  if (deepIdx < 0) return node
  const child = node.children[deepIdx]
  if (child.type === 'leaf') return node // 不可能：上面已经处理过直接命中
  const deeper = descend(child, sourceGroupId, splitDir, before, newLeaf)
  if (deeper === child) return node
  const children = [...node.children]
  children[deepIdx] = deeper
  return { ...node, children }
}

/**
 * 删除承载 `groupId` 的叶子，并**折叠**仅剩单子节点的分隔节点。
 *
 * 递归折叠是必须的：一次删除可能让一条链上的多级分隔同时只剩一个孩子。
 * 返回 `null` 表示整棵树空了（调用方据此收起 / 回落，不能把 `null` 当空树塞回去）。
 */
export function removeLeaf(layout: PaneNode | null, groupId: string): PaneNode | null {
  if (!layout) return null
  if (layout.type === 'leaf') return layout.groupId === groupId ? null : layout
  const children = layout.children
    .map((c) => removeLeaf(c, groupId))
    .filter((c): c is PaneNode => c !== null)
  if (children.length === 0) return null
  if (children.length === 1) return children[0]
  const sizes = normalizeSizes(layout.sizes, children.length)
  return { ...layout, children, sizes }
}

/** 收集布局中所有组 ID（深度优先，前序） */
export function collectGroupIds(layout: PaneNode | null): string[] {
  if (!layout) return []
  if (layout.type === 'leaf') return [layout.groupId]
  return layout.children.flatMap((c) => collectGroupIds(c))
}

/** 取布局中第一个叶子对应的组 ID（关掉当前组后作为新的焦点候选） */
export function firstGroupId(layout: PaneNode | null): string | null {
  if (!layout) return null
  if (layout.type === 'leaf') return layout.groupId
  for (const c of layout.children) {
    const id = firstGroupId(c)
    if (id) return id
  }
  return null
}

/** 找到承载 `groupId` 的叶子（用于聚焦 / 判定） */
export function findLeafByGroup(layout: PaneNode | null, groupId: string): PaneLeaf | null {
  if (!layout) return null
  if (layout.type === 'leaf') return layout.groupId === groupId ? layout : null
  for (const c of layout.children) {
    const found = findLeafByGroup(c, groupId)
    if (found) return found
  }
  return null
}

/** 更新指定分隔节点的 `sizes` 权重（拖动分隔条） */
export function updateSizes(layout: PaneNode, splitId: string, sizes: number[]): PaneNode {
  if (layout.type === 'leaf') return layout
  if (layout.id === splitId) return { ...layout, sizes: normalizeSizes(sizes, layout.children.length) }
  const children = layout.children.map((c) => updateSizes(c, splitId, sizes))
  return children.every((c, i) => c === layout.children[i]) ? layout : { ...layout, children }
}

/**
 * 自检：`groupId` 不丢不重、叶子对应的组在本树里恰好各出现一次。
 *
 * 与旧实现的 `verify` 同属**安全网**：任何一次结构变更后调它，返回 `null` 表示树是好的，
 * 否则返回一句人能读的说明 —— 调用方据此**放弃这次更新**（保住旧树）。
 * 宁可不响应一次拖拽，也不能把用户终端所在的那一格弄丢。
 */
export function verifyLayout(beforeGroups: string[], layout: PaneNode | null): string | null {
  if (!layout) return '布局为空'
  const after = collectGroupIds(layout)
  const bag = new Map<string, number>()
  for (const g of beforeGroups) bag.set(g, (bag.get(g) ?? 0) + 1)
  const seen = new Set<string>()
  for (const g of after) {
    if (seen.has(g)) return `组 ${g} 重复出现`
    seen.add(g)
    const n = bag.get(g)
    if (n === undefined) return `多出了组 ${g}`
    if (n === 0) return `组 ${g} 重复出现`
    bag.set(g, n - 1)
  }
  for (const [g, n] of bag) if (n > 0) return `组 ${g} 丢失`
  return null
}
