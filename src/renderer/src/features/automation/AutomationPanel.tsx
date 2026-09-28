import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronsLeft, FileCode2, FolderPlus, Pencil, Plus, Trash2 } from 'lucide-react'
import { useDrag } from 'react-dnd'
import {
  Button,
  Checkbox,
  Dropdown,
  Input,
  Modal,
  Tree,
  message,
  type MenuProps,
  type TreeDataNode
} from 'antd'
import { useAppStore } from '@/stores/app-store'
import { cn } from 'cn'
import { SidebarGroupRow } from '@/shared/components/SidebarGroupRow'
import {
  asRef,
  DropLine,
  mergeRefs,
  useRowDrop,
  type RowDragItem
} from '@/shared/components/SidebarRowDnd'
import type { AutomationGroup, AutomationScript } from '@shared/types'

/** 树节点 key 前缀：g: 分组、s: 脚本 */
const GROUP_KEY_PREFIX = 'g:'
const SCRIPT_KEY_PREFIX = 's:'

const DND_SCRIPT = 'automation-script'
const DND_GROUP = 'automation-group'

/** 列表块：未分组块（group 为空）恒在首位，其余每块是一个分组 */
interface Block {
  group?: AutomationGroup
  items: AutomationScript[]
}

const groupKey = (id: string): string => GROUP_KEY_PREFIX + id
const scriptKey = (id: string): string => SCRIPT_KEY_PREFIX + id

/**
 * 自动化侧边栏：脚本按分组列出，支持搜索 / 新建 / 打开 / 删除。
 *
 * 分组与拖拽与「笔记」「接口请求」面板同一套模型（react-dnd + Block），
 * 列表顺序就是存储顺序 —— 否则拖完立刻被 updatedAt 打乱。
 */
