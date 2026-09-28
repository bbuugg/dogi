import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode
} from 'react'
import { Button, Modal, Tooltip, message } from 'antd'
import {
  ChevronDown,
  ChevronLeft,
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
  Eye,
  X
} from 'lucide-react'
import MonacoEditor, { disposeUnusedModels, syncModelEol } from '@/shared/components/MonacoEditor'
import { FilePreview, UnsupportedPreview } from '@/features/agent/FilePreview'
import { ResizeHandle } from '@/shared/components/ResizeHandle'
import {
  modelUri,
  modelUriPrefix,
  pathFromModelUri,
  readPanelState,
  writePanelState,
  type OpenFile,
  type PanelState
} from '@/features/agent/file-panel-state'
import { cn } from 'cn'
import { buildWorkspaceMediaUrl, isEditable, isPreviewable, previewKindOf } from '@shared/workspace-media'
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

/** 标签条把激活标签滚进可视区时，标签与可视边缘留出的空隙（px） */
const TAB_SCROLL_CLEAR = 8

/** 取路径里的文件名（标签显示用） */
function baseName(path: string): string {
  return path.split('/').pop() ?? path
}

/**
 * 标签上显示的名字。同名文件（不同目录下的两个 `index.ts`）会带上父目录，
 * 否则并排两个一模一样的标签谁也分不清 —— 名字不冲突时只显示文件名。
 */
function tabLabel(path: string, duplicated: Set<string>): string {
  const name = baseName(path)
  if (!duplicated.has(name)) return name
  const parent = path.split('/').slice(-2)[0]
  return parent ? `${parent}/${name}` : name
}

/**
 * 工作区文件视图：左侧文件树（懒加载）+ 右侧**多标签**编辑区。
 * 本体不自带外壳：AgentPage 把它作为右侧多标签面板（SidePanel）里的「文件」标签展示。
 *
 * 树只读一层展开一层（大项目的整棵树一次读不完），忽略规则与 Agent 工具一致
 * （`.gitignore` + 默认忽略目录），所以 node_modules / dist 不会出现在树里。
 *
 * 编辑区可改可存：Ctrl+S 或标签条右端的保存按钮落盘，标签上的圆点标记未保存。
 * 打开多个文件就是多个标签：各自保留内容与未保存状态，关闭有改动的标签会先确认。
 *
 * **标签按工作区各留一份**（见 file-panel-state.ts）：在侧边栏切到别的工作区再切回来，
 * 原先开着的标签、未保存的改动都还在（目录树本身会重读，它没有需要保留的编辑态）。
 */
