import ExpandButton from '@/components/ExpandButton'
import { useAppStore } from '@/stores/app-store'
import type { NoteFileItem } from '@shared/types'
import { Button, Dropdown, Input, Modal, Tree, message, type MenuProps, type TreeDataNode } from 'antd'
import { cn } from 'cn'
import {
  ExternalLink,
  FilePlus,
  FileText,
  FolderMinus,
  FolderOpen,
  RefreshCw,
  Trash2
} from 'lucide-react'
import { useEffect, useState } from 'react'

/**
 * 笔记侧边栏：可同时打开多个本地目录，每个目录一个根节点、一棵 Markdown 文件树。
 *
 * - 顶部工具栏：打开文件夹（可多选）/ 刷新全部
 * - 目录根节点右键：在此新建笔记 / 在文件管理器中打开 / 刷新 / 移除该目录（只移出侧边栏，不删文件）
 * - 文件与子目录：点击文件打开编辑标签；右键 新建 / 打开文件位置 / 重命名 / 删除
 * - 同一目录只出现一次（Windows / macOS 不区分大小写），父子目录可以同时打开
 */

/** 相对路径（用 `/` 分隔）→ 绝对路径。传给系统 / 主进程时必须还原成宿主平台的分隔符 */
function absPath(root: string, rel: string): string {
  if (!rel) return root
  const sep = root.includes('\\') ? '\\' : '/'
  return `${root}${sep}${rel.split('/').join(sep)}`
}

/** 根节点显示名：路径最后一段 */
function rootName(root: string): string {
  return root.split(/[\\/]/).filter(Boolean).pop() || root
}

