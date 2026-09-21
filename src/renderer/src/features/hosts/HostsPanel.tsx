import { useEffect, useMemo, useRef, useState } from 'react'
import type { SshGroup, SshProfile } from '@shared/types'
import { useAppStore } from '@/stores/app-store'
import {
  ChevronDown,
  ChevronRight,
  ChevronsLeft,
  FolderPlus,
  Pencil,
  Plus,
  Server,
  TerminalSquare,
  Trash2
} from 'lucide-react'
import { useDrag, useDrop } from 'react-dnd'
import { cn } from 'cn'
import {
  Button,
  Checkbox,
  ColorPicker,
  Dropdown,
  Input,
  Modal,
  Tooltip,
  Tree,
  message,
  type MenuProps,
  type TreeDataNode
} from 'antd'
import { resolveSshColor, tintText } from '@/features/hosts/ssh-color'
import { ScriptsPanel } from '@/features/scripts/ScriptsPanel'
import {
  SectionContent,
  SectionHeader,
  SectionShell,
  StackedSections
} from '@/shared/components/StackedSections'
import { HOSTS_LIST_SECTION_ID } from '@/app/section-ids'


/** 树节点 key 前缀：g: 分组（g: 空 id 表示「未分组」伪分组）、p: 连接 */
const GROUP_KEY_PREFIX = 'g:'
const PROFILE_KEY_PREFIX = 'p:'

/** react-dnd 拖拽类型：连接与分组各一种，落点按类型分别处理 */
const DND_PROFILE = 'ssh-profile'
const DND_GROUP = 'ssh-group'

/** 拖拽载荷：两种类型都只需要被拖对象的 id */
interface DragItem {
  id: string
}

/** 列表块：未分组块（group 为空）恒在首位，其余每块是一个分组 */
interface Block {
  group?: SshGroup
  items: SshProfile[]
}

const groupKey = (id: string): string => GROUP_KEY_PREFIX + id
const profileKey = (id: string): string => PROFILE_KEY_PREFIX + id

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
function mergeRefs<T extends HTMLElement>(
  a: (node: T | null) => void,
  b: (node: T | null) => void
) {
  return (node: T | null): void => {
    a(node)
    b(node)
  }
}

/**
 * 行的落点：接受「连接」与「分组」两种拖拽。
 * 用指针落在行的上/下半区判定插入位置（after），行边缘画一条插入指示线。
 */
