/**
 * 右侧面板的**组 / 标签状态模型**（纯函数，零 React）。
 *
 * 与 `pane-layout.ts` 分工明确：
 * - `pane-layout.ts` 管**几何**（哪一块在哪、多大）—— 树里只有 `groupId`，没有标签；
 * - 本模块管**内容归属**（哪个标签在哪一组、组里当前显示哪一个）—— 与树解耦。
 *
 * 两者用一个 `PanelState` 装在一起（`layout` + `groups` + `activeGroupId`），
 * 所有变换都是 `(state, ...) => state` 的纯函数，所以能被单测直接覆盖，
 * 也能安全地放进 React 的 `setState` 更新器里（不产生副作用）。
 *
 * 这个结构照搬上级 dogi 的 store（`groups: Record<groupId, PanelGroup>` +
 * `layout: PaneNode` + `activeGroupId`），但把变量从 zustand 里提到这里做纯函数，
 * 方便本包（一个组件库）不依赖具体 store 实现。
 */
import {
  collectGroupIds,
  firstGroupId,
  genPaneId,
  insertSibling,
  makeLeaf,
  removeLeaf,
  verifyLayout,
  type PaneNode,
  type SplitDirectionInput
} from '@fizz/agent-kit/shared/lib/pane-layout'
import { arrayMove } from '@fizz/agent-kit/shared/lib/array-move'

/** 一个面板组：若干标签 + 组内当前显示的那一个 */
export interface PanelGroup {
  id: string
  /** 组内标签 key，按组内顺序 */
  tabIds: string[]
  /** 组内当前显示的标签（可能是 null：标签全被关掉、还没补上） */
  activeTabId: string | null
}

/** 标签的归属：面板要渲染的每个标签挂在哪个组上（不在这份表里的标签 = 没归属，会被忽略） */
export interface PanelTabMeta {
  key: string
  groupId: string
}

export interface PanelState {
  layout: PaneNode
  groups: Record<string, PanelGroup>
  /** 当前焦点组（高亮、下一步操作的默认目标） */
  activeGroupId: string
}

/** 由一棵单组树 + 一组标签铺出初始状态（「没被拖过」时的现场） */
export function initialState(tabKeys: string[]): PanelState {
  const gid = genPaneId()
  return {
    layout: makeLeaf(gid),
    groups: { [gid]: { id: gid, tabIds: [...tabKeys], activeTabId: tabKeys[0] ?? null } },
    activeGroupId: gid
  }
}

/** 某标签所在的组 id（不在任何组里 → null） */
export function groupOfTab(state: PanelState, key: string): string | null {
  for (const g of Object.values(state.groups)) {
    if (g.tabIds.includes(key)) return g.id
  }
  return null
}

/** 组内把某标签设为激活 */
export function activateTab(state: PanelState, key: string): PanelState {
  const gid = groupOfTab(state, key)
  if (!gid) return state
  const g = state.groups[gid]
  // 已经是「焦点组的活动标签」→ 原样返回。
  // 必须短路：`openTab` 之类会反复调它（视图同步、点标签），每次都造新对象会让
  // 订阅方白白重渲染，也可能在 effect 里被误当成「状态变了」。
  if (g.activeTabId === key && state.activeGroupId === gid) return state
  return {
    ...state,
    activeGroupId: gid,
    groups: { ...state.groups, [gid]: { ...g, activeTabId: key } }
  }
}

/**
 * 组内重排：把 `tabId` 从组内挪到 `toIndex`（重排前数组里的目标位）。
 *
 * 先取出、再按移除偏移校正（`from < toIndex` 时目标下标要 -1），否则会歪一格 ——
 * 与 dogi store 的 `reorderTabs` 同一算法。
 */
export function reorderInGroup(
  state: PanelState,
  groupId: string,
  tabId: string,
  toIndex: number
): PanelState {
  const g = state.groups[groupId]
  if (!g) return state
  const from = g.tabIds.indexOf(tabId)
  if (from === -1) return state
  const arr = [...g.tabIds]
  arr.splice(from, 1)
  let idx = from < toIndex ? toIndex - 1 : toIndex
  idx = Math.max(0, Math.min(arr.length, idx))
  arr.splice(idx, 0, tabId)
  if (arr.every((k, i) => k === g.tabIds[i])) return state
  return { ...state, groups: { ...state.groups, [groupId]: { ...g, tabIds: arr } } }
}

/**
 * 把标签挪到**目标组**（跨组移动）。
 *
 * `index` 不传 = 追加到组尾。若源组被摘空，连同它的叶子一起从布局里移除
 * （并折叠单子节点分隔）。同组调用是**无操作**（同组请走 `reorderInGroup`）。
 */
