import { useAppStore } from '@/stores/app-store'
import type { ScriptEntry, ScriptGroup } from '@shared/types'
import { Button, Checkbox, Dropdown, Input, Modal, Tree, message, type MenuProps, type TreeDataNode } from 'antd'
import { cn } from 'cn'
import { ChevronDown, ChevronRight, ChevronsLeft, FileCode2, FolderPlus, Pencil, Play, Plus, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useDrag, useDrop } from 'react-dnd'

/** 树节点 key 前缀：g: 分组、s: 脚本 */
const GROUP_KEY_PREFIX = 'g:'
const SCRIPT_KEY_PREFIX = 's:'

/** react-dnd 拖拽类型：脚本与分组各一种，落点按类型分别处理 */
const DND_SCRIPT = 'script-item'
const DND_GROUP = 'script-group'

/** 拖拽载荷：两种类型都只需要被拖对象的 id */
interface DragItem {
  id: string
}

/** 列表块：未分组块（group 为空）恒在首位，其余每块是一个分组 */
interface Block {
  group?: ScriptGroup
  items: ScriptEntry[]
}

const groupKey = (id: string): string => GROUP_KEY_PREFIX + id
const scriptKey = (id: string): string => SCRIPT_KEY_PREFIX + id

/**
 * react-dnd 的连接器签名是 `(node) => ReactElement | null`，与 React 的 ref 回调
 * （返回 void 或清理函数）不兼容，这里显式转成 ref 回调。
 * 必须配合 useMemo 使用：每次渲染新建 ref 会导致 React 卸载/重挂节点，拖拽中途断链。
 */
function asRef<T extends HTMLElement>(connect: unknown) {
  return (node: T | null): void => {
    ;(connect as (el: T | null) => void)(node)
  }
}

/** 同一个节点既要拖拽又要接掉落：合并两个 ref 回调 */
function mergeRefs<T extends HTMLElement>(a: (node: T | null) => void, b: (node: T | null) => void) {
  return (node: T | null): void => {
    a(node)
    b(node)
  }
}

/**
 * 行的落点：接受「脚本」与「分组」两种拖拽。
 * 用指针落在行的上/下半区判定插入位置（after），行边缘画一条插入指示线。
 */