function useRowDrop<T extends HTMLElement>(opts: {
  /** 拖的是连接时固定视为「追加到末尾」（拖到分组标题上 = 放进组尾） */
  appendWhenProfileDrag?: boolean
  canDrop?: (item: DragItem, type: string) => boolean
  drop: (item: DragItem, type: string, after: boolean) => void
}) {
  const { appendWhenProfileDrag, canDrop, drop } = opts
  const nodeRef = useRef<T | null>(null)
  /** 落点在上半区还是下半区：drop 时读取（不放进 deps，避免拖拽中反复重建 spec） */
  const afterRef = useRef(false)
  const [after, setAfter] = useState(false)

  const [{ over }, connectDrop] = useDrop<DragItem, void, { over: boolean }>(
    () => ({
      accept: [DND_PROFILE, DND_GROUP],
      canDrop: (item, monitor) => (canDrop ? canDrop(item, String(monitor.getItemType())) : true),
      hover: (_item, monitor) => {
        const node = nodeRef.current
        const offset = monitor.getClientOffset()
        if (!node || !offset) return
        const rect = node.getBoundingClientRect()
        const next =
          appendWhenProfileDrag && String(monitor.getItemType()) === DND_PROFILE
            ? true
            : offset.y > rect.top + rect.height / 2
        afterRef.current = next
        setAfter(next)
      },
      drop: (item, monitor) => drop(item, String(monitor.getItemType()), afterRef.current),
      collect: (m) => ({ over: m.isOver() && m.canDrop() })
    }),
    [appendWhenProfileDrag, canDrop, drop]
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

/** 取色面板里的快捷色板（常用的高辨识度色相） */
const COLOR_PRESETS = [
  '#ef4444', '#f97316', '#f59e0b', '#eab308',
  '#84cc16', '#22c55e', '#14b8a6', '#06b6d4',
  '#3b82f6', '#6366f1', '#8b5cf6', '#ec4899'
]

/**
 * 行内悬浮色点：点击直接弹出 antd 取色面板（含快捷色板）。
 * 未设置颜色时默认隐藏，悬浮行才出现；已设置则常驻显示，方便一眼看出配色。
 * 传入 onClear 时面板里出现「清除」，用于连接回到继承分组色。
 */
function ColorDot({
  value,
  fallback,
  title,
  hoverGroupClass,
  onChange,
  onClear
}: {
  /** 已显式设置的颜色（null/undefined 表示未设置） */
  value?: string
  /** 未设置时色点显示的参考色（连接为继承到的分组色） */
  fallback?: string
  title: string
  /** 未设置时用于悬浮显隐的父级 group 类名 */
  hoverGroupClass: string
  onChange: (color: string) => void
  onClear?: () => void
}) {
  return (
    <ColorPicker
      value={value ?? fallback ?? '#64748b'}
      disabledAlpha
      allowClear={Boolean(onClear)}
      presets={[{ label: '快捷色板', colors: COLOR_PRESETS }]}
      onChangeComplete={(color) => onChange(color.toHexString())}
      onClear={onClear}
    >
      <button
        type="button"
        title={title}
        className={cn(
          'flex size-5 shrink-0 items-center justify-center rounded transition-opacity',
          `opacity-0 ${hoverGroupClass}`
        )}
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        <span
          className={cn(
            'size-2.5 rounded-full border',
            value ? 'border-transparent' : 'border-muted-foreground/50'
          )}
          style={{ background: value ?? fallback ?? 'transparent' }}
        />
      </button>
    </ColorPicker>
  )
}

/**
 * 「主机」功能区侧边栏：上下两个可折叠分区的组合。
 *
 * 上半区是主机列表（HostsSection），下半区是脚本列表（ScriptsPanel）——
 * 脚本只服务于主机，所以不再占用独立的功能区图标。
 * 两个分区各自的展开/收起、空间分配与最小高度约束由 StackedSections 统一负责。
 */
export function HostsPanel() {
  return (
    <StackedSections>
      <HostsSection />
      <ScriptsPanel />
    </StackedSections>
  )
}

/**
 * 主机分区：本地终端入口 + 主机列表。
 * 结构用 antd Tree（分组可折叠），拖拽用 react-dnd：
 * 连接可跨组拖动并调整顺序，分组可拖动排序，「未分组」固定在首位。
 */
function HostsSection() {
  const profiles = useAppStore((s) => s.profiles)
  const sshGroups = useAppStore((s) => s.sshGroups)
  const connectHost = useAppStore((s) => s.connectHost)
  const setSshDialog = useAppStore((s) => s.setSshDialog)
  const refreshProfiles = useAppStore((s) => s.refreshProfiles)
  const saveSshGroup = useAppStore((s) => s.saveSshGroup)
  const setSshProfileColor = useAppStore((s) => s.setSshProfileColor)
  const deleteSshGroup = useAppStore((s) => s.deleteSshGroup)
  const arrangeSsh = useAppStore((s) => s.arrangeSsh)

  /** 待确认删除的 SSH 配置（非 null 时弹出确认框） */
  const [pendingDelete, setPendingDelete] = useState<SshProfile | null>(null)
  /** 待确认删除的分组 */
  const [pendingGroupDelete, setPendingGroupDelete] = useState<SshGroup | null>(null)
  /** 删除分组时是否连同组内主机一起删除（默认只解散分组） */
  const [deleteGroupHosts, setDeleteGroupHosts] = useState(false)
  /** 新建（id 为空）或重命名分组 */
  const [groupEdit, setGroupEdit] = useState<{ id?: string; name: string } | null>(null)

  const [expandedKeys, setExpandedKeys] = useState<string[]>([])
  /** 搜索关键字（主机名 / 地址 / 账号 / 启动命令） */
  const [search, setSearch] = useState('')
  /** 已自动展开过的分组 key：只在新分组出现时补展开，不覆盖用户的折叠操作 */
  const knownKeys = useRef<Set<string>>(new Set())

  useEffect(() => {
    const added = sshGroups.map((g) => groupKey(g.id)).filter((k) => !knownKeys.current.has(k))
    if (added.length === 0) return
    for (const k of added) knownKeys.current.add(k)
    setExpandedKeys((prev) => [...prev, ...added])
  }, [sshGroups])

  // 分组归类（groupId 指向已不存在的分组时按未分组处理），块顺序即显示顺序
  const blocks: Block[] = []
  const ungrouped: SshProfile[] = []
  const byGroup = new Map<string, SshProfile[]>()
  for (const p of profiles) {
    if (p.groupId && sshGroups.some((g) => g.id === p.groupId)) {
      const list = byGroup.get(p.groupId) ?? []
      list.push(p)
      byGroup.set(p.groupId, list)
    } else {
      ungrouped.push(p)
    }
  }
  // 「未分组」块恒在首位
  blocks.push({ group: undefined, items: ungrouped })
  for (const g of sshGroups) blocks.push({ group: g, items: byGroup.get(g.id) ?? [] })

  // 搜索时按命中过滤（组名命中 = 整组保留）；拖拽落点一律走**完整的** blocks
  const q = search.trim().toLowerCase()
  const searching = q.length > 0
  const hitProfile = (p: SshProfile): boolean =>
    !searching ||
    p.name.toLowerCase().includes(q) ||
    (p.host ?? '').toLowerCase().includes(q) ||
    (p.username ?? '').toLowerCase().includes(q) ||
    (p.command ?? '').toLowerCase().includes(q)

  const viewBlocks: Block[] = !searching
    ? blocks
    : blocks
        .map((b) => {
          const groupHit = b.group ? b.group.name.toLowerCase().includes(q) : false
          return { group: b.group, items: groupHit ? b.items : b.items.filter(hitProfile) }
        })
        .filter((b) => b.items.length > 0 || (b.group && b.group.name.toLowerCase().includes(q)))

  /** 连接的生效颜色：自身设置优先，否则继承所属分组的颜色 */
  const effectiveColor = (p: SshProfile): string | undefined => resolveSshColor(p, sshGroups)

  const locate = (list: Block[], id: string): { b: number; i: number } | null => {
    for (let b = 0; b < list.length; b++) {
      const i = list[b].items.findIndex((p) => p.id === id)
      if (i >= 0) return { b, i }
    }
    return null
  }

  /** 把调整后的块结构整体写回（顺序与归属一次提交，避免中间态） */
  const commit = (next: Block[]) => {
    void arrangeSsh({
      groupIds: next.filter((b) => b.group).map((b) => b.group!.id),
      profiles: next.flatMap((b) => b.items.map((p) => ({ id: p.id, groupId: b.group?.id })))
    })
  }

  /** 发起连接并在失败时提示（连接本身会切回终端视图） */
  const connect = (profile: SshProfile) => {
    void connectHost(profile).catch((e) => {
      message.error(`连接失败：${e instanceof Error ? e.message : String(e)}`)
    })
  }

  /** 连接拖拽落点：插到目标连接前/后；targetId 为空时追加到目标分组末尾 */
  const dropProfile = (
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

  /** 分组拖拽落点：移到目标分组的前/后（组内连接跟着一起走） */
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

  /** 点击分组行整行切换展开/折叠（不显示 antd 的切换箭头） */
  const toggleKey = (key: string) => {
    setExpandedKeys((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]
    )
  }

  const confirmDelete = async () => {
    const target = pendingDelete
    if (!target) return
    setPendingDelete(null)
    await window.api.ssh.remove(target.id)
    await refreshProfiles()
  }

  const submitGroupEdit = async () => {
    const name = groupEdit?.name.trim()
    if (!name) return
    await saveSshGroup({ id: groupEdit?.id, name })
    setGroupEdit(null)
  }

  /** 待删除分组内的主机数量（用于确认框的文案与勾选项） */
  const groupHostCount = pendingGroupDelete
    ? profiles.filter((p) => p.groupId === pendingGroupDelete.id).length
    : 0

  const confirmGroupDelete = async () => {
    const target = pendingGroupDelete
    if (!target) return
    const alsoHosts = deleteGroupHosts
    setPendingGroupDelete(null)
    setDeleteGroupHosts(false)
    await deleteSshGroup(target.id, alsoHosts)
    message.success(
      `已删除分组「${target.name}」：${alsoHosts ? '组内主机已一并删除' : '组内主机已移到「未分组」'}`
    )
  }

  /** 把一个主机移出到「未分组」：只改该主机的分组归属，保持其它顺序不变 */
  const moveToUngrouped = (profile: SshProfile) => {
    void arrangeSsh({
      groupIds: sshGroups.map((g) => g.id),
      profiles: profiles.map((x) => ({
        id: x.id,
        groupId: x.id === profile.id ? undefined : x.groupId
      }))
    })
  }

  const profileNode = (p: SshProfile, hasGroup: boolean): TreeDataNode => ({
    key: profileKey(p.id),
    title: (
      <ProfileRow
        profile={p}
        hasGroup={hasGroup}
        color={effectiveColor(p)}
        onConnect={() => connect(p)}
        onEdit={() => setSshDialog(true, p)}
        onMoveOut={() => moveToUngrouped(p)}
        onDelete={() => setPendingDelete(p)}
        onColor={(color) => void setSshProfileColor(p.id, color)}
        onDropProfile={dropProfile}
        onDropGroup={dropGroup}
      />
    )
  })

  const groupNodes: TreeDataNode[] = viewBlocks
    .filter((b) => b.group)
    .map((b) => {
      const group = b.group!
      // 空分组不参与展开/折叠：不挂子节点、点击无效，避免空展开触发布局抖动
      const isEmpty = b.items.length === 0
      return {
        key: groupKey(group.id),
        title: (
          <GroupRow
            expanded={isEmpty ? false : expandedKeys.includes(groupKey(group.id))}
            group={group}
            count={b.items.length}
            onToggle={isEmpty ? () => {} : () => toggleKey(groupKey(group.id))}
            onDropProfile={dropProfile}
            onDropGroup={dropGroup}
            onNew={() => setSshDialog(true, null, group.id)}
            onRename={() => setGroupEdit({ id: group.id, name: group.name })}
            onColor={(color) =>
              void saveSshGroup({ id: group.id, name: group.name, color })
            }
            onDelete={() => {
              setDeleteGroupHosts(false)
              setPendingGroupDelete(group)
            }}
          />
        ),
        children: isEmpty ? undefined : b.items.map((p) => profileNode(p, true))
      }
    })

  // 搜索时把命中的分组全部展开（否则要逐个点开才看得到结果）
  const effectiveExpanded = searching
    ? groupNodes.map((n) => String(n.key))
    : expandedKeys

  // 分组在前，未分组的主机平铺在最后（不另设「未分组」折叠组）
  const treeData: TreeDataNode[] = [...groupNodes]
  const viewUngrouped = viewBlocks.find((b) => !b.group)?.items ?? []
  treeData.push(...viewUngrouped.map((p) => profileNode(p, false)))

  const isEmpty = profiles.length === 0 && sshGroups.length === 0
  const noMatch = searching && treeData.length === 0

  return (
    <SectionShell id={HOSTS_LIST_SECTION_ID} grow={2} minHeight={200}>
      {/* 标题栏：整条点击可收起/展开；右侧是新建分组 / 新建主机（与「脚本」「笔记」面板同款） */}
      <SectionHeader
        id={HOSTS_LIST_SECTION_ID}
        title="主机"
        count={profiles.length}
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
            <Button
              type="text"
              size="small"
              className="px-0.5 text-muted-foreground"
              title="新建主机"
              icon={<Plus className="size-3.5" />}
              onClick={() => setSshDialog(true, null)}
            />
          </>
        }
      />

      <SectionContent id={HOSTS_LIST_SECTION_ID}>
        <div className="px-3 pb-2">
          <Input
            placeholder="搜索主机…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            allowClear
          />
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {isEmpty ? (
            <div className="mx-2 mt-8 rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
              还没有主机
              <br />
              点击右上角 + 添加
            </div>
          ) : noMatch ? (
            <div className="mx-2 mt-8 rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
              没有匹配「{search}」的主机。
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
          placeholder="分组名称，如：生产环境"
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
          {groupHostCount > 0 ? `，组内共 ${groupHostCount} 个主机。` : '。'}
        </p>
        {groupHostCount > 0 && (
          <Checkbox
            className="mt-3"
            checked={deleteGroupHosts}
            onChange={(e) => setDeleteGroupHosts(e.target.checked)}
          >
            <span className="text-sm">同时删除组内的主机</span>
          </Checkbox>
        )}
        <p className="mt-2 text-xs text-muted-foreground">
          {deleteGroupHosts
            ? '组内主机将一并删除，该操作不可撤销。'
            : '不勾选时，组内主机会移到「未分组」。'}
        </p>
      </Modal>

      {/* 删除连接确认 */}
      <Modal
        open={pendingDelete !== null}
        onCancel={() => setPendingDelete(null)}
        title="删除主机？"
        okText="删除"
        cancelText="取消"
        okButtonProps={{ danger: true }}
        onOk={() => void confirmDelete()}
        centered
        width={440}
        destroyOnHidden
      >
        <p className="text-sm text-muted-foreground">
          「{pendingDelete?.name}」
          {pendingDelete?.kind === 'local'
            ? '（本地终端）'
            : `（${pendingDelete?.username}@${pendingDelete?.host}:${pendingDelete?.port}）`}
          将从列表中移除，该操作不可撤销。
        </p>
      </Modal>
    </SectionShell>
  )
}

/** 拖拽落点处理函数签名（连接与分组共用，由面板统一重排后一次写回） */
type DropProfile = (
  dragId: string,
  targetId: string | null,
  targetGroupId: string | undefined,
  after: boolean
) => void
type DropGroup = (dragId: string, targetGroupId: string, after: boolean) => void

/** 分组行：可拖动排序，也可接收连接（追加进组）；右键可重命名 / 删除 */
function GroupRow({
  expanded,
  group,
  count,
  onToggle,
  onDropProfile,
  onDropGroup,
  onNew,
  onRename,
  onColor,
  onDelete
}: {
  /** 当前是否为展开状态（决定箭头方向） */
  expanded: boolean
  group: SshGroup
  count: number
  /** 点击整行切换展开/折叠 */
  onToggle: () => void
  onDropProfile: DropProfile
  onDropGroup: DropGroup
  onNew: () => void
  onRename: () => void
  /** 设置分组颜色（null 清除）；组内未单独设色的连接会继承该颜色 */
  onColor: (color: string | null) => void
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
    // 拖连接落在分组标题上 = 放进组尾
    appendWhenProfileDrag: true,
    canDrop: (item, type) => type === DND_PROFILE || item.id !== group.id,
    drop: (item, type, at) => {
      if (type === DND_GROUP) onDropGroup(item.id, group.id, at)
      else onDropProfile(item.id, null, group.id, true)
    }
  })

  const dragRef = useMemo(() => asRef<HTMLDivElement>(drag), [drag])
  const ref = useMemo(() => mergeRefs(dropRef, dragRef), [dropRef, dragRef])

  const items: MenuProps['items'] = [
    { key: 'new', icon: <Plus className="size-3.5" />, label: '新建连接' },
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
        'group/grp relative flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded pr-1',
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
            <ChevronDown
              className="size-3.5 shrink-0 text-muted-foreground"
              style={group.color ? { color: group.color } : undefined}
            />
          ) : (
            <ChevronRight
              className="size-3.5 shrink-0 text-muted-foreground"
              style={group.color ? { color: group.color } : undefined}
            />
          )}
          <span
            className="truncate text-sm font-medium text-muted-foreground"
            style={group.color ? { color: tintText(group.color) } : undefined}
          >
            {group.name}
          </span>
          <span className="text-xs text-muted-foreground/70">{count}</span>
          <ColorDot
            value={group.color}
            title={group.color ? '分组颜色' : '设置分组颜色'}
            hoverGroupClass="group-hover/grp:opacity-100"
            onChange={(color) => onColor(color)}
            onClear={() => onColor(null)}
          />
          <Button
            type="text"
            size="small"
            className="ml-auto px-1 opacity-0 transition-opacity group-hover/grp:opacity-100"
            title="在此分组新建连接"
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

/** 连接行：可拖动排序 / 跨组；双击连接，右键连接 / 编辑 / 删除 */
function ProfileRow({
  profile,
  hasGroup,
  color,
  onConnect,
  onEdit,
  onMoveOut,
  onDelete,
  onColor,
  onDropProfile,
  onDropGroup
}: {
  profile: SshProfile
  /** 所在分组真实存在（决定能否用本行作为分组排序的落点） */
  hasGroup: boolean
  /** 生效颜色：连接自身设置，或继承所属分组 */
  color?: string
  onConnect: () => void
  onEdit: () => void
  /** 移出到「未分组」（仅分组内主机显示） */
  onMoveOut: () => void
  onDelete: () => void
  /** 设置连接自身颜色（null 清除，回到继承分组） */
  onColor: (color: string | null) => void
  onDropProfile: DropProfile
  onDropGroup: DropGroup
}) {
  const [{ isDragging }, drag] = useDrag<DragItem, void, { isDragging: boolean }>(
    () => ({
      type: DND_PROFILE,
      item: { id: profile.id },
      collect: (m) => ({ isDragging: m.isDragging() })
    }),
    [profile.id]
  )

  const { ref: dropRef, over, after } = useRowDrop<HTMLDivElement>({
    canDrop: (item, type) =>
      type === DND_GROUP ? hasGroup && item.id !== profile.groupId : item.id !== profile.id,
    drop: (item, type, at) => {
      if (type === DND_GROUP) onDropGroup(item.id, profile.groupId!, at)
      else onDropProfile(item.id, profile.id, profile.groupId, at)
    }
  })

  const dragRef = useMemo(() => asRef<HTMLDivElement>(drag), [drag])
  const ref = useMemo(() => mergeRefs(dropRef, dragRef), [dropRef, dragRef])

  const items: MenuProps['items'] = [
    {
      key: 'connect',
      icon:
        profile.kind === 'local' ? (
          <TerminalSquare className="size-3.5" />
        ) : (
          <Server className="size-3.5" />
        ),
      label: '连接'
    },
    { key: 'edit', icon: <Pencil className="size-3.5" />, label: '编辑' },
    // 分组内主机才提供「移到未分组」，作为移出分组的入口
    ...(profile.groupId
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
        'group/prof relative flex min-w-0 flex-1 cursor-pointer items-center gap-2 pr-1',
        isDragging && 'opacity-40'
      )}
      onDoubleClick={onConnect}
    >
      {over && <DropLine after={after} />}
      <Dropdown
        trigger={['contextMenu']}
        menu={{
          items,
          onClick: ({ key }) => {
            if (key === 'connect') onConnect()
            else if (key === 'edit') onEdit()
            else if (key === 'moveout') onMoveOut()
            else onDelete()
          }
        }}
      >
        {/* 行内只显示名称，连接信息（账号/地址/端口 或 启动命令）悬浮时才提示 */}
        <Tooltip
          title={
            profile.kind === 'local'
              ? profile.command ?? '本地终端'
              : `${profile.username}@${profile.host}:${profile.port}`
          }
          mouseEnterDelay={0.4}
        >
          <div className="flex min-w-0 flex-1 items-center gap-2">
            {profile.kind === 'local' ? (
              <TerminalSquare
                className="size-4 shrink-0 text-muted-foreground"
                style={color ? { color } : undefined}
              />
            ) : (
              <Server
                className="size-4 shrink-0 text-muted-foreground"
                style={color ? { color } : undefined}
              />
            )}
            <div
              className="min-w-0 flex-1 truncate text-sm font-medium"
              style={color ? { color: tintText(color) } : undefined}
            >
              {profile.name}
            </div>
          </div>
        </Tooltip>
      </Dropdown>
      <ColorDot
        value={profile.color}
        fallback={color}
        title={
          profile.color ? '连接颜色' : color ? '继承分组颜色（点击可单独设置）' : '设置连接颜色'
        }
        hoverGroupClass="group-hover/prof:opacity-100"
        onChange={(next) => onColor(next)}
        onClear={() => onColor(null)}
      />
    </div>
  )
}