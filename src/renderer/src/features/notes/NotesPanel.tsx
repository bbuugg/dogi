import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, ChevronsLeft, FileText, FolderPlus, Pencil, Plus, Trash2 } from 'lucide-react'
import { useDrag, useDrop } from 'react-dnd'
import { Button, Checkbox, Dropdown, Input, Modal, Tree, message, type MenuProps, type TreeDataNode } from 'antd'
import { useAppStore } from '@/stores/app-store'
import { cn } from 'cn'
import type { NoteEntry, NoteGroup } from '@shared/types'

/** 树节点 key 前缀：g: 分组、n: 笔记 */
const GROUP_KEY_PREFIX = 'g:'
const NOTE_KEY_PREFIX = 'n:'

/** react-dnd 拖拽类型：笔记与分组各一种，落点按类型分别处理 */
const DND_NOTE = 'note-item'
const DND_GROUP = 'note-group'

/** 拖拽载荷：两种类型都只需要被拖对象的 id */
interface DragItem {
  id: string
}

/** 列表块：未分组块（group 为空）恒在首位，其余每块是一个分组 */
interface Block {
  group?: NoteGroup
  items: NoteEntry[]
}

const groupKey = (id: string): string => GROUP_KEY_PREFIX + id
const noteKey = (id: string): string => NOTE_KEY_PREFIX + id

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
 * 行的落点：接受「笔记」与「分组」两种拖拽。
 * 用指针落在行的上/下半区判定插入位置（after），行边缘画一条插入指示线。
 */
