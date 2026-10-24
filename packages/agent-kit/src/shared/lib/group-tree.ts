/**
 * 分组树模型纯函数（**多级**）：构建、展示顺序、子树统计与移动。
 *
 * 写成泛型是为了同时服务两处需求相同的分组树 —— 接口请求分组（`ApiGroup` /
 * `ApiRequestEntry`）与主机分组（`HostGroup` / `HostConfig`）。两者的分组形状
 * （`id` + `parentId` 自引用）与条目形状（`id` + `groupId` 归属）完全一致，
 * 分两份只会让「移动分组时漏掉某个边界」这种 bug 修一半。
 *
 * ## 约定
 *
 * `groups` 数组的**顺序即 DFS 前序展示顺序**（父分组总在子孙之前，一个分组的
 * 所有子孙在它后面连续排列）。渲染端拖拽 / 移动后写回的顺序必须满足这个约束；
 * 服务端的 `arrangeApi` / `arrangeHosts` 按此约定消费。
 *
 * 纯函数、无 React。
 */

/** 分组节点：只要求「有 id、可自引用」—— 多一层 `name` 之类的字段与本模块无关 */
export interface GroupLike {
  id: string
  parentId?: string
}

/** 树里的条目：靠 `groupId` 指到某个分组；undefined = 未分组 */
export interface ItemLike {
  id: string
  groupId?: string
}

/** 分组树的中间节点：children 是子孙分组（数组序 = 展示序），items 是直接挂在本组的条目 */
export interface GroupNode<G, I> {
  group: G
  children: GroupNode<G, I>[]
  items: I[]
}

/** 由「扁平分组数组 + 全部条目」构建分组树（根节点按数组顺序 = DFS 前序） */
export function buildGroupTree<G extends GroupLike, I extends ItemLike>(
  groups: G[],
  items: I[]
): GroupNode<G, I>[] {
  const nodes = new Map<string, GroupNode<G, I>>()
  for (const g of groups) {
    nodes.set(g.id, {
      group: g,
      children: [],
      items: items.filter((i) => i.groupId === g.id)
    })
  }
  const roots: GroupNode<G, I>[] = []
  for (const g of groups) {
    const node = nodes.get(g.id)!
    const parent = g.parentId ? nodes.get(g.parentId) : undefined
    // 父分组不存在（数据损坏）或指向自己时按顶级处理，别丢节点
    if (parent && parent !== node) parent.children.push(node)
    else roots.push(node)
  }
  return roots
}

/** 把分组树摊平成渲染 / 拖拽共用的显示块（DFS 前序；首块固定是未分组） */
export function flattenBlocks<G extends GroupLike, I extends ItemLike>(
  roots: GroupNode<G, I>[],
  ungrouped: I[]
): Array<{ groupId?: string; items: I[] }> {
  const blocks: Array<{ groupId?: string; items: I[] }> = [
    { groupId: undefined, items: ungrouped }
  ]
  const walk = (n: GroupNode<G, I>): void => {
    blocks.push({ groupId: n.group.id, items: n.items })
    for (const c of n.children) walk(c)
  }
  for (const n of roots) walk(n)
  return blocks
}

/** groupId 指向不存在分组的条目归入「未分组」 */
export function collectUngrouped<I extends ItemLike, G extends GroupLike>(
  items: I[],
  groups: G[]
): I[] {
  const ids = new Set(groups.map((g) => g.id))
  return items.filter((i) => !i.groupId || !ids.has(i.groupId))
}

/** 分组（含自身）的所有子孙分组 id */
export function subtreeOf<G extends GroupLike>(groups: G[], id: string): Set<string> {
  const out = new Set<string>()
  const byChildren = new Map<string, string[]>()
  for (const g of groups) {
    if (!g.parentId) continue
    const list = byChildren.get(g.parentId) ?? []
    list.push(g.id)
    byChildren.set(g.parentId, list)
  }
  const walk = (gid: string): void => {
    if (out.has(gid)) return
    out.add(gid)
    for (const c of byChildren.get(gid) ?? []) walk(c)
  }
  walk(id)
  return out
}

/** maybeDesc 是否是 ancestor 的子孙（沿 parentId 链判断，带防环） */
function isDescendantOf<G extends GroupLike>(
  groups: G[],
  maybeDesc: string,
  ancestor: string
): boolean {
  const byId = new Map(groups.map((g) => [g.id, g]))
  let cur = byId.get(maybeDesc)
  const seen = new Set<string>()
  while (cur && cur.id !== ancestor) {
    if (seen.has(cur.id)) return false
    seen.add(cur.id)
    cur = cur.parentId ? byId.get(cur.parentId) : undefined
  }
  return Boolean(cur)
}

/**
 * 移动分组：把目标分组**连同它整棵子树**挂到 newParentId 之下（undefined = 顶级分组）。
 * 返回新的分组数组，保持 DFS 前序约束；非法目标（挂到自己 / 自己的子孙下）原样返回。
 */
export function moveGroup<G extends GroupLike>(
  groups: G[],
  targetId: string,
  newParentId: string | undefined
): G[] {
  const target = groups.find((g) => g.id === targetId)
  if (!target || newParentId === targetId) return groups
  const subtree = subtreeOf(groups, targetId)
  if (newParentId && subtree.has(newParentId)) return groups
  // 整棵子树一起搬：目标分组改 parentId，子孙分组原样（内部相对结构不变）
  const subtreeGroups = groups
    .filter((g) => subtree.has(g.id))
    .map((g) => (g.id === targetId ? { ...g, parentId: newParentId || undefined } : g))
  const rest = groups.filter((g) => !subtree.has(g.id))
  let at = rest.length
  if (newParentId) {
    const parentIdx = rest.findIndex((g) => g.id === newParentId)
    if (parentIdx >= 0) {
      // rest 保持 DFS 序：新父分组的子孙在它身后连续排列，扫到第一个非子孙即终点
      let last = parentIdx
      for (let i = parentIdx + 1; i < rest.length; i++) {
        if (isDescendantOf(rest, rest[i].id, newParentId)) last = i
        else break
      }
      at = last + 1
    }
  }
  rest.splice(at, 0, ...subtreeGroups)
  return rest
}

/** 分组子树（含自身）直接 / 间接拥有的条目总数（删除确认文案用） */
export function countSubtreeItems<G extends GroupLike, I extends ItemLike>(
  groups: G[],
  items: I[],
  id: string
): number {
  const subtree = subtreeOf(groups, id)
  return items.filter((i) => i.groupId && subtree.has(i.groupId)).length
}