export function moveTabToGroup(
  state: PanelState,
  tabId: string,
  targetGroupId: string,
  index?: number
): PanelState {
  if (!state.groups[targetGroupId]) return state
  const srcGroupId = groupOfTab(state, tabId)
  if (!srcGroupId || srcGroupId === targetGroupId) return state

  const groups: Record<string, PanelGroup> = { ...state.groups }
  const src = groups[srcGroupId]
  if (!src) return state

  // 先从源组摘掉（源组变空 → 记下来，稍后连叶子一起删）
  let removedGroupId: string | null = null
  const srcTabIds = src.tabIds.filter((k) => k !== tabId)
  if (srcTabIds.length === 0) {
    delete groups[srcGroupId]
    removedGroupId = srcGroupId
  } else {
    groups[srcGroupId] = {
      ...src,
      tabIds: srcTabIds,
      activeTabId:
        src.activeTabId === tabId ? (srcTabIds[srcTabIds.length - 1] ?? null) : src.activeTabId
    }
  }

  // 再插进目标组
  const target = groups[targetGroupId]
  if (!target) return state
  const tabIds = [...target.tabIds]
  const at = index === undefined ? tabIds.length : Math.max(0, Math.min(tabIds.length, index))
  tabIds.splice(at, 0, tabId)
  groups[targetGroupId] = { ...target, tabIds, activeTabId: tabId }

  // 源组被摘空 → 连同它的叶子一起移除（`removeLeaf` 只在整树空了才返回 null；
  // 此时目标组还在，所以不会是 null —— 真出现就放弃这次变更）
  let layout: PaneNode = state.layout
  if (removedGroupId) {
    const next = removeLeaf(state.layout, removedGroupId)
    if (!next) return state
    layout = next
  }
  const groupsAfter = collectGroupIds(layout)
  if (verifyLayout(groupsAfter, layout) !== null) return state

  return { layout, groups, activeGroupId: targetGroupId }
}

/**
 * 把标签**拆到目标组旁边**新建一组（拖到组边缘分屏 / 右键「拆分」）。
 *
 * 先在目标组旁插入承载新组的叶子，再把标签挪进新组；原组若被摘空则连叶子一起移除。
 */
export function splitTabToGroup(
  state: PanelState,
  tabId: string,
  targetGroupId: string,
  direction: SplitDirectionInput
): PanelState {
  if (!state.groups[targetGroupId]) return state
  const srcGroupId = groupOfTab(state, tabId)
  if (!srcGroupId) return state
  // 组里只有它自己 → 拆了还是同一格，等于空操作
  if (srcGroupId === targetGroupId && state.groups[srcGroupId].tabIds.length < 2) return state

  const gid = genPaneId()
  const layout0 = insertSibling(state.layout, targetGroupId, direction, makeLeaf(gid))
  const groups: Record<string, PanelGroup> = {
    ...state.groups,
    [gid]: { id: gid, tabIds: [tabId], activeTabId: tabId }
  }

  const src = groups[srcGroupId]
  let removedGroupId: string | null = null
  if (src) {
    const tabIds = src.tabIds.filter((k) => k !== tabId)
    if (tabIds.length === 0) {
      delete groups[srcGroupId]
      removedGroupId = srcGroupId
    } else {
      groups[srcGroupId] = {
        ...src,
        tabIds,
        activeTabId:
          src.activeTabId === tabId ? (tabIds[tabIds.length - 1] ?? null) : src.activeTabId
      }
    }
  }

  let layout: PaneNode = layout0
  if (removedGroupId) {
    const next = removeLeaf(layout0, removedGroupId)
    if (!next) return state
    layout = next
  }
  if (verifyLayout(collectGroupIds(layout), layout) !== null) return state
  return { layout, groups, activeGroupId: gid }
}

/** 把**整组**搬到目标组旁边（拖组头 / 拖组内空白）：并入 or 新切一块 */
export function moveGroupToGroup(
  state: PanelState,
  groupId: string,
  targetGroupId: string,
  direction: SplitDirectionInput | 'center'
): PanelState {
  if (groupId === targetGroupId) return state
  const moving = state.groups[groupId]
  const target = state.groups[targetGroupId]
  if (!moving || !target) return state

  // 先把源组的**叶子**从布局里摘掉（组记录还在 —— 并入时要读它的标签、新切时要继续用它）
  const stripped = removeLeaf(state.layout, groupId)
  if (!stripped) return state

  if (direction === 'center') {
    // 并入：把源组的标签追加进目标组，然后**丢掉**源组的记录
    const groups: Record<string, PanelGroup> = { ...state.groups }
    delete groups[groupId]
    const t = groups[targetGroupId]
    if (!t) return state
    groups[targetGroupId] = {
      ...t,
      tabIds: [...t.tabIds, ...moving.tabIds],
      activeTabId: moving.activeTabId ?? t.activeTabId
    }
    if (verifyLayout(collectGroupIds(stripped), stripped) !== null) return state
    return { layout: stripped, groups, activeGroupId: targetGroupId }
  }

  // 新切一块：布局里把承载**同一个 groupId** 的叶子插到目标旁（组记录不动）
  const layout = insertSibling(stripped, targetGroupId, direction, makeLeaf(groupId))
  if (verifyLayout(collectGroupIds(layout), layout) !== null) return state
  return { layout, groups: state.groups, activeGroupId: groupId }
}

