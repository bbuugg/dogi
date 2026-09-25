import {
  useEffect,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode
} from 'react'
import { Button, Modal, Tooltip, message } from 'antd'
import {
  ChevronDown,
  ChevronRight,
  File as FileIcon,
  FileAudio,
  FileCode,
  FileImage,
  FileJson,
  FileText,
  FileVideo,
  Files,
  Folder,
  FolderOpen,
  Loader2,
  Pencil,
  RefreshCw,
  Save,
  X,
  Eye
} from 'lucide-react'
import MonacoEditor from '@/shared/components/MonacoEditor'
import { FilePreview, UnsupportedPreview } from '@/features/agent/FilePreview'
import { ResizeHandle } from '@/shared/components/ResizeHandle'
import { cn } from 'cn'
import {
  buildWorkspaceMediaUrl,
  isEditable,
  isPreviewable,
  previewKindOf,
  type PreviewKind
} from '@shared/workspace-media'
import type { AgentFsEntry } from '@shared/types'

/** 按文件名 / 扩展名猜 Monaco 语言（无扩展名的特殊文件如 Dockerfile 走文件名表） */
const LANG_BY_NAME: Record<string, string> = {
  dockerfile: 'dockerfile',
  makefile: 'plaintext',
  '.gitignore': 'plaintext',
  '.npmrc': 'ini',
  '.env': 'ini'
}

const LANG_BY_EXT: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  jsonc: 'json',
  md: 'markdown',
  markdown: 'markdown',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'html',
  htm: 'html',
  vue: 'html',
  xml: 'xml',
  svg: 'xml',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'ini',
  ini: 'ini',
  conf: 'ini',
  env: 'ini',
  properties: 'ini',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  py: 'python',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  php: 'php',
  rb: 'ruby',
  swift: 'swift',
  sql: 'sql',
  lua: 'lua',
  dart: 'dart',
  txt: 'plaintext',
  log: 'plaintext'
}

/** 代码类扩展名：树上用不同的文件图标区分「代码 / 配置 / 普通文本」 */
const CODE_EXTS = new Set([
  'ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs', 'vue',
  'py', 'go', 'rs', 'java', 'kt', 'c', 'h', 'cpp', 'cc', 'hpp', 'cs',
  'php', 'rb', 'swift', 'lua', 'dart', 'sh', 'bash', 'zsh', 'sql'
])

function languageOf(fileName: string): string {
  const lower = fileName.toLowerCase()
  if (LANG_BY_NAME[lower]) return LANG_BY_NAME[lower]
  const ext = lower.includes('.') ? lower.slice(lower.lastIndexOf('.') + 1) : ''
  return LANG_BY_EXT[ext] ?? 'plaintext'
}

function FileTypeIcon({ name }: { name: string }) {
  const lower = name.toLowerCase()
  const ext = lower.includes('.') ? lower.slice(lower.lastIndexOf('.') + 1) : ''
  if (ext === 'json' || ext === 'jsonc') {
    return <FileJson className="size-4 shrink-0 text-amber-500" />
  }
  // 可预览的媒体在树上单独给图标，一眼看出哪些点开是图/视频
  const kind = previewKindOf(name)
  if (kind === 'image' || kind === 'svg') {
    return <FileImage className="size-4 shrink-0 text-emerald-500" />
  }
  if (kind === 'video') {
    return <FileVideo className="size-4 shrink-0 text-violet-500" />
  }
  if (kind === 'audio') {
    return <FileAudio className="size-4 shrink-0 text-pink-500" />
  }
  if (CODE_EXTS.has(ext)) {
    return <FileCode className="size-4 shrink-0 text-sky-500" />
  }
  return <FileText className="size-4 shrink-0 text-muted-foreground" />
}

/** Electron 会把主进程抛的错包一层，这里剥掉前缀只留真正的原因 */
function describeError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  return raw.replace(/^Error invoking remote method '[^']*':\s*(Error:\s*)?/, '')
}

/** 一个目录的懒加载状态；`entries` 为 null 表示还没读过 */
interface DirState {
  open: boolean
  loading: boolean
  entries: AgentFsEntry[] | null
}