function useRowDrop<T extends HTMLElement>(opts: {
  /** 拖的是脚本时固定视为「追加到末尾」（拖到分组标题上 = 放进组尾） */
  appendWhenScriptDrag?: boolean
  canDrop?: (item: DragItem, type: string) => boolean
  drop: (item: DragItem, type: string, after: boolean) => void
}) {
  const { appendWhenScriptDrag, canDrop, drop } = opts
  const nodeRef = useRef<T | null>(null)
  /** 落点在上半区还是下半区：drop 时读取（不放进 deps，避免拖拽中反复重建 spec） */
  const afterRef = useRef(false)
  const [after, setAfter] = useState(false)

  const [{ over }, connectDrop] = useDrop<DragItem, void, { over: boolean }>(
    () => ({
      accept: [DND_SCRIPT, DND_GROUP],
      canDrop: (item, monitor) => (canDrop ? canDrop(item, String(monitor.getItemType())) : true),
      hover: (_item, monitor) => {
        const node = nodeRef.current
        const offset = monitor.getClientOffset()
        if (!node || !offset) return
        const rect = node.getBoundingClientRect()
        const next =
          appendWhenScriptDrag && String(monitor.getItemType()) === DND_SCRIPT
            ? true
            : offset.y > rect.top + rect.height / 2
        afterRef.current = next
        setAfter(next)
      },
      drop: (item, monitor) => drop(item, String(monitor.getItemType()), afterRef.current),
      collect: (m) => ({ over: m.isOver() && m.canDrop() })
    }),
    [appendWhenScriptDrag, canDrop, drop]
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
function DropLine({ after }: { after: boolean }) {
  return (
    <span
      className={cn(
        'pointer-events-none absolute inset-x-0 h-0.5 rounded bg-primary',
        after ? '-bottom-px' : '-top-px'
      )}
    />
  )
}

/**
 * 脚本侧边栏：脚本按分组列出，支持搜索 / 新建 / 打开 / 删除 / 直接运行。
 * 分组与拖拽与「主机」「接口请求」「笔记」面板同一套模型（react-dnd + Block）：
 * 脚本可跨组拖动并调整顺序，分组可拖动排序，「未分组」的脚本平铺在最后。
 * 列表顺序就是存储顺序（不再按 updatedAt 排序）—— 否则拖完立刻被时间戳打乱。
 */
export function ScriptsPanel() {
  const scripts = useAppStore((s) => s.scripts)
  const scriptGroups = useAppStore((s) => s.scriptGroups)
  /** 当前激活组的激活标签 id（用于列表高亮） */
  const activeTabId = useAppStore((s) => {
    const gid = s.activeGroupId
    return gid ? (s.groups[gid]?.activeTabId ?? null) : null
  })
  const refreshScripts = useAppStore((s) => s.refreshScripts)
  const deleteScript = useAppStore((s) => s.deleteScript)
  const openScriptTab = useAppStore((s) => s.openScriptTab)
  const setRunScriptDialog = useAppStore((s) => s.setRunScriptDialog)
  const saveScriptGroup = useAppStore((s) => s.saveScriptGroup)
  const deleteScriptGroup = useAppStore((s) => s.deleteScriptGroup)
  const arrangeScripts = useAppStore((s) => s.arrangeScripts)

  const [search, setSearch] = useState('')
  const [pendingDelete, setPendingDelete] = useState<ScriptEntry | null>(null)
  /** 待确认删除的分组 */
  const [pendingGroupDelete, setPendingGroupDelete] = useState<ScriptGroup | null>(null)
  /** 删除分组时是否连同组内脚本一起删除（默认只解散分组） */
  const [deleteGroupScripts, setDeleteGroupScripts] = useState(false)
  /** 新建（id 为空）或重命名分组 */
  const [groupEdit, setGroupEdit] = useState<{ id?: string; name: string } | null>(null)

  const [expandedKeys, setExpandedKeys] = useState<string[]>([])
  /** 已自动展开过的分组 key：只在新分组出现时补展开，不覆盖用户的折叠操作 */
  const knownKeys = useRef<Set<string>>(new Set())

  useEffect(() => {
    const added = scriptGroups.map((g) => groupKey(g.id)).filter((k) => !knownKeys.current.has(k))
    if (added.length === 0) return
    for (const k of added) knownKeys.current.add(k)
    setExpandedKeys((prev) => [...prev, ...added])
  }, [scriptGroups])

  // 分组归类（groupId 指向已不存在的分组时按未分组处理），块顺序即显示顺序
  const blocks: Block[] = []
  const ungrouped: ScriptEntry[] = []
  const byGroup = new Map<string, ScriptEntry[]>()
  for (const s of scripts) {
    if (s.groupId && scriptGroups.some((g) => g.id === s.groupId)) {
      const list = byGroup.get(s.groupId) ?? []
      list.push(s)
      byGroup.set(s.groupId, list)
    } else {
      ungrouped.push(s)
    }
  }
  // 「未分组」块恒在首位（渲染时平铺到最后，见下面的 treeData）
  blocks.push({ group: undefined, items: ungrouped })
  for (const g of scriptGroups) blocks.push({ group: g, items: byGroup.get(g.id) ?? [] })

  const q = search.trim().toLowerCase()
  const searching = q.length > 0
  const hitScript = (s: ScriptEntry): boolean =>
    !searching ||
    s.name.toLowerCase().includes(q) ||
    (s.description ?? '').toLowerCase().includes(q) ||
    s.content.toLowerCase().includes(q)

  /**
   * 渲染用的块结构：搜索时按命中过滤（组名命中 = 整组保留）。
   * 拖拽的落点计算一律走**完整的** blocks —— 按 id 定位，所以即便列表被过滤，
   * 脚本也会准确落到目标行旁边，隐藏的行不会被丢掉或被打乱顺序。
   */
  const viewBlocks: Block[] = !searching
    ? blocks
    : blocks
        .map((b) => {
          const groupHit = b.group ? b.group.name.toLowerCase().includes(q) : false
          return { group: b.group, items: groupHit ? b.items : b.items.filter(hitScript) }
        })
        .filter((b) => b.items.length > 0 || (b.group && b.group.name.toLowerCase().includes(q)))

  const locate = (list: Block[], id: string): { b: number; i: number } | null => {
    for (let b = 0; b < list.length; b++) {
      const i = list[b].items.findIndex((s) => s.id === id)
      if (i >= 0) return { b, i }
    }
    return null
  }

  /** 把调整后的块结构整体写回（顺序与归属一次提交，避免中间态） */
  const commit = (next: Block[]) => {
    void arrangeScripts({
      groupIds: next.filter((b) => b.group).map((b) => b.group!.id),
      scripts: next.flatMap((b) => b.items.map((s) => ({ id: s.id, groupId: b.group?.id })))
    })
  }

  /** 脚本拖拽落点：插到目标脚本前/后；targetId 为空时追加到目标分组末尾 */
  const dropScript = (
    dragId: string,
    targetId: string | null,
    targetGroupId: string | undefined,
    after: boolean
  ) => {
    const next = blocks.map((b) => ({ group: b.group, items: [...b.items] }))
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
    const blk = next.findIndex((b) => b.group?.id === targetGroupId)
    if (blk < 0) return
    next[blk].items.push(moved)
    commit(next)
  }

  /** 分组拖拽落点：移到目标分组的前/后（组内脚本跟着一起走） */
  const dropGroup = (dragId: string, targetGroupId: string, after: boolean) => {
    const next = blocks.map((b) => ({ group: b.group, items: b.items }))
    const from = next.findIndex((b) => b.group?.id === dragId)
    if (from < 0) return
    const [moved] = next.splice(from, 1)
    let to = next.findIndex((b) => b.group?.id === targetGroupId)
    if (to < 0) return
    if (after) to += 1
    // 「未分组」块固定首位：分组不能落到它前面
    const firstGroup = next.findIndex((b) => b.group)
    if (firstGroup >= 0 && to < firstGroup) to = firstGroup
    next.splice(to, 0, moved)
    commit(next)
  }

  /** 点击分组行整行切换展开/折叠 */
  const toggleKey = (key: string) => {
    setExpandedKeys((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]))
  }

  /** 新建脚本（groupId 用于「在某分组内新建」）；先落盘再打开标签 */
  const handleCreate = async (groupId?: string) => {
    try {
      const prevIds = new Set(scripts.map((sc) => sc.id))
      const list = await window.api.scripts.save({
        id: '',
        name: '未命名脚本',
        content: '',
        groupId,
        createdAt: 0,
        updatedAt: 0
      })
      const created = list.find((sc) => !prevIds.has(sc.id))
      if (created) {
        await refreshScripts()
        openScriptTab(created.id)
      }
    } catch (e) {
      message.error(`新建失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const confirmDelete = async () => {
    const target = pendingDelete
    if (!target) return
    setPendingDelete(null)
    try {
      await deleteScript(target.id)
      message.success(`已删除「${target.name}」`)
    } catch (e) {
      message.error(`删除失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const submitGroupEdit = async () => {
    const name = groupEdit?.name.trim()
    if (!name) return
    try {
      await saveScriptGroup({ id: groupEdit?.id, name })
      setGroupEdit(null)
    } catch (e) {
      message.error(`保存分组失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  /** 待删除分组内的脚本数量（用于确认框的文案与勾选项） */
  const groupScriptCount = pendingGroupDelete
    ? scripts.filter((s) => s.groupId === pendingGroupDelete.id).length
    : 0

  const confirmGroupDelete = async () => {
    const target = pendingGroupDelete
    if (!target) return
    const alsoScripts = deleteGroupScripts
    setPendingGroupDelete(null)
    setDeleteGroupScripts(false)
    try {
      await deleteScriptGroup(target.id, alsoScripts)
      message.success(
        `已删除分组「${target.name}」：${alsoScripts ? '组内脚本已一并删除' : '组内脚本已移到「未分组」'}`
      )
    } catch (e) {
      message.error(`删除分组失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  /** 把一个脚本移出到「未分组」：只改该脚本的归属，保持其它顺序不变 */
  const moveOutOfGroup = (script: ScriptEntry) => {
    void arrangeScripts({
      groupIds: scriptGroups.map((g) => g.id),
      scripts: scripts.map((s) => ({ id: s.id, groupId: s.id === script.id ? undefined : s.groupId }))
    })
  }

  const scriptNode = (s: ScriptEntry, hasGroup: boolean): TreeDataNode => ({
    key: scriptKey(s.id),
    title: (
      <ScriptRow
        script={s}
        hasGroup={hasGroup}
        active={activeTabId === `script-${s.id}`}
        onOpen={() => openScriptTab(s.id)}
        onRun={() => setRunScriptDialog(true, s.id)}
        onMoveOut={() => moveOutOfGroup(s)}
        onDelete={() => setPendingDelete(s)}
        onDropScript={dropScript}
        onDropGroup={dropGroup}
      />
    )
  })

  const groupNodes: TreeDataNode[] = viewBlocks
    .filter((b) => b.group)
    .map((b) => {
      const group = b.group!
      // 计数与「是否空组」都按**完整**分组算：搜索过滤掉几行不该改变分组的规模
      const count = blocks.find((x) => x.group?.id === group.id)?.items.length ?? 0
      // 空分组不参与展开/折叠：不挂子节点、点击无效，避免空展开触发布局抖动
      const isEmpty = count === 0
      return {
        key: groupKey(group.id),
        title: (
          <GroupRow
            expanded={isEmpty ? false : expandedKeys.includes(groupKey(group.id))}
            group={group}
            count={count}
            onToggle={isEmpty ? () => {} : () => toggleKey(groupKey(group.id))}
            onDropScript={dropScript}
            onDropGroup={dropGroup}
            onNew={() => void handleCreate(group.id)}
            onRename={() => setGroupEdit({ id: group.id, name: group.name })}
            onDelete={() => {
              setDeleteGroupScripts(false)
              setPendingGroupDelete(group)
            }}
          />
        ),
        children: isEmpty ? undefined : b.items.map((s) => scriptNode(s, true))
      }
    })

  // 分组在前，未分组的脚本平铺在最后（不另设「未分组」折叠组）
  const treeData: TreeDataNode[] = [...groupNodes]
  const viewUngrouped = viewBlocks.find((b) => !b.group)?.items ?? []
  treeData.push(...viewUngrouped.map((s) => scriptNode(s, false)))

  /** 搜索时把命中的分组全部展开（否则要逐个点开才看得到结果） */
  const effectiveExpanded = searching ? groupNodes.map((n) => String(n.key)) : expandedKeys

  const isEmpty = scripts.length === 0 && scriptGroups.length === 0
  const noMatch = searching && treeData.length === 0

  return (
    <div className="flex h-full flex-col">
      {/* 脚本（左侧 tab 名 + 右侧新建分组 / 新建，与「主机」面板同款） */}
      <div className="mb-1 flex items-center justify-between gap-1 px-3 py-2">
        <span className="text-sm font-medium text-muted-foreground">脚本 ({scripts.length})</span>
        <div className="flex items-center gap-1">
          <Button
            type="text"
            size="small"
            className="px-0.5 text-muted-foreground"
            title="新建分组"
            icon={<FolderPlus className="size-3.5" />}
            onClick={() => setGroupEdit({ name: '' })}
          />
          <Button
            type="text"
            size="small"
            className="px-0.5 text-muted-foreground"
            title="新建脚本"
            icon={<Plus className="size-3.5" />}
            onClick={() => void handleCreate()}
          />
        </div>
      </div>

      <div className="px-3 pb-2">
        <Input
          placeholder="搜索脚本…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          allowClear
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {isEmpty ? (
          <div className="mx-2 mt-8 rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
            还没有脚本。
            <br />
            点击右上角 + 新建，或新建分组归类。
          </div>
        ) : noMatch ? (
          <div className="mx-2 mt-8 rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
            没有匹配「{search}」的脚本。
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

      {/* 新建 / 重命名分组 */}
      <Modal
        open={groupEdit !== null}
        onCancel={() => setGroupEdit(null)}
        title={groupEdit?.id ? '重命名分组' : '新建分组'}
        okText="保存"
        cancelText="取消"
        centered
        width={400}
        destroyOnHidden
        okButtonProps={{ disabled: !groupEdit?.name.trim() }}
        onOk={() => void submitGroupEdit()}
      >
        <Input
          autoFocus
          placeholder="分组名称，如：部署脚本"
          value={groupEdit?.name ?? ''}
          onChange={(e) => setGroupEdit((g) => (g ? { ...g, name: e.target.value } : g))}
          onPressEnter={() => void submitGroupEdit()}
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
          「{pendingGroupDelete?.name}」将被删除
          {groupScriptCount > 0 ? `，组内共 ${groupScriptCount} 个脚本。` : '。'}
        </p>
        {groupScriptCount > 0 && (
          <Checkbox
            className="mt-3"
            checked={deleteGroupScripts}
            onChange={(e) => setDeleteGroupScripts(e.target.checked)}
          >
            <span className="text-sm">同时删除组内的脚本</span>
          </Checkbox>
        )}
        <p className="mt-2 text-xs text-muted-foreground">
          {deleteGroupScripts
            ? '组内脚本将一并删除，该操作不可撤销。'
            : '不勾选时，组内脚本会移到「未分组」。'}
        </p>
      </Modal>

      {/* 删除确认 */}
      <Modal
        open={pendingDelete !== null}
        onCancel={() => setPendingDelete(null)}
        title="删除脚本？"
        okText="删除"
        cancelText="取消"
        okButtonProps={{ danger: true }}
        onOk={() => void confirmDelete()}
        centered
        width={420}
        destroyOnHidden
      >
        <p className="text-sm text-muted-foreground">
          「{pendingDelete?.name}」将被永久删除，该操作不可撤销。
        </p>
      </Modal>
    </div>
  )
}

/** 拖拽落点处理函数签名（脚本与分组共用，由面板统一重排后一次写回） */
type DropScript = (
  dragId: string,
  targetId: string | null,
  targetGroupId: string | undefined,
  after: boolean
) => void
type DropGroup = (dragId: string, targetGroupId: string, after: boolean) => void

/** 分组行：可拖动排序，也可接收脚本（追加进组）；右键可重命名 / 删除 */
function GroupRow({
  expanded,
  group,
  count,
  onToggle,
  onDropScript,
  onDropGroup,
  onNew,
  onRename,
  onDelete
}: {
  /** 当前是否为展开状态（决定箭头方向） */
  expanded: boolean
  group: ScriptGroup
  count: number
  /** 点击整行切换展开/折叠 */
  onToggle: () => void
  onDropScript: DropScript
  onDropGroup: DropGroup
  onNew: () => void
  onRename: () => void
  onDelete: () => void
}) {
  const [{ isDragging }, drag] = useDrag<DragItem, void, { isDragging: boolean }>(
    () => ({
      type: DND_GROUP,
      item: { id: group.id },
      collect: (m) => ({ isDragging: m.isDragging() })
    }),
    [group.id]
  )

  const { ref: dropRef, over, after } = useRowDrop<HTMLDivElement>({
    // 拖脚本落在分组标题上 = 放进组尾
    appendWhenScriptDrag: true,
    canDrop: (item, type) => type === DND_SCRIPT || item.id !== group.id,
    drop: (item, type, at) => {
      if (type === DND_GROUP) onDropGroup(item.id, group.id, at)
      else onDropScript(item.id, null, group.id, true)
    }
  })

  const dragRef = useMemo(() => asRef<HTMLDivElement>(drag), [drag])
  const ref = useMemo(() => mergeRefs(dropRef, dragRef), [dropRef, dragRef])

  const items: MenuProps['items'] = [
    { key: 'new', icon: <Plus className="size-3.5" />, label: '在此分组新建脚本' },
    { key: 'rename', icon: <Pencil className="size-3.5" />, label: '重命名' },
    { type: 'divider' },
    { key: 'delete', icon: <Trash2 className="size-3.5" />, label: '删除分组', danger: true }
  ]

  // 拖拽 ref 放在最外层：antd Dropdown 会给子节点合并自己的 ref（React 19 下 element.ref 已变更），
  // 让 Dropdown 只包住内容，dnd 的连接器才不会被覆盖
  return (
    <div
      ref={ref}
      className={cn(
        'group/grp relative flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 pr-1',
        isDragging && 'opacity-40'
      )}
      onClick={onToggle}
      title="点击展开/折叠（可拖动排序）"
    >
      {over && <DropLine after={after} />}
      <Dropdown
        trigger={['contextMenu']}
        menu={{
          items,
          onClick: ({ key }) => {
            if (key === 'new') onNew()
            else if (key === 'rename') onRename()
            else onDelete()
          }
        }}
      >
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          {expanded ? (
            <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
          )}
          <span className="truncate text-sm font-medium text-muted-foreground">{group.name}</span>
          <span className="text-xs text-muted-foreground/70">{count}</span>
          <Button
            type="text"
            size="small"
            className="ml-auto px-1 opacity-0 transition-opacity group-hover/grp:opacity-100"
            title="在此分组新建脚本"
            icon={<Plus className="size-3.5" />}
            onClick={(e) => {
              e.stopPropagation()
              onNew()
            }}
          />
        </div>
      </Dropdown>
    </div>
  )
}

/** 脚本行：可拖动排序 / 跨组；点击打开，右键打开 / 运行 / 移出分组 / 删除 */
function ScriptRow({
  script,
  hasGroup,
  active,
  onOpen,
  onRun,
  onMoveOut,
  onDelete,
  onDropScript,
  onDropGroup
}: {
  script: ScriptEntry
  /** 所在分组真实存在（决定能否用本行作为分组排序的落点） */
  hasGroup: boolean
  /** 是否为当前打开的标签（列表高亮） */
  active: boolean
  onOpen: () => void
  /** 直接运行该脚本（打开运行对话框并预选它） */
  onRun: () => void
  /** 移出到「未分组」（仅分组内脚本显示） */
  onMoveOut: () => void
  onDelete: () => void
  onDropScript: DropScript
  onDropGroup: DropGroup
}) {
  const [{ isDragging }, drag] = useDrag<DragItem, void, { isDragging: boolean }>(
    () => ({
      type: DND_SCRIPT,
      item: { id: script.id },
      collect: (m) => ({ isDragging: m.isDragging() })
    }),
    [script.id]
  )

  const { ref: dropRef, over, after } = useRowDrop<HTMLDivElement>({
    canDrop: (item, type) =>
      type === DND_GROUP ? hasGroup && item.id !== script.groupId : item.id !== script.id,
    drop: (item, type, at) => {
      if (type === DND_GROUP) onDropGroup(item.id, script.groupId!, at)
      else onDropScript(item.id, script.id, script.groupId, at)
    }
  })

  const dragRef = useMemo(() => asRef<HTMLDivElement>(drag), [drag])
  const ref = useMemo(() => mergeRefs(dropRef, dragRef), [dropRef, dragRef])

  const items: MenuProps['items'] = [
    { key: 'open', icon: <FileCode2 className="size-3.5" />, label: '打开' },
    { key: 'run', icon: <Play className="size-3.5" />, label: '运行' },
    // 分组内脚本才提供「移出分组」，作为移出分组的入口
    ...(script.groupId
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
        'group/scri relative flex min-w-0 flex-1 cursor-pointer items-start gap-2 rounded pr-1',
        isDragging && 'opacity-40'
      )}
      onClick={onOpen}
      title={script.name}
    >
      {over && <DropLine after={after} />}
      <Dropdown
        trigger={['contextMenu']}
        menu={{
          items,
          onClick: ({ key }) => {
            if (key === 'open') onOpen()
            else if (key === 'run') onRun()
            else if (key === 'moveout') onMoveOut()
            else onDelete()
          }
        }}
      >
        <div
          className={cn(
            'flex min-w-0 flex-1 items-start gap-2 rounded px-1 py-1',
            active ? 'bg-primary/10 text-foreground' : 'text-muted-foreground'
          )}
        >
          <FileCode2 className="mt-0.5 size-3.5 shrink-0 opacity-70" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-medium">{script.name}</div>
          </div>
        </div>
      </Dropdown>
      <div className="invisible flex shrink-0 items-center gap-0.5 group-hover/scri:visible">
        <Button
          type="text"
          size="small"
          icon={<Play className="size-3.5" />}
          className="h-5 w-5 p-0"
          title="运行脚本"
          onClick={(e) => {
            e.stopPropagation()
            onRun()
          }}
        />
        <Button
          type="text"
          size="small"
          icon={<Trash2 className="size-3.5 text-destructive" />}
          className="h-5 w-5 p-0"
          title="删除脚本"
          onClick={(e) => {
            e.stopPropagation()
            onDelete()
          }}
        />
      </div>
    </div>
  )
}