export function AutomationPanel() {
  const scripts = useAppStore((s) => s.automationScripts)
  const groups = useAppStore((s) => s.automationGroups)
  const activeTabId = useAppStore((s) => {
    const gid = s.activeGroupId
    return gid ? (s.groups[gid]?.activeTabId ?? null) : null
  })
  const createScript = useAppStore((s) => s.createAutomationScript)
  const deleteScript = useAppStore((s) => s.deleteAutomationScript)
  const openTab = useAppStore((s) => s.openAutomationTab)
  const saveGroup = useAppStore((s) => s.saveAutomationGroup)
  const deleteGroup = useAppStore((s) => s.deleteAutomationGroup)
  const arrange = useAppStore((s) => s.arrangeAutomation)

  const [search, setSearch] = useState('')
  const [pendingDelete, setPendingDelete] = useState<AutomationScript | null>(null)
  const [pendingGroupDelete, setPendingGroupDelete] = useState<AutomationGroup | null>(null)
  const [deleteGroupScripts, setDeleteGroupScripts] = useState(false)
  const [groupEdit, setGroupEdit] = useState<{ id?: string; name: string } | null>(null)

  const [expandedKeys, setExpandedKeys] = useState<string[]>([])
  const knownKeys = useRef<Set<string>>(new Set())

  useEffect(() => {
    const added = groups.map((g) => groupKey(g.id)).filter((k) => !knownKeys.current.has(k))
    if (added.length === 0) return
    for (const k of added) knownKeys.current.add(k)
    setExpandedKeys((prev) => [...prev, ...added])
  }, [groups])

  const blocks: Block[] = []
  const ungrouped: AutomationScript[] = []
  const byGroup = new Map<string, AutomationScript[]>()
  for (const s of scripts) {
    if (s.groupId && groups.some((g) => g.id === s.groupId)) {
      const list = byGroup.get(s.groupId) ?? []
      list.push(s)
      byGroup.set(s.groupId, list)
    } else {
      ungrouped.push(s)
    }
  }
  blocks.push({ group: undefined, items: ungrouped })
  for (const g of groups) blocks.push({ group: g, items: byGroup.get(g.id) ?? [] })

  const q = search.trim().toLowerCase()
  const searching = q.length > 0
  // 脚本正文也参与搜索：按代码内容找「哪个脚本点了这个按钮」很常用
  const hitScript = (s: AutomationScript): boolean =>
    !searching || s.name.toLowerCase().includes(q) || s.code.toLowerCase().includes(q)

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
      const i = list[b].items.findIndex((n) => n.id === id)
      if (i >= 0) return { b, i }
    }
    return null
  }

  const commit = (next: Block[]) => {
    void arrange({
      groupIds: next.filter((b) => b.group).map((b) => b.group!.id),
      scripts: next.flatMap((b) => b.items.map((n) => ({ id: n.id, groupId: b.group?.id })))
    })
  }

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

  const dropGroup = (dragId: string, targetGroupId: string, after: boolean) => {
    const next = blocks.map((b) => ({ group: b.group, items: b.items }))
    const from = next.findIndex((b) => b.group?.id === dragId)
    if (from < 0) return
    const [moved] = next.splice(from, 1)
    let to = next.findIndex((b) => b.group?.id === targetGroupId)
    if (to < 0) return
    if (after) to += 1
    const firstGroup = next.findIndex((b) => b.group)
    if (firstGroup >= 0 && to < firstGroup) to = firstGroup
    next.splice(to, 0, moved)
    commit(next)
  }

  const toggleKey = (key: string) => {
    setExpandedKeys((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]
    )
  }

  const handleCreate = async (groupId?: string) => {
    try {
      const id = await createScript(groupId)
      if (id) openTab(id)
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
      message.success('已删除该脚本')
    } catch (e) {
      message.error(`删除失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const submitGroupEdit = async () => {
    const name = groupEdit?.name.trim()
    if (!name) return
    try {
      await saveGroup({ id: groupEdit?.id, name })
      setGroupEdit(null)
    } catch (e) {
      message.error(`保存分组失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

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
      await deleteGroup(target.id, alsoScripts)
      message.success(
        `已删除分组「${target.name}」：${alsoScripts ? '组内脚本已一并删除' : '组内脚本已移到「未分组」'}`
      )
    } catch (e) {
      message.error(`删除分组失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const moveOutOfGroup = (script: AutomationScript) => {
    void arrange({
      groupIds: groups.map((g) => g.id),
      scripts: scripts.map((s) => ({
        id: s.id,
        groupId: s.id === script.id ? undefined : s.groupId
      }))
    })
  }

  const scriptNode = (s: AutomationScript, hasGroup: boolean): TreeDataNode => ({
    key: scriptKey(s.id),
    title: (
      <ScriptRow
        script={s}
        hasGroup={hasGroup}
        active={activeTabId === `automation-${s.id}`}
        onOpen={() => openTab(s.id)}
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
      const count = blocks.find((x) => x.group?.id === group.id)?.items.length ?? 0
      const isEmpty = count === 0
      return {
        key: groupKey(group.id),
        title: (
          <SidebarGroupRow
            expanded={isEmpty ? false : expandedKeys.includes(groupKey(group.id))}
            name={group.name}
            onToggle={isEmpty ? () => {} : () => toggleKey(groupKey(group.id))}
            itemType={DND_SCRIPT}
            groupType={DND_GROUP}
            groupId={group.id}
            onDropItem={dropScript}
            onDropGroup={dropGroup}
            onNew={() => void handleCreate(group.id)}
            newTitle="在此分组新建脚本"
            menuItems={[
              { key: 'new', icon: <Plus className="size-3.5" />, label: '在此分组新建脚本' },
              { key: 'rename', icon: <Pencil className="size-3.5" />, label: '重命名' },
              { type: 'divider' },
              { key: 'delete', icon: <Trash2 className="size-3.5" />, label: '删除分组', danger: true }
            ]}
            onMenuClick={(key) => {
              if (key === 'new') void handleCreate(group.id)
              else if (key === 'rename') setGroupEdit({ id: group.id, name: group.name })
              else {
                setDeleteGroupScripts(false)
                setPendingGroupDelete(group)
              }
            }}
          />
        ),
        children: isEmpty ? undefined : b.items.map((s) => scriptNode(s, true))
      }
    })

  const treeData: TreeDataNode[] = [...groupNodes]
  const viewUngrouped = viewBlocks.find((b) => !b.group)?.items ?? []
  treeData.push(...viewUngrouped.map((s) => scriptNode(s, false)))

  const effectiveExpanded = searching ? groupNodes.map((n) => String(n.key)) : expandedKeys

  const isEmpty = scripts.length === 0 && groups.length === 0
  const noMatch = searching && treeData.length === 0

  return (
    <div className="flex h-full flex-col">
      <div className="mb-1 flex items-center justify-between gap-1 px-3 py-1">
        <span className="text-sm font-medium text-muted-foreground">
          自动化 ({scripts.length})
        </span>
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

      <div className="px-3">
        <Input
          size='small'
          placeholder="搜索脚本名或代码…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          allowClear
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {isEmpty ? (
          <div className="mx-2 mt-8 rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
            还没有自动化脚本。
            <br />
            点击右上角 + 新建，打开浏览器后即可录制。
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
          placeholder="分组名称，如：登录流程"
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

      {/* 删除脚本确认 */}
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

type DropScript = (
  dragId: string,
  targetId: string | null,
  targetGroupId: string | undefined,
  after: boolean
) => void
type DropGroup = (dragId: string, targetGroupId: string, after: boolean) => void

/** 脚本行：可拖动排序 / 跨组；点击打开，右键打开 / 移出分组 / 删除 */
function ScriptRow({
  script,
  hasGroup,
  active,
  onOpen,
  onMoveOut,
  onDelete,
  onDropScript,
  onDropGroup
}: {
  script: AutomationScript
  hasGroup: boolean
  active: boolean
  onOpen: () => void
  onMoveOut: () => void
  onDelete: () => void
  onDropScript: DropScript
  onDropGroup: DropGroup
}) {
  const [{ isDragging }, drag] = useDrag<RowDragItem, void, { isDragging: boolean }>(
    () => ({
      type: DND_SCRIPT,
      item: { id: script.id },
      collect: (m) => ({ isDragging: m.isDragging() })
    }),
    [script.id]
  )

  const { ref: dropRef, over, after } = useRowDrop<HTMLDivElement>({
    itemType: DND_SCRIPT,
    groupType: DND_GROUP,
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
    ...(script.groupId
      ? [{ key: 'moveout', icon: <ChevronsLeft className="size-3.5" />, label: '移出分组' }]
      : []),
    { type: 'divider' },
    { key: 'delete', icon: <Trash2 className="size-3.5" />, label: '删除', danger: true }
  ]

  /** 脚本行数，作为「这个脚本有多长」的轻量提示 */
  const lineCount = script.code.split('\n').filter((l) => l.trim()).length

  return (
    <div
      ref={ref}
      className={cn(
        'group/script row-own-bg relative flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md px-1 py-1 transition-colors',
        isDragging && 'opacity-40',
        active
          ? 'bg-primary/15 text-foreground'
          : 'text-muted-foreground hover:bg-foreground/5 hover:text-foreground'
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
            else if (key === 'moveout') onMoveOut()
            else onDelete()
          }
        }}
      >
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <FileCode2 className="size-3.5 shrink-0 opacity-70" />
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium leading-none">
            {script.name}
          </span>
          {lineCount > 0 && (
            <span className="shrink-0 text-xs text-muted-foreground/60">{lineCount} 步</span>
          )}
        </div>
      </Dropdown>
      <Button
        type="text"
        size="small"
        icon={<Trash2 className="size-3.5 text-destructive" />}
        className="invisible h-5 w-5 shrink-0 p-0 group-hover/script:visible"
        title="删除脚本"
        onClick={(e) => {
          e.stopPropagation()
          onDelete()
        }}
      />
    </div>
  )
}