/** 关闭标签（从它所在的组里摘掉；组空 → 连组一起收掉） */
export function closeTab(state: PanelState, tabId: string): PanelState {
  const gid = groupOfTab(state, tabId)
  if (!gid) return state
  const g = state.groups[gid]
  const tabIds = g.tabIds.filter((k) => k !== tabId)

  if (tabIds.length === 0) {
    const groups = { ...state.groups }
    delete groups[gid]
    const layout = removeLeaf(state.layout, gid)
    if (!layout) return state // 最后一个标签：整树都空了，交给调用方（面板会收起）
    return {
      layout,
      groups,
      activeGroupId: state.activeGroupId === gid ? (firstGroupId(layout) ?? '') : state.activeGroupId
    }
  }

  const activeTabId =
    g.activeTabId === tabId ? (tabIds[Math.min(g.tabIds.indexOf(tabId), tabIds.length - 1)] ?? tabIds[0]) : g.activeTabId
  return { ...state, groups: { ...state.groups, [gid]: { ...g, tabIds, activeTabId } } }
}

/**
 * 把状态**对齐到当前的标签集合**：新增的追加进「焦点组」（没有就新建一组）、
 * 被关掉的从各组摘掉（组空则收掉）。返回新状态（无变化时返回原引用）。
 *
 * 必须在渲染前算：`tabs` 是父组件给的，关一个终端后立刻少一项；状态里若还留着那个 key，
 * 渲染就找不到内容。与 dogi 的差异在于 dogi 直接改 store、这里用纯函数对齐。
 */
export function alignToTabs(state: PanelState, tabKeys: string[]): PanelState {
  const incoming = new Set(tabKeys)
  const present = new Set<string>()
  for (const g of Object.values(state.groups)) for (const k of g.tabIds) if (incoming.has(k)) present.add(k)

  // 有「状态里存在、但传入已经没有」的标签 = 需要摘除；`present` 缺项 = 新增
  const staleKeys: string[] = []
  for (const g of Object.values(state.groups)) for (const k of g.tabIds) if (!incoming.has(k)) staleKeys.push(k)
  const missing = tabKeys.filter((k) => !present.has(k))
  if (staleKeys.length === 0 && missing.length === 0) return state

  // 逐组过滤掉已被关掉的标签，顺带修正各组 activeTabId
  const groups: Record<string, PanelGroup> = {}
  const emptied: string[] = []
  for (const g of Object.values(state.groups)) {
    const tabIds = g.tabIds.filter((k) => incoming.has(k))
    if (tabIds.length === 0) {
      emptied.push(g.id)
      continue
    }
    groups[g.id] = {
      ...g,
      tabIds,
      activeTabId: g.activeTabId && tabIds.includes(g.activeTabId) ? g.activeTabId : tabIds[0]
    }
  }

  // 摘掉变空的叶子。`removeLeaf` 在「整树被摘空」时返回 null —— 那说明传进来的
  // `tabs` 一个都不剩（面板要收起）或还等着补新标签，两种都由下面「按 groups 重建」兜底。
  let layout: PaneNode | null = state.layout
  for (const gid of emptied) {
    layout = layout ? removeLeaf(layout, gid) : null
  }

  // 新标签：追加进「焦点组」（还在的话），否则新建一组
  if (missing.length > 0) {
    const activeStillThere = groups[state.activeGroupId]
    if (activeStillThere) {
      groups[activeStillThere.id] = {
        ...activeStillThere,
        tabIds: [...activeStillThere.tabIds, ...missing],
        activeTabId: activeStillThere.activeTabId ?? missing[0]
      }
    } else {
      const gid = genPaneId()
      groups[gid] = { id: gid, tabIds: [...missing], activeTabId: missing[0] }
      // 布局里还有别的组 → 插到它旁边；布局空了 → 以这一组为新的根
      layout = layout
        ? insertSibling(layout, collectGroupIds(layout)[0] ?? '', 'right', makeLeaf(gid))
        : makeLeaf(gid)
      // 上面 insertSibling 有可能没找到锚点（不该发生）→ 兜底成新根，别留下孤儿组
      if (!layout || !collectGroupIds(layout).includes(gid)) layout = makeLeaf(gid)
    }
  }

  // 布局彻底空了（tabs 为空）→ 保留一个空组占位，保证「groups 与 layout 一致」这条不变量
  const finalLayout: PaneNode = layout ?? makeLeaf(pickEmptyGroup(groups, genPaneId()))

  const ids = collectGroupIds(finalLayout)
  const activeGroupId = ids.includes(state.activeGroupId) ? state.activeGroupId : (firstGroupId(finalLayout) ?? '')
  if (verifyLayout(ids, finalLayout) !== null) return state
  return { layout: finalLayout, groups, activeGroupId }
}

/** 布局空了又需要一个占位组时：拿一个已有的空组 id（有就复用），否则新开一个 */
function pickEmptyGroup(groups: Record<string, PanelGroup>, fallbackId: string): string {
  const empty = Object.values(groups).find((g) => g.tabIds.length === 0)
  if (empty) return empty.id
  groups[fallbackId] = { id: fallbackId, tabIds: [], activeTabId: null }
  return fallbackId
}

export { arrayMove }