/** 文件树里的一行（目录与文件共用，靠 expandable 区分左侧占位） */
function TreeRow({
  depth,
  icon,
  label,
  active,
  expandable,
  open,
  onClick
}: {
  depth: number
  icon: ReactNode
  label: string
  active?: boolean
  expandable?: boolean
  open?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      style={{ paddingLeft: 8 + depth * 14 }}
      className={cn(
        'flex w-full items-center gap-1.5 py-1 pr-2 text-left text-sm',
        active ? 'bg-primary/15 text-foreground' : 'text-muted-foreground',
        'hover:bg-foreground/10'
      )}
    >
      {expandable ? (
        open ? (
          <ChevronDown className="size-3.5 shrink-0" />
        ) : (
          <ChevronRight className="size-3.5 shrink-0" />
        )
      ) : (
        <span className="w-3.5 shrink-0" />
      )}
      {icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </button>
  )
}

/** 文件树列的默认 / 极限宽度（px）；行内是 text-sm，默认宽度相应放大一点 */
const TREE_DEFAULT_WIDTH = 240
const TREE_MIN_WIDTH = 160
const TREE_MAX_WIDTH = 520

/**
 * 工作区文件视图：左侧文件树（懒加载）+ 右侧 Monaco 编辑区。
 * 本体不自带外壳，由 AgentPage 的右侧抽屉（RightDrawer）包起来展示。
 *
 * 树只读一层展开一层（大项目的整棵树一次读不完），忽略规则与 Agent 工具一致
 * （`.gitignore` + 默认忽略目录），所以 node_modules / dist 不会出现在树里。
 * 编辑区可改可存：Ctrl+S 或标题栏的保存按钮落盘，标题栏用圆点标记未保存。
 */
export function AgentFilesPanel({
  workspaceId,
  workspaceName,
  onClose
}: {
  workspaceId: string
  workspaceName: string
  /** 由外层抽屉注入：点关闭收起整个文件视图（不传则不渲染该按钮） */
  onClose?: () => void
}) {
  const [dirs, setDirs] = useState<Record<string, DirState>>({})
  const [treeWidth, setTreeWidth] = useState(TREE_DEFAULT_WIDTH)
  /** 当前打开的文件（相对工作区根的路径） */
  const [activePath, setActivePath] = useState<string | null>(null)
  /** 当前文件的预览类型（null = 普通文本；见 @shared/workspace-media） */
  const [activeKind, setActiveKind] = useState<PreviewKind | null>(null)
  /** 预览 / 编辑（只有 svg 两种都行，其余按类型固定） */
  const [viewMode, setViewMode] = useState<'preview' | 'edit'>('edit')
  const [content, setContent] = useState('')
  /** 上次落盘的内容：和 content 比对得出「未保存」 */
  const [savedContent, setSavedContent] = useState('')
  const [loadingFile, setLoadingFile] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const dirty = activePath !== null && content !== savedContent
  /** 当前文件是否走预览（svg 两种形态都支持，看用户切到哪一边） */
  const showPreview = isPreviewable(activeKind) && (activeKind !== 'svg' || viewMode === 'preview')
  const editable = isEditable(activeKind)

  /** 读一个目录（已读过且只是收起/展开时不重复读） */
  const loadDir = async (dir: string): Promise<void> => {
    setDirs((d) => ({
      ...d,
      [dir]: { open: true, loading: true, entries: d[dir]?.entries ?? null }
    }))
    try {
      const entries = await window.api.agent.fs.list(workspaceId, dir)
      setDirs((d) => ({ ...d, [dir]: { open: true, loading: false, entries } }))
    } catch (err) {
      setDirs((d) => ({ ...d, [dir]: { open: true, loading: false, entries: [] } }))
      message.error(describeError(err))
    }
  }

  // 换工作区：整棵树与打开的文件都重来
  useEffect(() => {
    setDirs({})
    setActivePath(null)
    setActiveKind(null)
    setViewMode('edit')
    setContent('')
    setSavedContent('')
    setLoadError(null)
    void loadDir('')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId])

  const toggleDir = (dir: string): void => {
    const state = dirs[dir]
    if (!state?.entries) {
      void loadDir(dir)
      return
    }
    setDirs((d) => ({ ...d, [dir]: { ...state, open: !state.open } }))
  }

  const refresh = (): void => {
    setDirs({})
    void loadDir('')
  }

  const doOpen = async (entry: AgentFsEntry): Promise<void> => {
    const kind = previewKindOf(entry.name)
    setActiveKind(kind)
    setLoadError(null)

    // 纯二进制（图片 / 音视频 / 压缩包…）：不读文本，直接预览或提示不支持
    if (kind !== null && kind !== 'svg') {
      setActivePath(entry.path)
      setContent('')
      setSavedContent('')
      setViewMode('preview')
      return
    }

    setLoadingFile(true)
    try {
      const file = await window.api.agent.fs.read(workspaceId, entry.path)
      setActivePath(entry.path)
      setContent(file.content)
      setSavedContent(file.content)
      // svg 默认给预览（点开多半是想看图），要看源码再切「编辑」
      setViewMode(kind === 'svg' ? 'preview' : 'edit')
    } catch (err) {
      // 读不了（太大 / 权限 / 其实是二进制）：仍然选中该条目，把原因摆在编辑区里
      setActivePath(entry.path)
      setContent('')
      setSavedContent('')
      setViewMode('edit')
      setLoadError(describeError(err))
    } finally {
      setLoadingFile(false)
    }
  }

  const selectFile = (entry: AgentFsEntry): void => {
    if (entry.path === activePath) return
    if (dirty) {
      Modal.confirm({
        title: '有未保存的修改',
        content: `「${activePath}」的改动还没保存，切换文件会丢失。`,
        okText: '丢弃并切换',
        cancelText: '取消',
        okButtonProps: { danger: true },
        onOk: () => void doOpen(entry)
      })
      return
    }
    void doOpen(entry)
  }

  const save = async (): Promise<void> => {
    if (!activePath || !dirty || saving) return
    setSaving(true)
    try {
      await window.api.agent.fs.write(workspaceId, activePath, content)
      setSavedContent(content)
    } catch (err) {
      message.error(`保存失败：${describeError(err)}`)
    } finally {
      setSaving(false)
    }
  }

  /** Ctrl/Cmd+S 保存（捕获阶段截住，别让 Monaco 或浏览器抢走） */
  const handleKeyDown = (e: ReactKeyboardEvent): void => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault()
      e.stopPropagation()
      void save()
    }
  }

  /** 递归渲染某个目录下的条目 */
  const renderEntries = (dir: string, depth: number): ReactNode[] => {
    const state = dirs[dir]
    if (!state?.entries) return []
    const rows: ReactNode[] = []
    for (const entry of state.entries) {
      if (entry.type === 'dir') {
        const child = dirs[entry.path]
        const open = !!child?.open
        rows.push(
          <TreeRow
            key={entry.path}
            depth={depth}
            expandable
            open={open}
            icon={
              open ? (
                <FolderOpen className="size-4 shrink-0 text-primary/80" />
              ) : (
                <Folder className="size-4 shrink-0 text-primary/80" />
              )
            }
            label={entry.name}
            onClick={() => toggleDir(entry.path)}
          />
        )
        if (open) {
          if (child?.loading && !child.entries) {
            rows.push(
              <div
                key={`${entry.path}__loading`}
                style={{ paddingLeft: 8 + (depth + 1) * 14 + 20 }}
                className="flex items-center gap-1.5 py-1 text-sm text-muted-foreground"
              >
                <Loader2 className="size-3.5 animate-spin" />
                读取中…
              </div>
            )
          } else {
            rows.push(...renderEntries(entry.path, depth + 1))
          }
        }
      } else {
        rows.push(
          <TreeRow
            key={entry.path}
            depth={depth}
            icon={<FileTypeIcon name={entry.name} />}
            label={entry.name}
            active={entry.path === activePath}
            onClick={() => selectFile(entry)}
          />
        )
      }
    }
    return rows
  }

  const fileName = activePath ? activePath.split('/').pop() ?? activePath : null

  return (
    <div
      onKeyDownCapture={handleKeyDown}
      className="flex h-full min-h-0 w-full bg-background"
    >
      {/* 左：文件树 */}
      <div
        style={{ width: treeWidth }}
        className="flex min-h-0 shrink-0 flex-col border-r border-border/70"
      >
        <div className="flex h-9 shrink-0 items-center gap-1.5 px-2.5">
          <Files className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate text-sm font-medium" title={workspaceName}>
            {workspaceName}
          </span>
          <Tooltip title="刷新文件树">
            <Button
              type="text"
              size="small"
              icon={<RefreshCw className="size-3.5" />}
              className="w-7 shrink-0 p-0 text-muted-foreground"
              onClick={refresh}
            />
          </Tooltip>
          {onClose && (
            <Tooltip title="关闭文件视图">
              <Button
                type="text"
                size="small"
                icon={<X className="size-3.5" />}
                className="w-7 shrink-0 p-0 text-muted-foreground"
                onClick={onClose}
              />
            </Tooltip>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-auto pb-2">
          {renderEntries('', 0)}
          {dirs['']?.loading && !dirs['']?.entries && (
            <div className="flex items-center gap-1.5 px-3 py-2 text-sm text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              读取中…
            </div>
          )}
        </div>
      </div>

      <ResizeHandle
        width={treeWidth}
        min={TREE_MIN_WIDTH}
        max={TREE_MAX_WIDTH}
        onResize={setTreeWidth}
      />

      {/* 右：编辑区 */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-border/70 px-2.5">
          {fileName ? (
            <>
              <FileTypeIcon name={fileName} />
              <span className="min-w-0 flex-1 truncate text-sm" title={activePath ?? ''}>
                {activePath}
              </span>
              {/* svg 既是图片又是 XML：给一个预览 / 编辑的切换 */}
              {activeKind === 'svg' && (
                <div className="flex shrink-0 items-center gap-0.5 rounded-md border border-border/70 p-0.5">
                  <button
                    type="button"
                    title="预览"
                    aria-label="预览"
                    aria-pressed={viewMode === 'preview'}
                    onClick={() => setViewMode('preview')}
                    className={cn(
                      'rounded px-1.5 py-0.5 transition-colors',
                      viewMode === 'preview'
                        ? 'bg-primary/15 text-primary'
                        : 'text-muted-foreground hover:bg-foreground/10'
                    )}
                  >
                    <Eye className="size-3.5" />
                  </button>
                  <button
                    type="button"
                    title="编辑源码"
                    aria-label="编辑源码"
                    aria-pressed={viewMode === 'edit'}
                    onClick={() => setViewMode('edit')}
                    className={cn(
                      'rounded px-1.5 py-0.5 transition-colors',
                      viewMode === 'edit'
                        ? 'bg-primary/15 text-primary'
                        : 'text-muted-foreground hover:bg-foreground/10'
                    )}
                  >
                    <Pencil className="size-3.5" />
                  </button>
                </div>
              )}
              {dirty && (
                <Tooltip title="有未保存的修改">
                  <span className="size-1.5 shrink-0 rounded-full bg-amber-500" />
                </Tooltip>
              )}
              {editable && (
                <Tooltip title={dirty ? '保存（Ctrl+S）' : '没有需要保存的修改'}>
                  <Button
                    type="text"
                    size="small"
                    icon={
                      saving ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <Save className="size-3.5" />
                      )
                    }
                    className={cn('w-7 shrink-0 p-0', dirty ? 'text-primary' : 'text-muted-foreground')}
                    disabled={!dirty || saving}
                    onClick={() => void save()}
                  />
                </Tooltip>
              )}
            </>
          ) : (
            <span className="text-sm text-muted-foreground">未打开文件</span>
          )}
        </div>

        <div className="min-h-0 flex-1">
          {loadError ? (
            <div className="flex h-full items-center justify-center px-6">
              <div className="max-w-md text-center text-sm text-muted-foreground">
                <FileIcon className="mx-auto mb-2 size-8 opacity-30" />
                {loadError}
              </div>
            </div>
          ) : activePath && activeKind === 'binary' ? (
            <UnsupportedPreview fileName={fileName ?? activePath} />
          ) : activePath && showPreview ? (
            <FilePreview
              kind={activeKind as 'image' | 'svg' | 'video' | 'audio'}
              url={buildWorkspaceMediaUrl(workspaceId, activePath)}
              fileName={fileName ?? activePath}
            />
          ) : activePath ? (
            <MonacoEditor
              value={content}
              onChange={setContent}
              language={languageOf(activePath)}
              readOnly={loadingFile}
              showHeader={false}
            />
          ) : (
            <div className="flex h-full items-center justify-center px-6">
              <div className="text-center text-sm text-muted-foreground">
                <Files className="mx-auto mb-2 size-8 opacity-30" />
                从左侧选择一个文件查看或编辑
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
