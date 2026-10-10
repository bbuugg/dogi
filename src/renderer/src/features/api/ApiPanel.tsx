import { API_HISTORY_SECTION_ID, API_LIST_SECTION_ID } from '@/app/section-ids'
import { methodClass } from '@/features/api/api-client'
import {
  SectionContent,
  SectionHeader,
  SectionShell,
  StackedSections
} from '@/shared/components/StackedSections'
import { apiTabId, useAppStore } from '@/stores/app-store'
import { OpenApiImportModal } from '@/features/api/OpenApiImportModal'
import {
  buildGroupTree,
  collectUngrouped,
  countSubtreeRequests,
  flattenBlocks,
  moveGroup,
  subtreeOf,
  type ApiGroupNode
} from '@/features/api/group-tree'
import type { ApiGroup, ApiHistoryEntry, ApiProtocol, ApiRequestEntry } from '@shared/types'
import {
  Button,
  Checkbox,
  Dropdown,
  Input,
  Modal,
  Tree,
  TreeSelect,
  message,
  type MenuProps,
  type TreeDataNode,
  type TreeSelectProps
} from 'antd'
import { cn } from 'cn'
import {
  Braces,
  Cable,
  ChevronDown,
  ChevronsLeft,
  FolderInput,
  FolderPlus,
  Globe,
  Pencil,
  Plus,
  Terminal,
  Trash2
} from 'lucide-react'
import { useMemo, useState } from 'react'
import { useDrag } from 'react-dnd'
import { SidebarGroupRow } from '@/shared/components/SidebarGroupRow'
import {
  SidebarRowActions,
  SIDEBAR_ROW_TRAIL_RESERVE
} from '@/shared/components/SidebarRowActions'
import {
  asRef,
  DropLine,
  mergeRefs,
  useRowDrop,
  type RowDragItem
} from '@/shared/components/SidebarRowDnd'

/** 树节点 key 前缀：g: 分组、r: 请求 */
const GROUP_KEY_PREFIX = 'g:'
const REQUEST_KEY_PREFIX = 'r:'

/** react-dnd 拖拽类型：请求与分组各一种，落点按类型分别处理 */
const DND_REQUEST = 'api-request'
const DND_GROUP = 'api-group'

/**
 * 列表块：数组顺序即 DFS 前序显示顺序；未分组块（groupId 为空）恒在首位，
 * 其余块按分组树的 DFS 前序排列（一个分组一个块，只放直接挂它名下的请求）。
 */
interface Block {
  groupId?: string
  items: ApiRequestEntry[]
}

const groupKey = (id: string): string => GROUP_KEY_PREFIX + id
const requestKey = (id: string): string => REQUEST_KEY_PREFIX + id

/** 请求的副标题：优先展示地址，没填地址时给个提示 */
function subtitleOf(req: ApiRequestEntry): string {
  const url = req.url.trim()
  return url || (req.protocol === 'ws' ? '尚未填写连接地址' : '尚未填写请求地址')
}

/**
 * 列表左侧的协议标记：HTTP 请求显示方法名，WebSocket 没有方法，统一显示 WS。
 * 两种条目共用同一张表，标记是唯一能一眼区分它们的地方。
 */
function protoLabel(req: ApiRequestEntry): string {
  return req.protocol === 'ws' ? 'WS' : req.method
}

/** 协议标记配色：WS 固定用天蓝，避免和 HTTP 方法配色撞色 */
function protoClass(req: ApiRequestEntry): string {
  return req.protocol === 'ws' ? 'text-sky-500' : methodClass(req.method)
}

/** 历史记录按天分桶的标签：今天 / 昨天 / M月D日（更早的按具体日期） */
function dayBucket(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const diffDays = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000)
  if (diffDays <= 0) return '今天'
  if (diffDays === 1) return '昨天'
  return `${d.getMonth() + 1}月${d.getDate()}日`
}