function useRowDrop<T extends HTMLElement>(opts: {
  /** 拖的是笔记时固定视为「追加到末尾」（拖到分组标题上 = 放进组尾） */
  appendWhenNoteDrag?: boolean
  canDrop?: (item: DragItem, type: string) => boolean
  drop: (item: DragItem, type: string, after: boolean) => void
}) {
  const { appendWhenNoteDrag, canDrop, drop } = opts
  const nodeRef = useRef<T | null>(null)
  /** 落点在上半区还是下半区：drop 时读取（不放进 deps，避免拖拽中反复重建 spec） */
  const afterRef = useRef(false)
  const [after, setAfter] = useState(false)

  const [{ over }, connectDrop] = useDrop<DragItem, void, { over: boolean }>(
    () => ({
      accept: [DND_NOTE, DND_GROUP],
      canDrop: (item, monitor) => (canDrop ? canDrop(item, String(monitor.getItemType())) : true),
      hover: (_item, monitor) => {
        const node = nodeRef.current
        const offset = monitor.getClientOffset()
        if (!node || !offset) return
        const rect = node.getBoundingClientRect()
        const next =
          appendWhenNoteDrag && String(monitor.getItemType()) === DND_NOTE
            ? true
            : offset.y > rect.top + rect.height / 2
        afterRef.current = next
        setAfter(next)
      },
      drop: (item, monitor) => drop(item, String(monitor.getItemType()), afterRef.current),
      collect: (m) => ({ over: m.isOver() && m.canDrop() })
    }),
    [appendWhenNoteDrag, canDrop, drop]
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
 * 笔记侧边栏：笔记按分组列出，支持搜索 / 新建 / 打开 / 删除。
 * 分组与拖拽与「主机」「接口请求」面板同一套模型（react-dnd + Block）：
 * 笔记可跨组拖动并调整顺序，分组可拖动排序，「未分组」的笔记平铺在最后。
 * 列表顺序就是存储顺序（不再按 updatedAt 排序）—— 否则拖完立刻被时间戳打乱。
 */
export function NotesPanel() {
  const notes = useAppStore((s) => s.notes)
  const noteGroups = useAppStore((s) => s.noteGroups)
  /** 当前激活组的激活标签 id（用于列表高亮） */
  const activeTabId = useAppStore((s) => {
    const gid = s.activeGroupId
    return gid ? (s.groups[gid]?.activeTabId ?? null) : null
  })
  const createNote = useAppStore((s) => s.createNote)
  const deleteNote = useAppStore((s) => s.deleteNote)
  const openNoteTab = useAppStore((s) => s.openNoteTab)
  const saveNoteGroup = useAppStore((s) => s.saveNoteGroup)
  const deleteNoteGroup = useAppStore((s) => s.deleteNoteGroup)
  const arrangeNotes = useAppStore((s) => s.arrangeNotes)

  const [search, setSearch] = useState('')
  const [pendingDelete, setPendingDelete] = useState<NoteEntry | null>(null)
  /** 待确认删除的分组 */
  const [pendingGroupDelete, setPendingGroupDelete] = useState<NoteGroup | null>(null)
  /** 删除分组时是否连同组内笔记一起删除（默认只解散分组） */
  const [deleteGroupNotes, setDeleteGroupNotes] = useState(false)
  /** 新建（id 为空）或重命名分组 */
  const [groupEdit, setGroupEdit] = useState<{ id?: string; name: string } | null>(null)

  const [expandedKeys, setExpandedKeys] = useState<string[]>([])
  /** 已自动展开过的分组 key：只在新分组出现时补展开，不覆盖用户的折叠操作 */
  const knownKeys = useRef<Set<string>>(new Set())

  useEffect(() => {
    const added = noteGroups.map((g) => groupKey(g.id)).filter((k) => !knownKeys.current.has(k))
    if (added.length === 0) return
    for (const k of added) knownKeys.current.add(k)
    setExpandedKeys((prev) => [...prev, ...added])
  }, [noteGroups])

  // 分组归类（groupId 指向已不存在的分组时按未分组处理），块顺序即显示顺序
  const blocks: Block[] = []
  const ungrouped: NoteEntry[] = []
  const byGroup = new Map<string, NoteEntry[]>()
  for (const n of notes) {
    if (n.groupId && noteGroups.some((g) => g.id === n.groupId)) {
      const list = byGroup.get(n.groupId) ?? []
      list.push(n)
      byGroup.set(n.groupId, list)
    } else {
      ungrouped.push(n)
    }
  }
  // 「未分组」块恒在首位（渲染时平铺到最后，见下面的 treeData）
  blocks.push({ group: undefined, items: ungrouped })
  for (const g of noteGroups) blocks.push({ group: g, items: byGroup.get(g.id) ?? [] })

  const q = search.trim().toLowerCase()
  const searching = q.length > 0
  const hitNote = (n: NoteEntry): boolean =>
    !searching || n.title.toLowerCase().includes(q) || n.content.toLowerCase().includes(q)

  /**
   * 渲染用的块结构：搜索时按命中过滤（组名命中 = 整组保留）。
   * 拖拽的落点计算一律走**完整的** blocks —— 按 id 定位，所以即便列表被过滤，
   * 笔记也会准确落到目标行旁边，隐藏的行不会被丢掉或被打乱顺序。
   */
  const viewBlocks: Block[] = !searching
    ? blocks
    : blocks
        .map((b) => {
          const groupHit = b.group ? b.group.name.toLowerCase().includes(q) : false
          return { group: b.group, items: groupHit ? b.items : b.items.filter(hitNote) }
        })
        .filter((b) => b.items.length > 0 || (b.group && b.group.name.toLowerCase().includes(q)))

  const locate = (list: Block[], id: string): { b: number; i: number } | null => {
    for (let b = 0; b < list.length; b++) {
      const i = list[b].items.findIndex((n) => n.id === id)
      if (i >= 0) return { b, i }
    }
    return null
  }

  /** 把调整后的块结构整体写回（顺序与归属一次提交，避免中间态） */
  const commit = (next: Block[]) => {
    void arrangeNotes({
      groupIds: next.filter((b) => b.group).map((b) => b.group!.id),
      notes: next.flatMap((b) => b.items.map((n) => ({ id: n.id, groupId: b.group?.id })))
    })
  }

  /** 笔记拖拽落点：插到目标笔记前/后；targetId 为空时追加到目标分组末尾 */
  const dropNote = (
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

  /** 分组拖拽落点：移到目标分组的前/后（组内笔记跟着一起走） */
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

  /** 新建：先落盘再打开标签（一篇笔记 = 一个标签，不存在未保存的草稿标签） */
  const handleCreate = async (groupId?: string) => {
    try {
      const id = await createNote(groupId)
      if (id) openNoteTab(id)
    } catch (e) {
      message.error(`新建失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const confirmDelete = async () => {
    const target = pendingDelete
    if (!target) return
    setPendingDelete(null)
    try {
      await deleteNote(target.id)
      message.success('已删除该笔记')
    } catch (e) {
      message.error(`删除失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const submitGroupEdit = async () => {
    const name = groupEdit?.name.trim()
    if (!name) return
    try {
      await saveNoteGroup({ id: groupEdit?.id, name })
      setGroupEdit(null)
    } catch (e) {
      message.error(`保存分组失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  /** 待删除分组内的笔记数量（用于确认框的文案与勾选项） */
  const groupNoteCount = pendingGroupDelete
    ? notes.filter((n) => n.groupId === pendingGroupDelete.id).length
    : 0

  const confirmGroupDelete = async () => {
    const target = pendingGroupDelete
    if (!target) return
    const alsoNotes = deleteGroupNotes
    setPendingGroupDelete(null)
    setDeleteGroupNotes(false)
    try {
      await deleteNoteGroup(target.id, alsoNotes)
      message.success(
        `已删除分组「${target.name}」：${alsoNotes ? '组内笔记已一并删除' : '组内笔记已移到「未分组」'}`
      )
    } catch (e) {
      message.error(`删除分组失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  /** 把一篇笔记移出到「未分组」：只改该笔记的归属，保持其它顺序不变 */
  const moveOutOfGroup = (note: NoteEntry) => {
    void arrangeNotes({
      groupIds: noteGroups.map((g) => g.id),
      notes: notes.map((n) => ({ id: n.id, groupId: n.id === note.id ? undefined : n.groupId }))
    })
  }

  const noteNode = (n: NoteEntry, hasGroup: boolean): TreeDataNode => ({
    key: noteKey(n.id),
    title: (
      <NoteRow
        note={n}
        hasGroup={hasGroup}
        active={activeTabId === `note-${n.id}`}
        onOpen={() => openNoteTab(n.id)}
        onMoveOut={() => moveOutOfGroup(n)}
        onDelete={() => setPendingDelete(n)}
        onDropNote={dropNote}
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
            onDropNote={dropNote}
            onDropGroup={dropGroup}
            onNew={() => void handleCreate(group.id)}
            onRename={() => setGroupEdit({ id: group.id, name: group.name })}
            onDelete={() => {
              setDeleteGroupNotes(false)
              setPendingGroupDelete(group)
            }}
          />
        ),
        children: isEmpty ? undefined : b.items.map((n) => noteNode(n, true))
      }
    })

  // 分组在前，未分组的笔记平铺在最后（不另设「未分组」折叠组）
  const treeData: TreeDataNode[] = [...groupNodes]
  const viewUngrouped = viewBlocks.find((b) => !b.group)?.items ?? []
  treeData.push(...viewUngrouped.map((n) => noteNode(n, false)))

  /** 搜索时把命中的分组全部展开（否则要逐个点开才看得到结果） */
  const effectiveExpanded = searching ? groupNodes.map((n) => String(n.key)) : expandedKeys

  const isEmpty = notes.length === 0 && noteGroups.length === 0
  const noMatch = searching && treeData.length === 0

  return (
    <div className="flex h-full flex-col">
      {/* 笔记（左侧 tab 名 + 右侧新建分组 / 新建，与「主机」面板同款） */}
      <div className="mb-1 flex items-center justify-between gap-1 px-3 py-2">
        <span className="text-sm font-medium text-muted-foreground">笔记 ({notes.length})</span>
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
            title="新建笔记"
            icon={<Plus className="size-3.5" />}
            onClick={() => void handleCreate()}
          />
        </div>
      </div>

      <div className="px-3 pb-2">
        <Input
          placeholder="搜索笔记…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          allowClear
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {isEmpty ? (
          <div className="mx-2 mt-8 rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
            还没有笔记。
            <br />
            点击右上角 + 新建，或新建分组归类。
          </div>
        ) : noMatch ? (
          <div className="mx-2 mt-8 rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
            没有匹配「{search}」的笔记。
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
          placeholder="分组名称，如：周报"
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
          {groupNoteCount > 0 ? `，组内共 ${groupNoteCount} 篇笔记。` : '。'}
        </p>
        {groupNoteCount > 0 && (
          <Checkbox
            className="mt-3"
            checked={deleteGroupNotes}
            onChange={(e) => setDeleteGroupNotes(e.target.checked)}
          >
            <span className="text-sm">同时删除组内的笔记</span>
          </Checkbox>
        )}
        <p className="mt-2 text-xs text-muted-foreground">
          {deleteGroupNotes
            ? '组内笔记将一并删除，该操作不可撤销。'
            : '不勾选时，组内笔记会移到「未分组」。'}
        </p>
      </Modal>

      {/* 删除确认 */}
      <Modal
        open={pendingDelete !== null}
        onCancel={() => setPendingDelete(null)}
        title="删除笔记？"
        okText="删除"
        cancelText="取消"
        okButtonProps={{ danger: true }}
        onOk={() => void confirmDelete()}
        centered
        width={420}
        destroyOnHidden
      >
        <p className="text-sm text-muted-foreground">
          「{pendingDelete?.title}」将被永久删除，该操作不可撤销。
        </p>
      </Modal>
    </div>
  )
}

/** 拖拽落点处理函数签名（笔记与分组共用，由面板统一重排后一次写回） */
type DropNote = (
  dragId: string,
  targetId: string | null,
  targetGroupId: string | undefined,
  after: boolean
) => void
type DropGroup = (dragId: string, targetGroupId: string, after: boolean) => void

/** 分组行：可拖动排序，也可接收笔记（追加进组）；右键可重命名 / 删除 */
function GroupRow({
  expanded,
  group,
  count,
  onToggle,
  onDropNote,
  onDropGroup,
  onNew,
  onRename,
  onDelete
}: {
  /** 当前是否为展开状态（决定箭头方向） */
  expanded: boolean
  group: NoteGroup
  count: number
  /** 点击整行切换展开/折叠 */
  onToggle: () => void
  onDropNote: DropNote
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
    // 拖笔记落在分组标题上 = 放进组尾
    appendWhenNoteDrag: true,
    canDrop: (item, type) => type === DND_NOTE || item.id !== group.id,
    drop: (item, type, at) => {
      if (type === DND_GROUP) onDropGroup(item.id, group.id, at)
      else onDropNote(item.id, null, group.id, true)
    }
  })

  const dragRef = useMemo(() => asRef<HTMLDivElement>(drag), [drag])
  const ref = useMemo(() => mergeRefs(dropRef, dragRef), [dropRef, dragRef])

  const items: MenuProps['items'] = [
    { key: 'new', icon: <Plus className="size-3.5" />, label: '在此分组新建笔记' },
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
            title="在此分组新建笔记"
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

/** 笔记行：可拖动排序 / 跨组；点击打开，右键打开 / 移出分组 / 删除 */
function NoteRow({
  note,
  hasGroup,
  active,
  onOpen,
  onMoveOut,
  onDelete,
  onDropNote,
  onDropGroup
}: {
  note: NoteEntry
  /** 所在分组真实存在（决定能否用本行作为分组排序的落点） */
  hasGroup: boolean
  /** 是否为当前打开的标签（列表高亮） */
  active: boolean
  onOpen: () => void
  /** 移出到「未分组」（仅分组内笔记显示） */
  onMoveOut: () => void
  onDelete: () => void
  onDropNote: DropNote
  onDropGroup: DropGroup
}) {
  const [{ isDragging }, drag] = useDrag<DragItem, void, { isDragging: boolean }>(
    () => ({
      type: DND_NOTE,
      item: { id: note.id },
      collect: (m) => ({ isDragging: m.isDragging() })
    }),
    [note.id]
  )

  const { ref: dropRef, over, after } = useRowDrop<HTMLDivElement>({
    canDrop: (item, type) =>
      type === DND_GROUP ? hasGroup && item.id !== note.groupId : item.id !== note.id,
    drop: (item, type, at) => {
      if (type === DND_GROUP) onDropGroup(item.id, note.groupId!, at)
      else onDropNote(item.id, note.id, note.groupId, at)
    }
  })

  const dragRef = useMemo(() => asRef<HTMLDivElement>(drag), [drag])
  const ref = useMemo(() => mergeRefs(dropRef, dragRef), [dropRef, dragRef])

  const items: MenuProps['items'] = [
    { key: 'open', icon: <FileText className="size-3.5" />, label: '打开' },
    // 分组内笔记才提供「移出分组」，作为移出分组的入口
    ...(note.groupId
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
        'group/note relative flex min-w-0 flex-1 cursor-pointer items-start gap-2 rounded px-1 py-1',
        isDragging && 'opacity-40',
        // 高亮画在最外层整行：右侧悬浮删除按钮所在区域也要有底色，否则视觉上断一块
        active ? 'bg-primary/10 text-foreground' : 'text-muted-foreground'
      )}
      onClick={onOpen}
      title={note.title}
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
        <div className="flex min-w-0 flex-1 items-start gap-2">
          <FileText className="mt-0.5 size-3.5 shrink-0 opacity-70" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-medium">{note.title}</div>
          </div>
        </div>
      </Dropdown>
      <Button
        type="text"
        size="small"
        icon={<Trash2 className="size-3.5 text-destructive" />}
        className="invisible mt-0.5 h-5 w-5 shrink-0 p-0 group-hover/note:visible"
        title="删除笔记"
        onClick={(e) => {
          e.stopPropagation()
          onDelete()
        }}
      />
    </div>
  )
}