export function NotesPanel() {
  const noteRoots = useAppStore((s) => s.noteRoots)
  const noteTrees = useAppStore((s) => s.noteTrees)
  const openNoteFolder = useAppStore((s) => s.openNoteFolder)
  const removeNoteRoot = useAppStore((s) => s.removeNoteRoot)
  const readNoteFile = useAppStore((s) => s.readNoteFile)
  const createNoteFile = useAppStore((s) => s.createNoteFile)
  const refreshNoteFolder = useAppStore((s) => s.refreshNoteFolder)
  const renameNoteFile = useAppStore((s) => s.renameNoteFile)
  const deleteNoteFile = useAppStore((s) => s.deleteNoteFile)
  const openNoteTab = useAppStore((s) => s.openNoteTab)

  const [search, setSearch] = useState('')
  /** 展开的节点 key（目录的绝对路径） */
  const [expandedKeys, setExpandedKeys] = useState<string[]>([])
  /** 待确认删除的文件 */
  const [pendingDelete, setPendingDelete] = useState<{ root: string; path: string; name: string } | null>(null)
  /** 重命名对话框 */
  const [renameTarget, setRenameTarget] = useState<{ root: string; path: string; name: string } | null>(null)
  const [renameValue, setRenameValue] = useState('')

  // 新打开的目录默认展开（启动恢复的也是刚「出现」的目录，一并展开）
  useEffect(() => {
    setExpandedKeys((prev) => {
      const missing = noteRoots.filter((r) => !prev.includes(r))
      return missing.length > 0 ? [...prev, ...missing] : prev
    })
  }, [noteRoots])

  /** 递归搜索过滤：返回命中文件名的节点（目录如果子项有命中也保留） */
  const filterTree = (items: NoteFileItem[], query: string): NoteFileItem[] => {
    const lower = query.toLowerCase()
    return items
      .map((item) => {
        if (item.isDir) {
          const children = item.children ? filterTree(item.children, query) : []
          if (children.length > 0) return { ...item, children }
          return null
        }
        return item.name.toLowerCase().includes(lower) ? item : null
      })
      .filter(Boolean) as NoteFileItem[]
  }

  const q = search.trim().toLowerCase()
  const viewRoots = noteRoots.map((root) => {
    const items = noteTrees[root] ?? []
    return { root, items: q ? filterTree(items, q) : items }
  })
  const totalItems = viewRoots.reduce((n, r) => n + r.items.length, 0)

  /** 搜索时自动展开所有目录（含各根节点） */
  const effectiveExpanded = q
    ? [...noteRoots, ...viewRoots.flatMap(({ root, items }) => collectDirKeys(items, root, ''))]
    : expandedKeys

  /** 展开/折叠目录 */
  const toggleExpand = (key: string) => {
    setExpandedKeys((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]
    )
  }

  /** 在系统文件管理器中定位：目录直接打开，文件在其所在目录中被选中 */
  const revealInExplorer = (root: string, rel: string): void => {
    void (async () => {
      const r = await window.api.shell.revealPath(absPath(root, rel))
      if (!r.ok) message.error(r.error ?? '打开文件位置失败')
    })()
  }

  /**
   * 把某棵树转成 antd Tree 的 TreeDataNode[]。
   *
   * ⚠️ `item.path` 只是相对**父目录**的一段（主进程 scanDir 是按层给的），
   * 拼上 parentRel 才是相对所属目录根的完整路径；Tree 的 key 用绝对路径 ——
   * 多个目录的树合成一棵后，只有绝对路径能保证不撞 key。
   */
  const toTreeData = (items: NoteFileItem[], root: string, parentRel: string): TreeDataNode[] => {
    return items.map((item) => {
      const rel = parentRel ? `${parentRel}/${item.path}` : item.path
      const key = absPath(root, rel)
      if (item.isDir) {
        return {
          key,
          selectable: false,
          title: (
            <DirRow
              name={item.name}
              path={key}
              expanded={effectiveExpanded.includes(key)}
              onToggle={() => toggleExpand(key)}
              onNew={() => void handleCreate(root, rel)}
              onReveal={() => revealInExplorer(root, rel)}
              onRename={() => {
                setRenameTarget({ root, path: rel, name: item.name })
                setRenameValue(item.name)
              }}
              onDelete={() => setPendingDelete({ root, path: rel, name: item.name })}
            />
          ),
          children: item.children ? toTreeData(item.children, root, rel) : []
        }
      }
      return {
        key,
        selectable: false,
        isLeaf: true,
        title: (
          <FileRow
            item={item}
            onOpen={() => void handleOpenFile(root, rel)}
            onReveal={() => revealInExplorer(root, rel)}
            onRename={() => {
              setRenameTarget({ root, path: rel, name: item.name })
              setRenameValue(item.name)
            }}
            onDelete={() => setPendingDelete({ root, path: rel, name: item.name })}
          />
        )
      }
    })
  }

  /** 顶层：每个已打开的目录一个根节点（父子目录同时打开时各自成根，互不折叠） */
  const treeData: TreeDataNode[] = viewRoots.map(({ root, items }) => ({
    key: root,
    selectable: false,
    title: (
      <DirRow
        name={rootName(root)}
        path={root}
        expanded={effectiveExpanded.includes(root)}
        onToggle={() => toggleExpand(root)}
        onNew={() => void handleCreate(root, '')}
        onReveal={() => revealInExplorer(root, '')}
        onRefresh={() => void refreshNoteFolder(root)}
        onRemove={() => handleRemoveRoot(root)}
      />
    ),
    children: toTreeData(items, root, '')
  }))

  /** 打开文件：读取内容后开标签（relPath 是相对所属目录的完整路径） */
  const handleOpenFile = async (root: string, relPath: string) => {
    try {
      const result = await readNoteFile(root, relPath)
      openNoteTab(result.path, result.path.split(/[\\/]/).pop() ?? relPath)
    } catch (e) {
      message.error(`打开文件失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  /** 打开目录（可多选） */
  const handleOpenFolder = async () => {
    try {
      const result = await openNoteFolder()
      if (!result) return
      if (result.skipped > 0) {
        message.info(
          result.added > 0
            ? `已添加 ${result.added} 个目录，${result.skipped} 个已在侧边栏中`
            : '所选目录已在侧边栏中'
        )
      }
    } catch (e) {
      message.error(`打开文件夹失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  /** 从侧边栏移除目录（磁盘文件不动） */
  const handleRemoveRoot = (root: string) => {
    removeNoteRoot(root)
  }

  /** 新建笔记文件（dirPath 是相对所属目录的完整目录路径，空串 = 根目录） */
  const handleCreate = async (root: string, dirPath: string) => {
    try {
      const result = await createNoteFile(root, dirPath)
      openNoteTab(result.path, result.path.split(/[\\/]/).pop() ?? result.path)
      message.success('已新建笔记')
    } catch (e) {
      message.error(`新建失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  /** 确认删除 */
  const confirmDelete = async () => {
    if (!pendingDelete) return
    const target = pendingDelete
    setPendingDelete(null)
    try {
      await deleteNoteFile(target.root, target.path)
      message.success('已删除该文件')
    } catch (e) {
      message.error(`删除失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  /** 确认重命名 */
  const confirmRename = async () => {
    if (!renameTarget) return
    const name = renameValue.trim()
    if (!name || name === renameTarget.name) {
      setRenameTarget(null)
      return
    }
    try {
      await renameNoteFile(renameTarget.root, renameTarget.path, name)
      setRenameTarget(null)
      message.success('已重命名')
    } catch (e) {
      message.error(`重命名失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  return (
    <div className="flex h-full flex-col">
      {/* 工具栏 */}
      <div className="mb-1 flex items-center justify-between gap-1 px-3 py-1">
        <span className="text-sm font-medium text-muted-foreground truncate">笔记</span>
        <div className="flex items-center gap-1">
          <Button
            type="text"
            size="small"
            className="px-0.5 text-muted-foreground"
            title="打开文件夹"
            icon={<FolderOpen className="size-3.5" />}
            onClick={() => void handleOpenFolder()}
          />
          {noteRoots.length > 0 && (
            <Button
              type="text"
              size="small"
              className="px-0.5 text-muted-foreground"
              title="刷新全部目录"
              icon={<RefreshCw className="size-3.5" />}
              onClick={() => void refreshNoteFolder()}
            />
          )}
        </div>
      </div>

      {noteRoots.length > 0 && (
        <div className="px-3">
          <Input
            size='small'
            placeholder="搜索文件…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            allowClear
          />
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {noteRoots.length === 0 ? (
          <div className="mx-2 mt-8 rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
            点击上方「打开文件夹」选择笔记目录，可添加多个，
            <br />
            重启后自动恢复。
          </div>
        ) : q && totalItems === 0 ? (
          <div className="mx-2 mt-8 rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
            没有匹配「{search}」的文件。
          </div>
        ) : (
          <>
            <Tree
              className="side-tree notes-tree"
              treeData={treeData}
              selectable={false}
              blockNode
              showLine={false}
              expandedKeys={effectiveExpanded}
              onExpand={(keys) => setExpandedKeys(keys.map(String))}
            />
            {noteRoots.length === 1 && (noteTrees[noteRoots[0]] ?? []).length === 0 && !q && (
              <div className="mx-2 mt-2 rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
                该目录下没有 Markdown 文件。
                <br />
                右键目录名可「在此新建笔记」。
              </div>
            )}
          </>
        )}
      </div>

      {/* 重命名对话框 */}
      <Modal
        open={renameTarget !== null}
        onCancel={() => setRenameTarget(null)}
        title="重命名"
        okText="确认"
        cancelText="取消"
        centered
        width={400}
        destroyOnHidden
        okButtonProps={{ disabled: !renameValue.trim() || renameValue.trim() === renameTarget?.name }}
        onOk={() => void confirmRename()}
      >
        <Input
          autoFocus
          placeholder="新文件名"
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          onPressEnter={() => void confirmRename()}
        />
      </Modal>

      {/* 删除确认 */}
      <Modal
        open={pendingDelete !== null}
        onCancel={() => setPendingDelete(null)}
        title="删除文件？"
        okText="删除"
        cancelText="取消"
        okButtonProps={{ danger: true }}
        onOk={() => void confirmDelete()}
        centered
        width={420}
        destroyOnHidden
      >
        <p className="text-sm text-muted-foreground">
          「{pendingDelete?.name}」将从磁盘永久删除，该操作不可撤销。
        </p>
      </Modal>
    </div>
  )
}

/** 收集一棵树里所有目录的 key（搜索时自动展开） */
function collectDirKeys(items: NoteFileItem[], root: string, parentRel: string): string[] {
  const keys: string[] = []
  for (const item of items) {
    if (item.isDir) {
      const rel = parentRel ? `${parentRel}/${item.path}` : item.path
      keys.push(absPath(root, rel))
      if (item.children) keys.push(...collectDirKeys(item.children, root, rel))
    }
  }
  return keys
}

/**
 * 目录行：展开/折叠箭头 + 名称 + 右键菜单。
 * 点击箭头或名称行都能切换展开/折叠。
 *
 * 根节点（已打开的目录）传 `onRefresh` / `onRemove` 而不传 `onRename` / `onDelete` ——
 * 重命名 / 删除「用户机器上的目录」不是这个面板该干的事；普通子目录相反。
 */
function DirRow({
  name,
  path,
  expanded,
  onToggle,
  onNew,
  onReveal,
  onRefresh,
  onRename,
  onDelete,
  onRemove
}: {
  name: string
  /** 完整路径，悬停提示用 */
  path?: string
  expanded: boolean
  onToggle: () => void
  onNew: () => void
  onReveal: () => void
  onRefresh?: () => void
  onRename?: () => void
  onDelete?: () => void
  onRemove?: () => void
}) {
  const items: MenuProps['items'] = [
    { key: 'new', icon: <FilePlus className="size-3.5" />, label: '在此新建笔记' },
    { key: 'reveal', icon: <ExternalLink className="size-3.5" />, label: '在文件管理器中打开' },
    ...(onRefresh ? [{ key: 'refresh', icon: <RefreshCw className="size-3.5" />, label: '刷新' }] : []),
    ...((onRename && onDelete) || onRemove ? [{ type: 'divider' as const }] : []),
    ...(onRename && onDelete
      ? [
        { key: 'rename', icon: <FileText className="size-3.5" />, label: '重命名' },
        { key: 'delete', icon: <Trash2 className="size-3.5" />, label: '删除', danger: true }
      ]
      : []),
    ...(onRemove
      ? [{ key: 'remove', icon: <FolderMinus className="size-3.5" />, label: '移除该目录（文件保留）', danger: true }]
      : [])
  ]
  return (
    <Dropdown
      trigger={['contextMenu']}
      menu={{
        items,
        onClick: ({ key }) => {
          if (key === 'new') onNew()
          else if (key === 'reveal') onReveal()
          else if (key === 'refresh') onRefresh?.()
          else if (key === 'rename') onRename?.()
          else if (key === 'delete') onDelete?.()
          else if (key === 'remove') onRemove?.()
        }
      }}
    >
      <div
        className={cn(
          'row-own-bg relative flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-md px-1 py-1 transition-colors text-muted-foreground hover:bg-foreground/5 hover:text-foreground'
        )}
        onClick={onToggle}
        title={path}>
        <ExpandButton expanded={expanded} onToggle={onToggle} color={null} />
        <span className="min-w-0 truncate text-sm font-medium">{name}</span>
      </div>
    </Dropdown>
  )
}

/** 文件行：文件图标 + 文件名 + 右键菜单 */
function FileRow({
  item,
  onOpen,
  onReveal,
  onRename,
  onDelete
}: {
  item: NoteFileItem
  onOpen: () => void
  onReveal: () => void
  onRename: () => void
  onDelete: () => void
}) {
  const items: MenuProps['items'] = [
    { key: 'open', icon: <FileText className="size-3.5" />, label: '打开' },
    { key: 'reveal', icon: <ExternalLink className="size-3.5" />, label: '在文件管理器中打开' },
    { type: 'divider' },
    { key: 'rename', icon: <FileText className="size-3.5" />, label: '重命名' },
    { key: 'delete', icon: <Trash2 className="size-3.5" />, label: '删除', danger: true }
  ]
  return (
    <div
      className={cn(
        'group/note row-own-bg relative flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md px-1 py-1 transition-colors',
        'text-muted-foreground hover:bg-foreground/5 hover:text-foreground'
      )}
      onClick={onOpen}
      title={item.name}
    >
      <Dropdown
        trigger={['contextMenu']}
        menu={{
          items,
          onClick: ({ key }) => {
            if (key === 'open') onOpen()
            else if (key === 'reveal') onReveal()
            else if (key === 'rename') onRename()
            else if (key === 'delete') onDelete()
          }
        }}
      >
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium leading-none">
            {item.name}
          </span>
        </div>
      </Dropdown>
      <Button
        type="text"
        size="small"
        icon={<Trash2 className="size-3.5 text-destructive" />}
        className="invisible h-5 w-5 shrink-0 p-0 group-hover/note:visible"
        title="删除文件"
        onClick={(e) => {
          e.stopPropagation()
          onDelete()
        }}
      />
    </div>
  )
}