export function AgentFilesPanel({
  workspaceId,
  workspaceName
}: {
  workspaceId: string
  workspaceName: string
}) {
  const [dirs, setDirs] = useState<Record<string, DirState>>({})
  const [treeWidth, setTreeWidth] = useState(TREE_DEFAULT_WIDTH)
  /**
   * 面板状态（打开的文件 + 当前标签）。**整对象自带 workspaceId**，切换工作区时不做搬运 ——
   * props 变了就直接读新工作区的那份快照，旧的早已按自己的 id 存好（理由见 file-panel-state.ts）。
   */
  const [panel, setPanel] = useState<PanelState>(() => readPanelState(workspaceId))
  /** 正在保存的路径（保存是异步的，避免重复点） */
  const [savingPath, setSavingPath] = useState<string | null>(null)
  /** 标签条 DOM：量滚动位置用（箭头可用性 / 激活标签滚入可视区） */
  const stripRef = useRef<HTMLDivElement | null>(null)
  /** 标签条溢出时左右箭头是否可用。箭头**常驻**（置灰 = 不可用）——按需出现会改变
   * 滚动区宽度，在临界宽度附近会反复横跳，常驻就没这个问题 */
  const [tabScroll, setTabScroll] = useState({ left: false, right: false })

  /**
   * 当前工作区的状态：切换工作区的**那一帧**里 `panel` 还停在旧工作区（state 要等这次渲染
   * 之后才更新），这时直接用缓存里的新快照顶上 —— 界面不会先闪一下旧标签。
   */
  const current = panel.workspaceId === workspaceId ? panel : readPanelState(workspaceId)
  const files = current.files
  const activeFilePath = current.activeFilePath
  const active = files.find((f) => f.path === activeFilePath) ?? null
  const dirty = active !== null && active.content !== active.savedContent
  /** 同名（文件名撞车）的名字集合：这些标签要带上父目录才分得清 */
  const duplicatedNames = useMemo(() => {
    const count = new Map<string, number>()
    for (const f of files) {
      const name = baseName(f.path)
      count.set(name, (count.get(name) ?? 0) + 1)
    }
    return new Set([...count.entries()].filter(([, n]) => n > 1).map(([name]) => name))
  }, [files])

  /** 改**当前工作区**的状态（界面交互走这里） */
  const mutatePanel = (fn: (base: PanelState) => PanelState): void => {
    setPanel((cur) => fn(cur.workspaceId === workspaceId ? cur : readPanelState(workspaceId)))
  }

  /**
   * 改**指定工作区**的状态：只有当它正被看着时才动 state，否则直接改缓存。
   *
   * 异步回调（读文件 / 保存）必须用它 —— 结果回来时用户可能已经切到别的工作区了，
   * 用 `mutatePanel` 会把 A 的结果写进 B 的标签里。
   */
  const mutatePanelFor = (ws: string, fn: (base: PanelState) => PanelState): void => {
    if (ws === workspaceId) {
      mutatePanel(fn)
      return
    }
    writePanelState(fn(readPanelState(ws)))
  }

  /** 改某个已打开文件的字段（只动那一个标签） */
  const patchFile = (path: string, patch: Partial<OpenFile>): void => {
    mutatePanel((p) => ({
      ...p,
      files: p.files.map((f) => (f.path === path ? { ...f, ...patch } : f))
    }))
  }

  // 状态一有变化就镜像进缓存（缓存不是真源，只是「离开这个工作区之后它还在」的存放处）
  useEffect(() => {
    writePanelState(panel)
  }, [panel])

  /**
   * 回收**这个工作区里已不再打开**的文件 model（关闭标签后它们会一直占着内存）。
   *
   * 放在 effect 里而不是关标签那一刻：关掉的往往正是当前标签，编辑器那时还指着它 ——
   * 详见 MonacoEditor 的 `disposeUnusedModels`。依赖用「打开着的路径串」而不是 `files`：
   * 后者每敲一个字都是新数组，会变成每次击键都去扫一遍 model。
   */
  const openPaths = files.map((f) => f.path).join('\n')
  useEffect(() => {
    disposeUnusedModels(
      modelUriPrefix(workspaceId),
      openPaths ? openPaths.split('\n').map((p) => modelUri(workspaceId, p)) : []
    )
  }, [workspaceId, openPaths])

  // ── 标签条横向滚动（标签多到溢出时）──────────────────────────────

  /** 按当前滚动位置刷新左右箭头的可用状态（值没变就不触发重渲染） */
  const updateTabScroll = useCallback((): void => {
    const el = stripRef.current
    if (!el) return
    const overflow = el.scrollWidth - el.clientWidth
    // 剩余可滚量 ≤ TAB_SCROLL_CLEAR（激活标签滚进可视区后留的空隙）时视为已到头，
    // 否则箭头亮着却只差几个像素，点了像没反应
    const left = overflow > TAB_SCROLL_CLEAR && el.scrollLeft > 1
    const right = overflow > TAB_SCROLL_CLEAR && el.scrollLeft < overflow - TAB_SCROLL_CLEAR
    setTabScroll((prev) => (prev.left === left && prev.right === right ? prev : { left, right }))
  }, [])

  /** 箭头点击：一次翻大半屏 */
  const scrollStrip = (dir: -1 | 1): void => {
    const el = stripRef.current
    if (!el) return
    el.scrollBy({ left: dir * Math.max(160, el.clientWidth * 0.75), behavior: 'smooth' })
  }

  // 纵向滚轮转成横向滚动（标签条本身不会纵向滚）；触控板的横向滚动浏览器自己会处理
  const hasFiles = files.length > 0
  useEffect(() => {
    if (!hasFiles) return
    const el = stripRef.current
    if (!el) return
    updateTabScroll()
    const ro =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => updateTabScroll())
    if (ro) ro.observe(el)
    const onWheel = (e: WheelEvent): void => {
      if (e.deltaX !== 0 || e.deltaY === 0) return
      if (el.scrollWidth <= el.clientWidth + 1) return
      e.preventDefault()
      el.scrollLeft += e.deltaY
    }
    el.addEventListener('scroll', updateTabScroll, { passive: true })
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      ro?.disconnect()
      el.removeEventListener('scroll', updateTabScroll)
      el.removeEventListener('wheel', onWheel)
    }
  }, [hasFiles, updateTabScroll])

  /**
   * 激活标签变化（或标签增删）时把它横向滚进可视区 —— 与主区标签条（PanelView）同一套
   * 语义：只滚必要的距离，不干扰手动滚动；顺带刷新箭头的可用状态。
   */
  useEffect(() => {
    const strip = stripRef.current
    if (!strip || !activeFilePath) return
    const el = strip.querySelector<HTMLElement>(`[data-file-tab="${CSS.escape(activeFilePath)}"]`)
    if (el) {
      const tabRect = el.getBoundingClientRect()
      const stripRect = strip.getBoundingClientRect()
      let delta = 0
      if (tabRect.left < stripRect.left + TAB_SCROLL_CLEAR) {
        delta = tabRect.left - stripRect.left - TAB_SCROLL_CLEAR
      } else if (tabRect.right > stripRect.right - TAB_SCROLL_CLEAR) {
        delta = tabRect.right - stripRect.right + TAB_SCROLL_CLEAR
      }
      if (Math.abs(delta) >= 1) strip.scrollBy({ left: delta, behavior: 'smooth' })
    }
    updateTabScroll()
  }, [activeFilePath, files.length, updateTabScroll])

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

  /**
   * 读一个文件的内容并回填到**它所属工作区**的标签上。
   *
   * `openFile` 与「切回工作区时补读」共用这一条路径：回调里不碰当前 state，
   * 而是按参数里的工作区写回去，所以读到一半被切走也不会把内容串到别的工作区。
   */
  const readFileInto = async (ws: string, path: string): Promise<void> => {
    try {
      const file = await window.api.agent.fs.read(ws, path)
      // 内容写进 model 之前先把行尾定准：model 是标签打开时就建好的空 model（平台默认
      // 行尾），不先掰成文件自己的行尾，库写内容时会把 LF 归一成 CRLF —— 之后原样撤销
      // 也算「有改动」，保存还会改掉整个文件的换行（见 syncModelEol）
      await syncModelEol(modelUri(ws, path), file.content)
      mutatePanelFor(ws, (p) => ({
        ...p,
        files: p.files.map((f) =>
          f.path === path
            ? { ...f, content: file.content, savedContent: file.content, loading: false }
            : f
        )
      }))
    } catch (err) {
      // 读不了（太大 / 权限 / 其实是二进制）：标签留着，把原因摆在编辑区里
      mutatePanelFor(ws, (p) => ({
        ...p,
        files: p.files.map((f) =>
          f.path === path ? { ...f, loadError: describeError(err), loading: false, mode: 'edit' } : f
        )
      }))
    }
  }

  // 换工作区：目录树重读（**标签不走这里** —— 每个工作区各留一份，见 file-panel-state.ts）；
  // 顺手把「上次读到一半就被切走」的标签补读一次，否则那些标签会一直转圈
  useEffect(() => {
    setDirs({})
    void loadDir('')
    for (const f of readPanelState(workspaceId).files) {
      if (f.loading) void readFileInto(workspaceId, f.path)
    }
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

  /**
   * 打开一个文件：已经有它的标签就切过去（**保留那份未保存的改动，不重读**），
   * 否则新开一个标签挂在末尾。
   */
  const openFile = async (entry: AgentFsEntry): Promise<void> => {
    const path = entry.path
    if (files.some((f) => f.path === path)) {
      mutatePanel((p) => ({ ...p, activeFilePath: path }))
      return
    }
    const kind = previewKindOf(entry.name)
    // 纯二进制（图片 / 音视频 / 压缩包…）：不读文本，直接预览或提示不支持
    const binary = kind !== null && kind !== 'svg'
    const added: OpenFile = {
      path,
      kind,
      // svg 默认给预览（点开多半是想看图），要看源码再切「编辑」
      mode: binary || kind === 'svg' ? 'preview' : 'edit',
      content: '',
      savedContent: '',
      loadError: null,
      // 文本 / SVG 要先读内容（「读取中」的标签立即可见、可切走）；纯二进制没有内容可读
      loading: !binary
    }
    mutatePanel((p) => ({ ...p, files: [...p.files, added], activeFilePath: path }))
    if (added.loading) await readFileInto(workspaceId, path)
  }

  /** 关掉一个标签（已确认丢弃改动之后走这里） */
  const doCloseFile = (path: string): void => {
    const idx = files.findIndex((f) => f.path === path)
    const next = files.filter((f) => f.path !== path)
    mutatePanel((p) => ({
      ...p,
      files: next,
      // 关掉的正是当前标签：优先切到右边那个（浏览器的习惯），没有就切左边
      activeFilePath:
        p.activeFilePath === path
          ? (next[idx]?.path ?? next[idx - 1]?.path ?? null)
          : p.activeFilePath
    }))
  }

  /** 关标签：有未保存的改动先确认（每个标签自己一份内容，所以只是「这条要丢」） */
  const closeFile = (path: string): void => {
    const target = files.find((f) => f.path === path)
    if (target && target.content !== target.savedContent) {
      Modal.confirm({
        title: '有未保存的修改',
        content: `「${path}」的改动还没保存，关闭这个标签会丢失。`,
        okText: '丢弃并关闭',
        cancelText: '取消',
        okButtonProps: { danger: true },
        onOk: () => doCloseFile(path)
      })
      return
    }
    doCloseFile(path)
  }

  /** 保存某个标签（缺省 = 当前标签） */
  const save = async (path: string | null = activeFilePath): Promise<void> => {
    const file = files.find((f) => f.path === path)
    if (!file || file.loading || file.content === file.savedContent || savingPath) return
    setSavingPath(file.path)
    // 记下发起时的工作区与内容：写完可能已经切走了，结果要落回原工作区、且基准是**当时**那份内容
    const ws = workspaceId
    const saved = file.content
    try {
      await window.api.agent.fs.write(ws, file.path, saved)
      mutatePanelFor(ws, (p) => ({
        ...p,
        files: p.files.map((f) => (f.path === file.path ? { ...f, savedContent: saved } : f))
      }))
    } catch (err) {
      message.error(`保存失败：${describeError(err)}`)
    } finally {
      setSavingPath(null)
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
            active={entry.path === activeFilePath}
            onClick={() => void openFile(entry)}
          />
        )
      }
    }
    return rows
  }

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

      {/* 右：编辑区（多标签） */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {files.length > 0 && (
          <div className="flex h-9 shrink-0 items-center gap-1 pr-2.5 pl-1">
            {/* 已打开的文件：一个文件一个标签，横向滚动不换行；溢出时滚轮 / 箭头左右滚动 */}
            <button
              type="button"
              title="向左滚动标签"
              aria-label="向左滚动标签"
              disabled={!tabScroll.left}
              onClick={() => scrollStrip(-1)}
              className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
            >
              <ChevronLeft className="size-3.5" />
            </button>
            <div
              ref={stripRef}
              className="no-scrollbar flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto"
            >
              {files.map((f) => {
                const isActive = f.path === activeFilePath
                const label = tabLabel(f.path, duplicatedNames)
                return (
                  <div
                    key={f.path}
                    // 标签条按这个属性定位激活项，好把它滚进可视区
                    data-file-tab={f.path}
                    // 中键关闭：编辑器 / 浏览器的通用习惯
                    onMouseDown={(e) => {
                      if (e.button !== 1) return
                      e.preventDefault()
                      closeFile(f.path)
                    }}
                    className={cn(
                      'group/ftab flex min-w-24 shrink-0 items-center rounded-md pr-1 transition-colors',
                      isActive
                        ? 'bg-secondary text-foreground'
                        : 'text-muted-foreground hover:bg-secondary/60'
                    )}
                  >
                    <button
                      type="button"
                      // 标题给完整相对路径：标签上只放文件名（同名时带父目录）
                      title={f.path}
                      aria-pressed={isActive}
                      onClick={() => mutatePanel((p) => ({ ...p, activeFilePath: f.path }))}
                      className="flex min-w-0 flex-1 items-center gap-1.5 py-1 pl-2 text-[13px]"
                    >
                      {f.loading ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <FileTypeIcon name={baseName(f.path)} />
                      )}
                      <span className="min-w-0 max-w-56 flex-1 truncate">{label}</span>
                      {f.content !== f.savedContent && (
                        <span
                          title="有未保存的修改"
                          className="size-1.5 shrink-0 rounded-full bg-amber-500"
                        />
                      )}
                    </button>
                    <button
                      type="button"
                      title={`关闭 ${label}`}
                      aria-label={`关闭 ${label}`}
                      onClick={() => closeFile(f.path)}
                      className="shrink-0 rounded p-0.5 opacity-0 transition-opacity hover:bg-foreground/10 group-hover/ftab:opacity-100"
                    >
                      <X className="size-3.5" />
                    </button>
                  </div>
                )
              })}
            </div>
            <button
              type="button"
              title="向右滚动标签"
              aria-label="向右滚动标签"
              disabled={!tabScroll.right}
              onClick={() => scrollStrip(1)}
              className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
            >
              <ChevronRight className="size-3.5" />
            </button>

            {/* 当前文件的形态切换与保存：跟随活动标签，放在滚动区之外，永远看得见 */}
            {active?.kind === 'svg' && (
              <div className="flex shrink-0 items-center gap-0.5 rounded-md border border-border/70 p-0.5">
                <button
                  type="button"
                  title="预览"
                  aria-label="预览"
                  aria-pressed={active.mode === 'preview'}
                  onClick={() => patchFile(active.path, { mode: 'preview' })}
                  className={cn(
                    'rounded px-1.5 py-0.5 transition-colors',
                    active.mode === 'preview'
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
                  aria-pressed={active.mode === 'edit'}
                  onClick={() => patchFile(active.path, { mode: 'edit' })}
                  className={cn(
                    'rounded px-1.5 py-0.5 transition-colors',
                    active.mode === 'edit'
                      ? 'bg-primary/15 text-primary'
                      : 'text-muted-foreground hover:bg-foreground/10'
                  )}
                >
                  <Pencil className="size-3.5" />
                </button>
              </div>
            )}
            {active && isEditable(active.kind) && (
              <Tooltip title={dirty ? '保存（Ctrl+S）' : '没有需要保存的修改'}>
                <Button
                  type="text"
                  size="small"
                  icon={
                    savingPath === active.path ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <Save className="size-3.5" />
                    )
                  }
                  className={cn('w-7 shrink-0 p-0', dirty ? 'text-primary' : 'text-muted-foreground')}
                  disabled={!dirty || savingPath !== null}
                  onClick={() => void save()}
                />
              </Tooltip>
            )}
          </div>
        )}

        <div className="min-h-0 flex-1">
          {active ? (
            active.loadError ? (
              <div className="flex h-full items-center justify-center px-6">
                <div className="max-w-md text-center text-sm text-muted-foreground">
                  <FileIcon className="mx-auto mb-2 size-8 opacity-30" />
                  {active.loadError}
                </div>
              </div>
            ) : active.kind === 'binary' ? (
              <UnsupportedPreview fileName={baseName(active.path)} />
            ) : isPreviewable(active.kind) &&
              (active.kind !== 'svg' || active.mode === 'preview') ? (
              <FilePreview
                kind={active.kind as 'image' | 'svg' | 'video' | 'audio'}
                url={buildWorkspaceMediaUrl(workspaceId, active.path)}
                fileName={baseName(active.path)}
              />
            ) : (
              <MonacoEditor
                value={active.content}
                // 只改这一个标签的内容。**目标按事件自带的 model URI 反推**：切换文件时事件
                // 可能由上一次订阅的闭包送回来（见 MonacoEditor 的 `handleEditorChange`），
                // 那时 active 已是新文件 —— 用闭包里的 active.path 会把新文件的初始值写进
                // 旧文件的条目，旧文件没动却亮「有未保存的修改」。拿不到 URI 才退回当前标签。
                onChange={(value, uri) =>
                  patchFile(pathFromModelUri(workspaceId, uri) ?? active.path, { content: value })
                }
                // path 给每个文件一个独立 model（撤销栈 / 光标 / 滚动位置各自保留）
                path={modelUri(workspaceId, active.path)}
                language={languageOf(active.path)}
                readOnly={active.loading}
                showHeader={false}
              />
            )
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
