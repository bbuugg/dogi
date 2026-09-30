import { useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  ExternalLink,
  FilePlus,
  FileText,
  Folder,
  FolderOpen,
  RefreshCw,
  Trash2
} from 'lucide-react'
import { Button, Dropdown, Input, Modal, Tree, message, type MenuProps, type TreeDataNode } from 'antd'
import { useAppStore } from '@/stores/app-store'
import { cn } from 'cn'
import type { NoteFileItem } from '@shared/types'

/** 侧边栏里「所打开的文件夹」自己那个根节点在 Tree 里的 key */
const ROOT_KEY = '__note-root__'

/**
 * 笔记侧边栏：打开本地文件夹后，以**该文件夹为根节点**展示其中的 Markdown 文件树。
 *
 * 顶层只显示文件夹本身（可展开/折叠），展开后才是里面的目录与文件 ——
 * 不把文件夹内容直接铺在侧边栏顶层，避免「看不出这些文件属于哪个目录」。
 *
 * - 顶部工具栏：打开文件夹 / 打开文件 / 新建笔记 / 刷新
 * - 文件树：点击文件打开编辑标签，目录可展开/折叠
 * - 右键菜单：新建 / 在文件管理器中打开 / 重命名 / 删除
 */
export function NotesPanel() {
  const noteFolder = useAppStore((s) => s.noteFolder)
  const noteFileTree = useAppStore((s) => s.noteFileTree)
  const openNoteFolder = useAppStore((s) => s.openNoteFolder)
  const openNoteFile = useAppStore((s) => s.openNoteFile)
  const readNoteFile = useAppStore((s) => s.readNoteFile)
  const createNoteFile = useAppStore((s) => s.createNoteFile)
  const refreshNoteFolder = useAppStore((s) => s.refreshNoteFolder)
  const renameNoteFile = useAppStore((s) => s.renameNoteFile)
  const deleteNoteFile = useAppStore((s) => s.deleteNoteFile)
  const openNoteTab = useAppStore((s) => s.openNoteTab)

  const [search, setSearch] = useState('')
  /** 展开的节点 key（完整相对路径；根节点用 ROOT_KEY） */
  const [expandedKeys, setExpandedKeys] = useState<string[]>([ROOT_KEY])
  /** 待确认删除的文件 */
  const [pendingDelete, setPendingDelete] = useState<{ path: string; name: string } | null>(null)
  /** 重命名对话框 */
  const [renameTarget, setRenameTarget] = useState<{ path: string; name: string } | null>(null)
  const [renameValue, setRenameValue] = useState('')

  /** 路径分隔符跟随已打开的文件夹（Windows 是 `\`，其它平台 `/`） */
  const sep = noteFolder && noteFolder.includes('\\') ? '\\' : '/'

  /**
   * 相对路径（用 `/` 分隔）→ 绝对路径。
   * 传给系统「打开文件位置」时必须还原成宿主平台的分隔符。
   */
  const absPath = (rel: string): string => {
    if (!noteFolder) return ''
    if (!rel) return noteFolder
    return `${noteFolder}${sep}${rel.split('/').join(sep)}`
  }

  /** 在系统文件管理器中定位：目录直接打开，文件在其所在目录中被选中 */
  const revealInExplorer = (rel: string): void => {
    void (async () => {
      const r = await window.api.shell.revealPath(absPath(rel))
      if (!r.ok) message.error(r.error ?? '打开文件位置失败')
    })()
  }

  /** 递归搜索过滤：返回命中文件名的节点（目录如果子项有命中也保留） */
  const filterTree = (items: NoteFileItem[], q: string): NoteFileItem[] => {
    if (!q) return items
    const lower = q.toLowerCase()
    return items
      .map((item) => {
        if (item.isDir) {
          const children = item.children ? filterTree(item.children, q) : []
          if (children.length > 0) return { ...item, children }
          return null
        }
        return item.name.toLowerCase().includes(lower) ? item : null
      })
      .filter(Boolean) as NoteFileItem[]
  }

  const q = search.trim().toLowerCase()
  const viewTree = q ? filterTree(noteFileTree, q) : noteFileTree

  /** 搜索时自动展开所有目录（含根节点） */
  const effectiveExpanded = q ? [ROOT_KEY, ...collectDirKeys(viewTree, '')] : expandedKeys

  /** 展开/折叠目录 */
  const toggleExpand = (key: string) => {
    setExpandedKeys((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]
    )
  }

  /**
   * 把 NoteFileItem[] 转成 antd Tree 需要的 TreeDataNode[]。
   *
   * ⚠️ `item.path` 只是相对**父目录**的一段（主进程 scanDir 是按层给的），
   * 拼上 parentPath 才是相对笔记根目录的完整路径。读写 / 重命名 / 删除
   * 全都要用完整路径 —— 少拼这一层，子目录里的文件就会报「读不到」
   * （拿到的路径缺了子目录那一段）。
   */
  const toTreeData = (items: NoteFileItem[], parentPath: string): TreeDataNode[] => {
    return items.map((item) => {
      const fullPath = parentPath ? `${parentPath}/${item.path}` : item.path
      if (item.isDir) {
        return {
          key: fullPath,
          selectable: false,
          title: (
            <DirRow
              name={item.name}
              expanded={effectiveExpanded.includes(fullPath)}
              onToggle={() => toggleExpand(fullPath)}
              onNew={() => void handleCreate(fullPath)}
              onReveal={() => revealInExplorer(fullPath)}
              onRename={() => {
                setRenameTarget({ path: fullPath, name: item.name })
                setRenameValue(item.name)
              }}
              onDelete={() => setPendingDelete({ path: fullPath, name: item.name })}
            />
          ),
          children: item.children ? toTreeData(item.children, fullPath) : []
        }
      }
      return {
        key: fullPath,
        selectable: false,
        isLeaf: true,
        title: (
          <FileRow
            item={item}
            onOpen={() => void handleOpenFile(fullPath)}
            onReveal={() => revealInExplorer(fullPath)}
            onRename={() => {
              setRenameTarget({ path: fullPath, name: item.name })
              setRenameValue(item.name)
            }}
            onDelete={() => setPendingDelete({ path: fullPath, name: item.name })}
          />
        )
      }
    })
  }

  const folderName = noteFolder ? noteFolder.split(/[\\/]/).filter(Boolean).pop() || noteFolder : ''

  /** 顶层树：只有一个「笔记文件夹」根节点，其余内容挂在它下面 */
  const treeData: TreeDataNode[] = noteFolder
    ? [
        {
          key: ROOT_KEY,
          selectable: false,
          title: (
            <DirRow
              name={folderName}
              expanded={effectiveExpanded.includes(ROOT_KEY)}
              onToggle={() => toggleExpand(ROOT_KEY)}
              onNew={() => void handleCreate('')}
              onReveal={() => revealInExplorer('')}
            />
          ),
          children: toTreeData(viewTree, '')
        }
      ]
    : []

  /** 打开文件：读取内容后开标签（relPath 是相对笔记文件夹的完整路径） */
  const handleOpenFile = async (relPath: string) => {
    try {
      const result = await readNoteFile(relPath)
      openNoteTab(result.path, result.path.split(/[\\/]/).pop() ?? relPath)
    } catch (e) {
      message.error(`打开文件失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  /** 打开文件夹 */
  const handleOpenFolder = async () => {
    try {
      await openNoteFolder()
    } catch (e) {
      message.error(`打开文件夹失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  /** 打开单个文件（不在文件夹模式下） */
  const handleOpenFileDirect = async () => {
    try {
      const result = await openNoteFile()
      if (result) {
        openNoteTab(result.path, result.path.split(/[\\/]/).pop() ?? result.path)
      }
    } catch (e) {
      message.error(`打开文件失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  /** 新建笔记文件（dirPath 是相对笔记文件夹的完整目录路径，空串 = 根目录） */
  const handleCreate = async (dirPath: string) => {
    try {
      const result = await createNoteFile(dirPath)
      openNoteTab(result.path, result.path.split(/[\\/]/).pop() ?? result.path)
      message.success('已新建笔记')
    } catch (e) {
      if (e instanceof Error && e.message === '用户取消') return
      message.error(`新建失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  /** 确认删除 */
  const confirmDelete = async () => {
    if (!pendingDelete) return
    const target = pendingDelete
    setPendingDelete(null)
    try {
      await deleteNoteFile(target.path)
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
      await renameNoteFile(renameTarget.path, name)
      setRenameTarget(null)
      message.success('已重命名')
    } catch (e) {
      message.error(`重命名失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const isEmpty = noteFileTree.length === 0

  return (
    <div className="flex h-full flex-col">
      {/* 工具栏 */}
      <div className="mb-1 flex items-center justify-between gap-1 px-3 py-1">
        <span className="text-sm font-medium text-muted-foreground truncate">
          {noteFolder ? folderName : '笔记'}
        </span>
        <div className="flex items-center gap-1">
          <Button
            type="text"
            size="small"
            className="px-0.5 text-muted-foreground"
            title="打开文件夹"
            icon={<FolderOpen className="size-3.5" />}
            onClick={() => void handleOpenFolder()}
          />
          <Button
            type="text"
            size="small"
            className="px-0.5 text-muted-foreground"
            title="打开文件"
            icon={<FileText className="size-3.5" />}
            onClick={() => void handleOpenFileDirect()}
          />
          {noteFolder && (
            <>
              <Button
                type="text"
                size="small"
                className="px-0.5 text-muted-foreground"
                title="新建笔记"
                icon={<FilePlus className="size-3.5" />}
                onClick={() => void handleCreate('')}
              />
              <Button
                type="text"
                size="small"
                className="px-0.5 text-muted-foreground"
                title="刷新"
                icon={<RefreshCw className="size-3.5" />}
                onClick={() => void refreshNoteFolder()}
              />
            </>
          )}
        </div>
      </div>

      {noteFolder && (
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
        {!noteFolder ? (
          <div className="mx-2 mt-8 rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
            点击上方「打开文件夹」选择笔记目录，
            <br />
            或「打开文件」直接编辑单个 Markdown 文件。
          </div>
        ) : isEmpty ? (
          <div className="mx-2 mt-8 rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
            该文件夹下没有 Markdown 文件。
            <br />
            点击「新建笔记」创建第一个。
          </div>
        ) : q && viewTree.length === 0 ? (
          <div className="mx-2 mt-8 rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
            没有匹配「{search}」的文件。
          </div>
        ) : (
          <Tree
            className="side-tree notes-tree"
            treeData={treeData}
            selectable={false}
            blockNode
            showLine={false}
            expandedKeys={effectiveExpanded}
            onExpand={(keys) => setExpandedKeys(keys.map(String))}
          />
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

/** 收集树中所有目录的 key（搜索时自动展开） */
function collectDirKeys(items: NoteFileItem[], parentPath: string): string[] {
  const keys: string[] = []
  for (const item of items) {
    if (item.isDir) {
      const fullPath = parentPath ? `${parentPath}/${item.path}` : item.path
      keys.push(fullPath)
      if (item.children) keys.push(...collectDirKeys(item.children, fullPath))
    }
  }
  return keys
}

/**
 * 目录行：展开/折叠箭头 + 文件夹图标 + 名称 + 右键菜单。
 * 点击箭头或名称行都能切换展开/折叠。
 *
 * `onRename` / `onDelete` 不给时（根节点「笔记文件夹」）菜单里就不出现这两项 ——
 * 重命名 / 删除笔记根目录不是这个面板该干的事。
 */
function DirRow({
  name,
  expanded,
  onToggle,
  onNew,
  onReveal,
  onRename,
  onDelete
}: {
  name: string
  expanded: boolean
  onToggle: () => void
  onNew: () => void
  onReveal: () => void
  onRename?: () => void
  onDelete?: () => void
}) {
  const items: MenuProps['items'] = [
    { key: 'new', icon: <FilePlus className="size-3.5" />, label: '在此新建笔记' },
    { key: 'reveal', icon: <ExternalLink className="size-3.5" />, label: '在文件管理器中打开' },
    ...(onRename && onDelete
      ? [
          { type: 'divider' as const },
          { key: 'rename', icon: <FileText className="size-3.5" />, label: '重命名' },
          { key: 'delete', icon: <Trash2 className="size-3.5" />, label: '删除', danger: true }
        ]
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
          else if (key === 'rename') onRename?.()
          else if (key === 'delete') onDelete?.()
        }
      }}
    >
      <div
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 py-0.5"
        onClick={(e) => {
          e.stopPropagation()
          onToggle()
        }}
      >
        {expanded ? (
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        {expanded ? (
          <FolderOpen className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <Folder className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className="truncate text-[13px] font-medium">{name}</span>
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
          <FileText className="size-3.5 shrink-0 opacity-70" />
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