/** 历史行的悬浮提示：完整时间（年-月-日 时:分:秒） */
function formatFullTime(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** 历史行里「请求方法」的 badge 配色（与 methodClass 的语义色对齐，加淡底） */
function methodBadgeClass(method: string): string {
  switch (String(method || '').toUpperCase()) {
    case 'GET':
      return 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
    case 'POST':
      return 'bg-blue-500/15 text-blue-600 dark:text-blue-400'
    case 'PUT':
      return 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
    case 'PATCH':
      return 'bg-violet-500/15 text-violet-600 dark:text-violet-400'
    case 'DELETE':
      return 'bg-destructive/15 text-destructive'
    default:
      return 'bg-secondary text-muted-foreground'
  }
}

/**
 * 接口请求侧边栏：上下两个可折叠分区的组合（同「主机」侧边栏的主机 + 脚本）。
 *
 * 上半区是保存的请求列表（ApiRequestsSection），下半区是请求历史（ApiHistorySection）——
 * 历史原本是 ApiPage 里的右侧抽屉，现在收进侧边栏，发送请求后不用打开抽屉就能回看。
 * 两个分区各自的展开/收起、空间分配与最小高度约束由 StackedSections 统一负责。
 */
export function ApiPanel() {
  return (
    <StackedSections>
      <ApiRequestsSection />
      <ApiHistorySection />
    </StackedSections>
  )
}

/**
 * 上半区：保存的请求按分组列出，支持搜索 / 新建 / 打开 / 删除。
 *
 * 分组与拖拽与「主机」面板同一套模型（react-dnd + Block）：
 * 请求可跨组拖动并调整顺序，分组可拖动排序，「未分组」的请求平铺在最后。
 * 列表顺序就是存储顺序（不再按 updatedAt 排序）—— 否则拖完立刻被时间戳打乱。
 */
function ApiRequestsSection() {
  const apiRequests = useAppStore((s) => s.apiRequests)
  const apiGroups = useAppStore((s) => s.apiGroups)
  /** 当前激活组的激活标签 id（用于列表高亮） */
  const activeTabId = useAppStore((s) => {
    const gid = s.activeGroupId
    return gid ? (s.groups[gid]?.activeTabId ?? null) : null
  })
  const importCurlRequest = useAppStore((s) => s.importCurlRequest)
  const deleteApiRequest = useAppStore((s) => s.deleteApiRequest)
  const openApiTab = useAppStore((s) => s.openApiTab)
  const openNewApiDraft = useAppStore((s) => s.openNewApiDraft)
  const saveApiGroup = useAppStore((s) => s.saveApiGroup)
  const deleteApiGroup = useAppStore((s) => s.deleteApiGroup)
  const arrangeApi = useAppStore((s) => s.arrangeApi)

  const [search, setSearch] = useState('')
  const [pendingDelete, setPendingDelete] = useState<ApiRequestEntry | null>(null)
  /** 待确认删除的分组 */
  const [pendingGroupDelete, setPendingGroupDelete] = useState<ApiGroup | null>(null)
  /** 删除分组时是否连同组内请求一起删除（默认只解散分组） */
  const [deleteGroupRequests, setDeleteGroupRequests] = useState(false)
  /** 新建（id 为空）或重命名分组；parentId 只在新建时生效（新建子分组） */
  const [groupEdit, setGroupEdit] = useState<{
    id?: string
    name: string
    parentId?: string
  } | null>(null)
  /** 「移动到…」弹窗：选择一个新父分组（undefined = 顶级分组） */
  const [moveTarget, setMoveTarget] = useState<ApiGroup | null>(null)
  const [moveParent, setMoveParent] = useState<string | undefined>(undefined)
  /** 导入 cURL 弹窗；curlGroupId 非空 = 从某个分组发起（导入后落到该组） */
  const [curlOpen, setCurlOpen] = useState(false)
  const [curlText, setCurlText] = useState('')
  const [curlGroupId, setCurlGroupId] = useState<string | undefined>(undefined)
  const [importing, setImporting] = useState(false)
  /** 导入 OpenAPI / Swagger 弹窗 */
  const [openApiOpen, setOpenApiOpen] = useState(false)

  // 分组默认全部折叠：不自动展开任何分组（包括新建的），展开/折叠只由用户操作决定
  const [expandedKeys, setExpandedKeys] = useState<string[]>([])

  // 多级分组：先建树，再按 DFS 前序摊平成块（groupId 指向不存在分组的请求算「未分组」）
  const groupTree = useMemo(
    () => buildGroupTree(apiGroups, apiRequests),
    [apiGroups, apiRequests]
  )
  const ungrouped = useMemo(
    () => collectUngrouped(apiRequests, apiGroups),
    [apiRequests, apiGroups]
  )
  // 「未分组」块恒在首位（渲染时平铺到最后，见下面的 treeData）
  const blocks = useMemo(() => flattenBlocks(groupTree, ungrouped), [groupTree, ungrouped])

  const q = search.trim().toLowerCase()
  const searching = q.length > 0
  const hitRequest = (r: ApiRequestEntry): boolean =>
    !searching ||
    r.name.toLowerCase().includes(q) ||
    r.url.toLowerCase().includes(q) ||
    r.method.toLowerCase().includes(q)

  /**
   * 搜索时按命中过滤分组树：组名命中 = 整组保留；未命中的组只保留命中的请求 / 子孙分组。
   * 拖拽的落点计算一律走**完整的** blocks —— 按 id 定位，所以即便列表被过滤，
   * 请求也会准确落到目标行旁边，隐藏的行不会被丢掉或被打乱顺序。
   */
  const filterNode = (n: ApiGroupNode): { node: ApiGroupNode; hit: boolean } => {
    const childResults = n.children.map(filterNode)
    const keptChildren = childResults.filter((r) => r.hit).map((r) => r.node)
    const nameHit = n.group.name.toLowerCase().includes(q)
    const keptItems = searching ? n.items.filter(hitRequest) : n.items
    const hit = !searching || nameHit || keptItems.length > 0 || keptChildren.length > 0
    return { node: { group: n.group, children: keptChildren, items: keptItems }, hit }
  }
  const viewTree: ApiGroupNode[] = searching
    ? groupTree.map(filterNode).filter((r) => r.hit).map((r) => r.node)
    : groupTree
  const viewUngrouped = searching ? ungrouped.filter(hitRequest) : ungrouped

  const locate = (list: Block[], id: string): { b: number; i: number } | null => {
    for (let b = 0; b < list.length; b++) {
      const i = list[b].items.findIndex((r) => r.id === id)
      if (i >= 0) return { b, i }
    }
    return null
  }

  /** 把调整后的块结构整体写回（顺序与归属一次提交，避免中间态） */
  const commit = (next: Block[]) => {
    // 块顺序 → 分组顺序（DFS 前序）；块重排不改层级，parentId 沿用当前树结构
    const groupOrder: ApiGroup[] = []
    const seen = new Set<string>()
    for (const b of next) {
      if (!b.groupId || seen.has(b.groupId)) continue
      seen.add(b.groupId)
      const g = apiGroups.find((x) => x.id === b.groupId)
      if (g) groupOrder.push(g)
    }
    for (const g of apiGroups) {
      if (!seen.has(g.id)) groupOrder.push(g)
    }
    void arrangeApi({
      groups: groupOrder.map((g) => ({ id: g.id, parentId: g.parentId })),
      requests: next.flatMap((b) => b.items.map((r) => ({ id: r.id, groupId: b.groupId })))
    })
  }

  /** 请求拖拽落点：插到目标请求前/后；targetId 为空时追加到目标分组末尾 */
  const dropRequest = (
    dragId: string,
    targetId: string | null,
    targetGroupId: string | undefined,
    after: boolean
  ) => {
    const next = blocks.map((b) => ({ groupId: b.groupId, items: [...b.items] }))
    const from = locate(next, dragId)
    if (!from) return
    const [moved] = next[from.b].items.splice(from.i, 1)
    if (targetId) {
      const at = locate(next, targetId)
      if (at) {
        next[at.b].items.splice(at.i + (after ? 1 : 0), 0, moved)
        commit(next)
        return
      }
    }
    const blk = next.findIndex((b) => b.groupId === targetGroupId)
    if (blk < 0) return
    next[blk].items.push(moved)
    commit(next)
  }

  /**
   * 分组拖拽落点：移到目标分组的前/后（同一层级内调整顺序）。
   * 拖拽**整棵子树**一起走（子孙分组的块在 DFS 序里紧跟在它后面）；
   * 跨层级移动走「移动到…」菜单（见 confirmMoveGroup）。
   */
  const dropGroup = (dragId: string, targetGroupId: string, after: boolean) => {
    const next = blocks.map((b) => ({ groupId: b.groupId, items: b.items }))
    const from = next.findIndex((b) => b.groupId === dragId)
    if (from < 0) return
    const subtree = subtreeOf(apiGroups, dragId)
    let runLen = 1
    while (
      from + runLen < next.length &&
      next[from + runLen].groupId &&
      subtree.has(next[from + runLen].groupId!)
    ) {
      runLen += 1
    }
    const run = next.splice(from, runLen)
    let to = next.findIndex((b) => b.groupId === targetGroupId)
    if (to < 0) return
    if (after) to += 1
    // 「未分组」块固定首位：分组不能落到它前面
    const firstGroup = next.findIndex((b) => b.groupId)
    if (firstGroup >= 0 && to < firstGroup) to = firstGroup
    next.splice(to, 0, ...run)
    commit(next)
  }

  /** 点击分组行整行切换展开/折叠 */
  const toggleKey = (key: string) => {
    setExpandedKeys((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]))
  }

  /**
   * 新建：只打开右侧一个「未保存草稿」标签，不落盘、不进列表。
   * 真正的保存发生在用户在该标签里按 Ctrl/Cmd+S 之后（已填名称直接落盘，
   * 没填则弹窗补名称，见 ApiPage.saveNow）。
   *
   * protocol = 'ws' 时建的是 WebSocket 调试草稿，走同一套标签/落盘流程，
   * 只是右侧渲染 WsPage 而不是 ApiPage。
   */
  const handleCreate = (groupId?: string, protocol: ApiProtocol = 'http'): void => {
    openNewApiDraft(groupId, protocol)
  }

  const confirmDelete = async () => {
    const target = pendingDelete
    if (!target) return
    setPendingDelete(null)
    try {
      await deleteApiRequest(target.id)
      message.success('已删除该请求')
    } catch (e) {
      message.error(`删除失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const submitGroupEdit = async () => {
    const name = groupEdit?.name.trim()
    if (!name) return
    try {
      await saveApiGroup({
        id: groupEdit?.id,
        name,
        // 重命名时不带 parentId（saveApiGroup 会保留原父分组）；新建子分组才带
        parentId: groupEdit?.parentId
      })
      // 新建子分组后把父链展开，让新分组立刻可见（分组默认全折叠）
      if (!groupEdit?.id) expandAncestors(groupEdit?.parentId)
      setGroupEdit(null)
    } catch (e) {
      message.error(`保存分组失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  /** 待删除分组的**子树**内请求数量（含子孙分组，用于确认框的文案与勾选项） */
  const pendingSubtreeRequestCount = pendingGroupDelete
    ? countSubtreeRequests(apiGroups, apiRequests, pendingGroupDelete.id)
    : 0

  const confirmGroupDelete = async () => {
    const target = pendingGroupDelete
    if (!target) return
    const alsoRequests = deleteGroupRequests
    // 多级删除：请求随子孙分组一起上移一级（被删分组是顶级时回「未分组」）
    const fallbackName =
      (target.parentId && apiGroups.find((g) => g.id === target.parentId)?.name) ?? '未分组'
    setPendingGroupDelete(null)
    setDeleteGroupRequests(false)
    try {
      await deleteApiGroup(target.id, alsoRequests)
      message.success(
        `已删除分组「${target.name}」：${
          alsoRequests ? '组内及子分组请求已一并删除' : `组内及子分组请求已移到「${fallbackName}」`
        }`
      )
    } catch (e) {
      message.error(`删除分组失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  /** 把分组（含整棵子树）移动到新父分组下 */
  const confirmMoveGroup = async () => {
    const target = moveTarget
    if (!target) return
    const parentId = moveParent || undefined
    setMoveTarget(null)
    if (parentId === target.parentId) return
    try {
      const nextGroups = moveGroup(apiGroups, target.id, parentId)
      await arrangeApi({
        groups: nextGroups.map((g) => ({ id: g.id, parentId: g.parentId })),
        requests: apiRequests.map((r) => ({ id: r.id, groupId: r.groupId }))
      })
      // 让移动后的分组可见：展开目标父链
      if (parentId) expandAncestors(parentId)
      message.success(`已移动「${target.name}」${parentId ? '到所选分组下' : '到顶级分组'}`)
    } catch (e) {
      message.error(`移动失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  /** 把一个请求移出到「未分组」：只改该请求的归属，保持其它顺序不变 */
  const moveOutOfGroup = (req: ApiRequestEntry) => {
    void arrangeApi({
      groups: apiGroups.map((g) => ({ id: g.id, parentId: g.parentId })),
      requests: apiRequests.map((r) => ({
        id: r.id,
        groupId: r.id === req.id ? undefined : r.groupId
      }))
    })
  }

  /** 导入 cURL：解析成一条新的保存请求并打开它的标签（从分组发起时落到该组） */
  const handleImportCurl = async () => {
    setImporting(true)
    try {
      const id = await importCurlRequest(curlText, curlGroupId)
      if (id) openApiTab(id)
      setCurlOpen(false)
      setCurlText('')
      setCurlGroupId(undefined)
      message.success('已导入 cURL 命令')
    } catch (e) {
      message.error('导入失败：' + (e instanceof Error ? e.message : String(e)))
    } finally {
      setImporting(false)
    }
  }

  /** 把父链（含自己）展开，保证新建的子分组可见（分组默认全折叠） */
  const expandAncestors = (gid?: string): void => {
    if (!gid) return
    const chain: string[] = []
    const byId = new Map(apiGroups.map((g) => [g.id, g]))
    let cur: ApiGroup | undefined = byId.get(gid)
    const seen = new Set<string>()
    while (cur && !seen.has(cur.id)) {
      chain.push(groupKey(cur.id))
      seen.add(cur.id)
      cur = cur.parentId ? byId.get(cur.parentId) : undefined
    }
    if (chain.length) setExpandedKeys((prev) => [...new Set([...prev, ...chain])])
  }

  /**
   * 分组选择器的树形选项（顶级 value = ''；新建分组 / 移动到… 复用）。
   * exclude：要从选项里排除的节点（如「移动到…」不能选目标分组自己 / 子孙）。
   */
  const buildGroupOptions = (exclude?: Set<string>): NonNullable<TreeSelectProps['treeData']> => {
    const build = (nodes: ApiGroupNode[]): NonNullable<TreeSelectProps['treeData']> => {
      const out: NonNullable<TreeSelectProps['treeData']> = []
      for (const n of nodes) {
        if (exclude?.has(n.group.id)) continue
        out.push({
          value: n.group.id,
          title: n.group.name,
          children: build(n.children)
        })
      }
      return out
    }
    return [{ value: '', title: '顶级分组', children: build(groupTree) }]
  }

  const requestNode = (r: ApiRequestEntry, hasGroup: boolean): TreeDataNode => ({
    key: requestKey(r.id),
    title: (
      <RequestRow
        request={r}
        hasGroup={hasGroup}
        active={activeTabId === apiTabId(r.id)}
        onOpen={() => openApiTab(r.id)}
        onMoveOut={() => moveOutOfGroup(r)}
        onDelete={() => setPendingDelete(r)}
        onDropRequest={dropRequest}
        onDropGroup={dropGroup}
      />
    )
  })

  /** 悬浮「新建」按钮的下拉（与顶部新建同一套入口，动作落到本组） */
  const groupNewMenuItems = (group: ApiGroup): NonNullable<MenuProps['items']> => [
    { key: 'new', icon: <Plus className="size-3.5" />, label: '在此分组新建请求' },
    { key: 'newWs', icon: <Cable className="size-3.5" />, label: '在此分组新建 WebSocket' },
    { key: 'curl', icon: <Terminal className="size-3.5" />, label: '导入 cURL 到此分组' },
    {
      key: 'openapi',
      icon: <Braces className="size-3.5" />,
      label: '导入 OpenAPI / Swagger'
    }
  ]

  /** 分组的右键菜单（多新建方式 + 子分组 + 层级移动 + 重命名 / 删除） */
  const groupContextMenu = (group: ApiGroup): MenuProps['items'] => [
    ...groupNewMenuItems(group),
    { type: 'divider' },
    { key: 'sub', icon: <FolderPlus className="size-3.5" />, label: '在此分组新建子分组' },
    { key: 'move', icon: <FolderInput className="size-3.5" />, label: '移动到…' },
    { type: 'divider' },
    { key: 'rename', icon: <Pencil className="size-3.5" />, label: '重命名' },
    { key: 'delete', icon: <Trash2 className="size-3.5" />, label: '删除分组', danger: true }
  ]

  /** 分组的新建动作分发（下拉与右键菜单共用） */
  const handleGroupNew = (group: ApiGroup, key: string): void => {
    if (key === 'new') void handleCreate(group.id)
    else if (key === 'newWs') void handleCreate(group.id, 'ws')
    else if (key === 'curl') {
      setCurlGroupId(group.id)
      setCurlOpen(true)
    } else if (key === 'openapi') setOpenApiOpen(true)
  }

  const handleGroupMenu = (group: ApiGroup, key: string): void => {
    if (key === 'new' || key === 'newWs' || key === 'curl' || key === 'openapi') {
      handleGroupNew(group, key)
    } else if (key === 'sub') {
      setGroupEdit({ name: '', parentId: group.id })
      expandAncestors(group.id)
    } else if (key === 'move') {
      setMoveParent(group.parentId)
      setMoveTarget(group)
    } else if (key === 'rename') {
      setGroupEdit({ id: group.id, name: group.name })
    } else if (key === 'delete') {
      setDeleteGroupRequests(false)
      setPendingGroupDelete(group)
    }
  }

  /** 递归渲染分组节点：子分组在前、直接请求在后 */
  const renderGroupNode = (n: ApiGroupNode): TreeDataNode => {
    const hasChildren = n.children.length > 0
    // 「是否空组」按**完整**分组算：搜索过滤掉几行不该改变分组的规模
    const isEmpty = n.items.length === 0 && !hasChildren
    return {
      key: groupKey(n.group.id),
      title: (
        <SidebarGroupRow
          expanded={isEmpty ? false : expandedKeys.includes(groupKey(n.group.id))}
          name={n.group.name}
          onToggle={isEmpty ? () => {} : () => toggleKey(groupKey(n.group.id))}
          itemType={DND_REQUEST}
          groupType={DND_GROUP}
          groupId={n.group.id}
          onDropItem={dropRequest}
          onDropGroup={dropGroup}
          onNew={() => void handleCreate(n.group.id)}
          newTitle="在此分组新建请求"
          newMenuItems={groupNewMenuItems(n.group)}
          onNewMenuClick={(key) => handleGroupNew(n.group, key)}
          menuItems={groupContextMenu(n.group)}
          onMenuClick={(key) => handleGroupMenu(n.group, key)}
        />
      ),
      children: isEmpty
        ? undefined
        : [...n.children.map(renderGroupNode), ...n.items.map((r) => requestNode(r, true))]
    }
  }

  // 分组树在前，未分组的请求平铺在最后（不另设「未分组」折叠组）
  const treeData: TreeDataNode[] = [
    ...viewTree.map(renderGroupNode),
    ...viewUngrouped.map((r) => requestNode(r, false))
  ]

  /** 搜索时把命中的分组全部展开（否则要逐个点开才看得到结果） */
  const collectGroupKeys = (nodes: ApiGroupNode[]): string[] =>
    nodes.flatMap((n) => [groupKey(n.group.id), ...collectGroupKeys(n.children)])
  const effectiveExpanded = searching ? collectGroupKeys(viewTree) : expandedKeys

  const isEmpty = apiRequests.length === 0 && apiGroups.length === 0
  const noMatch = searching && treeData.length === 0

  return (
    <SectionShell id={API_LIST_SECTION_ID} grow={2} minHeight={200}>
      {/* 标题栏：整条点击可收起/展开；右侧是新建分组 / 新建下拉（与「主机」「脚本」分区同款） */}
      <SectionHeader
        id={API_LIST_SECTION_ID}
        title="接口请求"
        count={apiRequests.length}
        extra={
          <>
            <Button
              type="text"
              size="small"
              className="px-0.5 text-muted-foreground"
              title="新建分组"
              icon={<FolderPlus className="size-3.5" />}
              onClick={() => setGroupEdit({ name: '' })}
            />
            {/* 新建入口带下拉：HTTP 请求 / WebSocket 连接 / cURL 导入三个动作收进菜单 */}
            <Dropdown
              trigger={['click']}
              menu={{
                items: [
                  { key: 'blank', icon: <Plus className="size-3.5" />, label: '新建请求' },
                  { key: 'ws', icon: <Cable className="size-3.5" />, label: '新建 WebSocket' },
                  { key: 'curl', icon: <Terminal className="size-3.5" />, label: '导入 cURL' },
                  { key: 'openapi', icon: <Braces className="size-3.5" />, label: '导入 OpenAPI / Swagger' }
                ],
                onClick: ({ key }) => {
                  if (key === 'blank') void handleCreate()
                  else if (key === 'ws') void handleCreate(undefined, 'ws')
                  else if (key === 'curl') {
                    setCurlGroupId(undefined)
                    setCurlOpen(true)
                  } else setOpenApiOpen(true)
                }
              }}
            >
              <Button
                type="text"
                size="small"
                className="px-0.5 text-muted-foreground"
                title="新建请求 / WebSocket / 导入 cURL / OpenAPI"
                icon={<Plus className="size-3.5" />}
              >
                <ChevronDown className="size-3 opacity-60" />
              </Button>
            </Dropdown>
          </>
        }
      />

      <SectionContent id={API_LIST_SECTION_ID}>
        <div className="px-3">
          <Input
            size='small'
            placeholder="搜索请求…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            allowClear
          />
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-1.5 no-scrollbar">
          {isEmpty ? (
            <div className="mx-2 mt-8 rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
              还没有保存的请求。
              <br />
              点击右上角 + 新建请求 / WebSocket，或导入 cURL / OpenAPI 文档。
            </div>
          ) : noMatch ? (
            <div className="mx-2 mt-8 rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
              没有匹配「{search}」的请求。
            </div>
          ) : (
            <Tree
              className="side-tree"
              treeData={treeData}
              selectable={false}
              blockNode
              expandedKeys={effectiveExpanded}
              onExpand={(keys) => setExpandedKeys(keys.map(String))}
            />
          )}
        </div>
      </SectionContent>

      {/* 新建 / 重命名分组（新建时可选父分组 = 生成子分组） */}
      <Modal
        open={groupEdit !== null}
        onCancel={() => setGroupEdit(null)}
        title={groupEdit?.id ? '重命名分组' : groupEdit?.parentId ? '新建子分组' : '新建分组'}
        okText="保存"
        cancelText="取消"
        centered
        width={400}
        destroyOnHidden
        okButtonProps={{ disabled: !groupEdit?.name.trim() }}
        onOk={() => void submitGroupEdit()}
      >
        <div className="space-y-3">
          {!groupEdit?.id && (
            <TreeSelect
              className="w-full"
              placeholder="父分组（缺省为顶级分组）"
              value={groupEdit?.parentId ?? ''}
              onChange={(v) =>
                setGroupEdit((g) =>
                  g ? { ...g, parentId: (v as string) || undefined } : g
                )
              }
              treeData={buildGroupOptions()}
              treeDefaultExpandAll
              allowClear
            />
          )}
          <Input
            autoFocus
            placeholder="分组名称，如：用户服务"
            value={groupEdit?.name ?? ''}
            onChange={(e) => setGroupEdit((g) => (g ? { ...g, name: e.target.value } : g))}
            onPressEnter={() => void submitGroupEdit()}
          />
        </div>
      </Modal>

      {/* 移动到…：分组跨层级移动（带着整棵子树），目标从树形选择器里挑 */}
      <Modal
        open={moveTarget !== null}
        onCancel={() => setMoveTarget(null)}
        title={`移动分组「${moveTarget?.name ?? ''}」`}
        okText="移动"
        cancelText="取消"
        centered
        width={420}
        destroyOnHidden
        onOk={() => void confirmMoveGroup()}
      >
        <p className="mb-2 text-xs text-muted-foreground">
          选择新的父分组：选「顶级分组」把它移到最外层；该分组连同所有子分组一起移动。
        </p>
        <TreeSelect
          className="w-full"
          placeholder="选择父分组"
          value={moveParent ?? ''}
          onChange={(v) => setMoveParent((v as string) || undefined)}
          treeData={buildGroupOptions(moveTarget ? subtreeOf(apiGroups, moveTarget.id) : undefined)}
          treeDefaultExpandAll
          allowClear
        />
      </Modal>

      {/* 删除分组确认 */}
      <Modal
        open={pendingGroupDelete !== null}
        onCancel={() => setPendingGroupDelete(null)}
        title="删除分组？"
        okText="删除"
        cancelText="取消"
        okButtonProps={{ danger: true }}
        centered
        width={440}
        destroyOnHidden
        onOk={() => void confirmGroupDelete()}
      >
        <p className="text-sm text-muted-foreground">
          「{pendingGroupDelete?.name}」将被删除（连同所有子分组）
          {pendingSubtreeRequestCount > 0
            ? `，其中共 ${pendingSubtreeRequestCount} 个请求。`
            : '。'}
        </p>
        {pendingSubtreeRequestCount > 0 && (
          <Checkbox
            className="mt-3"
            checked={deleteGroupRequests}
            onChange={(e) => setDeleteGroupRequests(e.target.checked)}
          >
            <span className="text-sm">同时删除组内及子分组的请求</span>
          </Checkbox>
        )}
        <p className="mt-2 text-xs text-muted-foreground">
          {deleteGroupRequests
            ? '请求将一并删除，该操作不可撤销。'
            : '不勾选时，请求会随子孙分组一起上移一级（删除顶级分组则回到「未分组」）。'}
        </p>
      </Modal>

      {/* cURL 导入：解析成新请求并打开其标签（从分组发起时落到该组） */}
      <Modal
        centered
        open={curlOpen}
        onCancel={() => {
          setCurlOpen(false)
          setCurlGroupId(undefined)
        }}
        width={576}
        title={
          <div>
            <div className="text-sm">导入 cURL 命令</div>
            <div className="text-xs text-muted-foreground">
              {curlGroupId
                ? '粘贴 curl 命令，解析后保存为一条新请求并放入当前分组'
                : '粘贴 curl 命令，解析后保存为一条新的请求并打开'}
            </div>
          </div>
        }
        footer={
          <div className="flex justify-end gap-2">
            <Button onClick={() => setCurlOpen(false)}>取消</Button>
            <Button
              type="primary"
              loading={importing}
              disabled={!curlText.trim()}
              onClick={() => void handleImportCurl()}
            >
              导入
            </Button>
          </div>
        }
      >
        <Input.TextArea
          value={curlText}
          onChange={(e) => setCurlText(e.target.value)}
          placeholder={
            'curl -X POST https://api.example.com/users \\\n  -H "Content-Type: application/json" \\\n  -d \'{"name":"foo"}\''
          }
          className="h-48! font-mono text-xs"
          spellCheck={false}
          autoFocus
        />
      </Modal>

      {/* OpenAPI / Swagger 导入：文件 / URL 取数 → 解析预览 → 确认后建组 + 建请求 */}
      <OpenApiImportModal open={openApiOpen} onClose={() => setOpenApiOpen(false)} />

      {/* 删除确认 */}
      <Modal
        open={pendingDelete !== null}
        onCancel={() => setPendingDelete(null)}
        title="删除接口请求？"
        okText="删除"
        cancelText="取消"
        okButtonProps={{ danger: true }}
        onOk={() => void confirmDelete()}
        centered
        width={420}
        destroyOnHidden
      >
        <p className="text-sm text-muted-foreground">
          「{pendingDelete?.name.trim() || pendingDelete?.url || '未命名请求'}」将被永久删除，
          该操作不可撤销。
        </p>
      </Modal>
    </SectionShell>
  )
}

/**
 * 下半区：请求历史（原 ApiPage 的右侧抽屉，收进侧边栏）。
 *
 * 每行显示方法 / 状态码 / 地址 / 相对时间；点行或「载入」按钮 = 以这条历史的内容
 * 打开一个「新建请求」草稿（内容经 store 的 apiDraftSeed 传递，见 ApiPage 的种子 effect）。
 * 标题栏右侧是清空按钮（无确认 —— 历史本就是滑动窗口，丢了也无妨）。
 */
function ApiHistorySection() {
  const apiHistory = useAppStore((s) => s.apiHistory)
  const clearApiHistory = useAppStore((s) => s.clearApiHistory)
  const loadApiHistoryDraft = useAppStore((s) => s.loadApiHistoryDraft)

  return (
    <SectionShell
      id={API_HISTORY_SECTION_ID}
      grow={1}
      minHeight={180}
      // 展开时与上方的请求分区互相让位：拖动条改的是本分区高度
      resizableAbove={API_LIST_SECTION_ID}
    >
      <SectionHeader
        id={API_HISTORY_SECTION_ID}
        title="历史记录"
        count={apiHistory.length}
        extra={
          <Button
            type="text"
            size="small"
            className="px-0.5 text-muted-foreground"
            disabled={apiHistory.length === 0}
            title="清空历史"
            icon={<Trash2 className="size-3.5" />}
            onClick={() => void clearApiHistory()}
          />
        }
      />

      <SectionContent id={API_HISTORY_SECTION_ID}>
        <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-1.5 pb-2">
          {apiHistory.length === 0 ? (
            <div className="mx-2 mt-6 rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
              还没有请求历史。发送请求后会自动记录到这里（最多保留 50 条）。
            </div>
          ) : (
            <HistoryList history={apiHistory} onLoad={loadApiHistoryDraft} />
          )}
        </div>
      </SectionContent>
    </SectionShell>
  )
}

/**
 * 历史记录列表：按天分组成「今天 / 昨天 / M月D日」各区块，区块内保留存储顺序。
 * 行内不再显示时间（避免把行撑宽、出现横向滚动条），鼠标悬停某条会在提示里给出完整时间。
 */
function HistoryList({
  history,
  onLoad
}: {
  history: ApiHistoryEntry[]
  onLoad: (entry: ApiHistoryEntry) => void
}) {
  const groups = useMemo(() => {
    // 历史本就按时间倒序：同一天的条目相邻，按出现顺序分桶即可天然得到「今天→昨天→更早」的顺序
    const map = new Map<string, ApiHistoryEntry[]>()
    for (const e of history) {
      const key = dayBucket(e.at)
      const arr = map.get(key)
      if (arr) arr.push(e)
      else map.set(key, [e])
    }
    return [...map.entries()].map(([label, items]) => ({ label, items }))
  }, [history])

  return (
    <div className="space-y-2">
      {groups.map((g) => (
        <div key={g.label}>
          <div className="px-2 pb-0.5 pt-1 text-xs font-medium uppercase tracking-wide text-muted-foreground/70">
            {g.label}
          </div>
          <div className="space-y-0.5">
            {g.items.map((entry, idx) => (
              <div
                key={entry.id || idx}
                className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 hover:bg-primary/5"
                title={`${formatFullTime(entry.at)} · 载入「${entry.method} ${entry.url}」到新建请求`}
                onClick={() => onLoad(entry)}
              >
                <span
                  className={cn(
                    'shrink-0 rounded px-1.5 py-0.5 font-mono text-xs font-semibold',
                    methodBadgeClass(entry.method)
                  )}
                >
                  {entry.method || 'GET'}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-xs" title={entry.url}>
                  {entry.url}
                </span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

/** 拖拽落点处理函数签名（请求与分组共用，由面板统一重排后一次写回） */
type DropRequest = (
  dragId: string,
  targetId: string | null,
  targetGroupId: string | undefined,
  after: boolean
) => void
type DropGroup = (dragId: string, targetGroupId: string, after: boolean) => void

/** 请求行：可拖动排序 / 跨组；点击打开，右键打开 / 移出分组 / 删除 */
function RequestRow({
  request,
  hasGroup,
  active,
  onOpen,
  onMoveOut,
  onDelete,
  onDropRequest,
  onDropGroup
}: {
  request: ApiRequestEntry
  /** 所在分组真实存在（决定能否用本行作为分组排序的落点） */
  hasGroup: boolean
  /** 是否为当前打开的标签（列表高亮） */
  active: boolean
  onOpen: () => void
  /** 移出到「未分组」（仅分组内请求显示） */
  onMoveOut: () => void
  onDelete: () => void
  onDropRequest: DropRequest
  onDropGroup: DropGroup
}) {
  const [{ isDragging }, drag] = useDrag<RowDragItem, void, { isDragging: boolean }>(
    () => ({
      type: DND_REQUEST,
      item: { id: request.id },
      collect: (m) => ({ isDragging: m.isDragging() })
    }),
    [request.id]
  )

  const { ref: dropRef, over, after } = useRowDrop<HTMLDivElement>({
    itemType: DND_REQUEST,
    groupType: DND_GROUP,
    canDrop: (item, type) =>
      type === DND_GROUP ? hasGroup && item.id !== request.groupId : item.id !== request.id,
    drop: (item, type, at) => {
      if (type === DND_GROUP) onDropGroup(item.id, request.groupId!, at)
      else onDropRequest(item.id, request.id, request.groupId, at)
    }
  })

  const dragRef = useMemo(() => asRef<HTMLDivElement>(drag), [drag])
  const ref = useMemo(() => mergeRefs(dropRef, dragRef), [dropRef, dragRef])

  // WebSocket 条目没有 HTTP 方法，图标与标记都要换一套
  const isWs = request.protocol === 'ws'

  const items: MenuProps['items'] = [
    {
      key: 'open',
      icon: isWs ? <Cable className="size-3.5" /> : <Globe className="size-3.5" />,
      label: '打开'
    },
    // 分组内请求才提供「移出分组」，作为移出分组的入口
    ...(request.groupId
      ? [{ key: 'moveout', icon: <ChevronsLeft className="size-3.5" />, label: '移出分组' }]
      : []),
    { type: 'divider' },
    { key: 'delete', icon: <Trash2 className="size-3.5" />, label: '删除', danger: true }
  ]

  // 同 GroupRow：拖拽 ref 在最外层，Dropdown 只包内容
  return (
    <div
      ref={ref}
      className={cn(
        'group/req row-own-bg relative flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md px-1 py-1 transition-colors',
        isDragging && 'opacity-40',
        // 高亮画在最外层整行：右侧悬浮删除按钮所在区域也要有底色，否则视觉上断一块。
        // 底色自绘（对齐「AI」面板）：antd wrapper 的 hover 灰底会从两侧露出来
        active
          ? 'bg-primary/15 text-foreground'
          : 'text-muted-foreground hover:bg-foreground/5 hover:text-foreground'
      )}
      onClick={onOpen}
      title={`${protoLabel(request)} ${request.url}`}
    >
      {over && <DropLine after={after} />}
      <Dropdown
        trigger={['contextMenu']}
        menu={{
          items,
          onClick: ({ key }) => {
            if (key === 'open') onOpen()
            else if (key === 'moveout') onMoveOut()
            else onDelete()
          }
        }}
      >
        <div className={cn('flex min-w-0 flex-1 items-center gap-2', SIDEBAR_ROW_TRAIL_RESERVE.one)}>
          {isWs ? (
            <Cable className="size-3.5 shrink-0 opacity-70" />
          ) : (
            <Globe className="size-3.5 shrink-0 opacity-70" />
          )}
          <div className="flex min-w-0 flex-1 items-center gap-1.5">
            <span
              className={cn(
                'shrink-0 font-mono text-xs font-semibold leading-none',
                protoClass(request)
              )}
            >
              {protoLabel(request)}
            </span>
            <span className="truncate text-[13px] font-medium leading-none">
              {request.name.trim() || subtitleOf(request)}
            </span>
          </div>
        </div>
      </Dropdown>
      {/*
        「删除」绝对定位在行右侧、hover 整行才浮现。原来用 `invisible` 占位 ——
        它照常吃布局宽度，请求名全程被提前截断。
      */}
      <SidebarRowActions hoverClass="group-hover/req:pointer-events-auto group-hover/req:opacity-100">
        <Button
          type="text"
          size="small"
          icon={<Trash2 className="size-3.5 text-destructive" />}
          className="h-5 w-5 shrink-0 p-0 opacity-0 transition-opacity group-hover/req:opacity-100"
          title="删除请求"
          onClick={(e) => {
            e.stopPropagation()
            onDelete()
          }}
        />
      </SidebarRowActions>
    </div>
  )
}
