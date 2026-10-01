import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode
} from 'react'
import { Button, Dropdown, Input, Modal, Tooltip, message, type MenuProps } from 'antd'
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ClipboardPaste,
  Copy,
  File as FileIcon,
  FileAudio,
  FileCode,
  FileImage,
  FileJson,
  FilePlus2,
  FileText,
  FileVideo,
  Files,
  Folder,
  FolderOpen,
  FolderPlus,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Scissors,
  Trash2,
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

/** 触屏长按唤出右键菜单的时长（ms）。鼠标右键走 contextmenu，与它无关 */
const LONG_PRESS_MS = 500
/** 长按期间手指允许的位移（px）：超过就判定成滚动，取消唤出 */
const LONG_PRESS_SLOP = 10

/**
 * 触屏长按 → 展开菜单。鼠标（含触控板）完全不参与，右键由 Dropdown 的 contextMenu
 * 触发器负责 —— 所以这套 handlers 里第一件事就是把 mouse 分支挡掉。
 *
 * 两个必须处理干净的副作用：
 * - **长按成功后那次 click**：不吞掉就会顺带展开目录 / 打开文件，菜单等于白发。
 *   吞它的位置是 `onClickCapture`（捕获阶段先于按钮自己的 onClick，stopPropagation 有效）。
 * - **长按期间滚动手势**：位移超过 LONG_PRESS_SLOP 立即取消，否则列表没法滚。
 */
function useLongPressMenu(): {
  open: boolean
  setOpen: (v: boolean) => void
  rowHandlers: {
    onPointerDown: (e: ReactPointerEvent) => void
    onPointerMove: (e: ReactPointerEvent) => void
    onPointerUp: () => void
    onPointerCancel: () => void
    onContextMenu: (e: ReactMouseEvent) => void
    onClickCapture: (e: ReactMouseEvent) => void
  }
} {
  const [open, setOpen] = useState(false)
  const timer = useRef<number | null>(null)
  const origin = useRef<{ x: number; y: number } | null>(null)
  /** 这一次长按是否真的把菜单唤出来了（决定要不要吞掉随后的 click） */
  const fired = useRef(false)

  const cancel = useCallback((): void => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current)
      timer.current = null
    }
    origin.current = null
  }, [])

  useEffect(() => cancel, [cancel])

  const rowHandlers = {
    onPointerDown: (e: ReactPointerEvent): void => {
      // 鼠标交给 contextmenu；别让左键长按也弹菜单
      if (e.pointerType === 'mouse') return
      origin.current = { x: e.clientX, y: e.clientY }
      fired.current = false
      cancel()
      timer.current = window.setTimeout(() => {
        timer.current = null
        fired.current = true
        setOpen(true)
      }, LONG_PRESS_MS)
    },
    onPointerMove: (e: ReactPointerEvent): void => {
      const start = origin.current
      if (!start) return
      if (
        Math.abs(e.clientX - start.x) > LONG_PRESS_SLOP ||
        Math.abs(e.clientY - start.y) > LONG_PRESS_SLOP
      ) {
        cancel()
      }
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
    // 行内先截住：别让右键事件顺着 React 树冒泡到外层容器（否则两层菜单一起弹）
    onContextMenu: (e: ReactMouseEvent): void => e.stopPropagation(),
    onClickCapture: (e: ReactMouseEvent): void => {
      if (!fired.current) return
      fired.current = false
      e.preventDefault()
      e.stopPropagation()
    }
  }

  return { open, setOpen, rowHandlers }
}

/** 一个目录的懒加载状态；`entries` 为 null 表示还没读过 */
interface DirState {
  open: boolean
  loading: boolean
  entries: AgentFsEntry[] | null
}

/**
 * 文件树里的一行（目录与文件共用，靠 expandable 区分左侧占位）。
 *
 * 传了 `menu` 就整行包一层 antd Dropdown：鼠标右键走 `contextMenu`，触屏走长按
 * （见 useLongPressMenu —— 触屏没有右键，长按是唯一的唤出方式）。
 */
function TreeRow({
  depth,
  icon,
  label,
  active,
  expandable,
  open,
  onClick,
  menu
}: {
  depth: number
  icon: ReactNode
  label: string
  active?: boolean
  expandable?: boolean
  open?: boolean
  onClick: () => void
  menu?: MenuProps
}) {
  const longPress = useLongPressMenu()
  const row = (
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
      {...longPress.rowHandlers}
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
  // 没有菜单的行（理论上都会传）：别包 Dropdown，省一层克隆开销
  if (!menu) return row
  return (
    <Dropdown
      open={longPress.open}
      onOpenChange={longPress.setOpen}
      trigger={['contextMenu']}
      menu={menu}
    >
      {row}
    </Dropdown>
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
   * 文件树剪贴板：**一次一项**（树上没有多选）。`cut` = 剪切，粘贴即移动。
   * 刻意不碰系统剪贴板：往那里写文件路径会污染用户自己复制的内容，而这里的粘贴
   * 只在同一个工作区内有意义。
   */
  const [clipboard, setClipboard] = useState<{ entry: AgentFsEntry; cut: boolean } | null>(null)
  /** 重命名 / 新建的弹窗状态 */
  const [renaming, setRenaming] = useState<{ entry: AgentFsEntry; text: string } | null>(null)
  const [creating, setCreating] = useState<{ dir: string; type: 'file' | 'dir'; text: string } | null>(
    null
  )
  /** 弹窗提交中：避免连点造成两次落盘 */
  const [fsBusy, setFsBusy] = useState(false)

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
    // 不清空 dirs：否则整棵树会瞬间消失再重绘（闪烁），且展开状态全部丢失。
    // loadDir 在重新拉取时会保留旧 entries 直到新数据到达，界面平稳无闪烁；
    // 顺带把当前已展开/已读的目录一并重拉，让子目录的新增/删除也同步出来。
    void loadDir('')
    for (const [dir, state] of Object.entries(dirs)) {
      if (dir !== '' && state.entries) void loadDir(dir)
    }
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

  /**
   * 关标签：有未保存的改动先确认（每个标签自己一份内容，所以只是「这条要丢」）。
   * `onDone` / `onAbort` 给文件操作串流程用（删 / 移动前先关掉受影响的标签，
   * 用户取消确认就等于取消整个操作）；界面上的关闭按钮只传路径。
   */
  const closeFile = (
    path: string,
    opts?: { onDone?: () => void; onAbort?: () => void }
  ): void => {
    const target = files.find((f) => f.path === path)
    if (target && target.content !== target.savedContent) {
      Modal.confirm({
        title: '有未保存的修改',
        content: `「${path}」的改动还没保存，关闭这个标签会丢失。`,
        okText: '丢弃并关闭',
        cancelText: '取消',
        okButtonProps: { danger: true },
        onOk: () => {
          doCloseFile(path)
          opts?.onDone?.()
        },
        onCancel: () => opts?.onAbort?.()
      })
      return
    }
    doCloseFile(path)
    opts?.onDone?.()
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

  // ── 文件树操作（右键菜单 / 触屏长按；树上没有多选，一次只作用于一项）──────────

  /** 某个路径下已打开的标签（目录要连它内部的文件一起算上） */
  const tabsUnder = (path: string): string[] =>
    files.filter((f) => f.path === path || f.path.startsWith(`${path}/`)).map((f) => f.path)

  /**
   * 先关掉受影响的标签，再动盘。
   *
   * 为什么必须先关：删掉 / 移走 / 重命名一个已打开的文件后，标签还指着旧路径、
   * Monaco 的 model 也按旧 URI 建，之后一次保存就会**写到不复存在的路径上**。
   * 反过来把标签路径改到新位置要连 model 一起迁移（撤销栈 / 行尾 / 光标全得搬），
   * 所以选「关掉标签」这条路 —— 与手动关标签完全同一套确认，未保存的改动不会悄悄消失。
   */
  const withTabsClosed = (path: string, next: () => void, onAbort?: () => void): void => {
    const affected = tabsUnder(path)
    if (!affected.length) {
      next()
      return
    }
    const step = (i: number): void => {
      if (i >= affected.length) {
        next()
        return
      }
      closeFile(affected[i], {
        onDone: () => step(i + 1),
        onAbort: () => {
          message.info('已取消，磁盘上的文件没有改动')
          onAbort?.()
        }
      })
    }
    step(0)
  }

  /** 保证某个目录是展开的（新建 / 粘贴进去之后要能立刻看见结果） */
  const expandDir = (dir: string): void => {
    if (dir === '') return
    if (dirs[dir]?.entries) {
      setDirs((d) => ({ ...d, [dir]: { ...d[dir], open: true } }))
      return
    }
    void loadDir(dir)
  }

  /** 删除（目录递归删）。相关标签关不掉（用户在确认框取消）就不删 */
  const runDelete = (entry: AgentFsEntry): void => {
    Modal.confirm({
      title: entry.type === 'dir' ? '删除目录？' : '删除文件？',
      content:
        entry.type === 'dir'
          ? `「${entry.name}」及其全部子项会被永久删除，无法恢复。`
          : `「${entry.name}」会被永久删除，无法恢复。`,
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: () =>
        withTabsClosed(entry.path, () => {
          void (async () => {
            try {
              await window.api.agent.fs.delete(workspaceId, entry.path)
              message.success(`已删除${entry.type === 'dir' ? '目录' : '文件'}「${entry.name}」`)
              refresh()
            } catch (err) {
              message.error(`删除失败：${describeError(err)}`)
            }
          })()
        })
    })
  }

  /** 复制 / 剪切：只记剪贴板，不碰盘 */
  const runCopy = (entry: AgentFsEntry, cut: boolean): void => {
    setClipboard({ entry, cut })
    message.info(`已${cut ? '剪切' : '复制'}「${entry.name}」，到目标目录粘贴（右键 / 长按）`)
  }

  /** 粘贴到 toDir（为空 = 工作区根）。剪切 = 移动，源会消失，同样要先关它的标签 */
  const runPaste = (toDir: string): void => {
    const clip = clipboard
    if (!clip) return
    const apply = (): void => {
      void (async () => {
        try {
          const created = await window.api.agent.fs.copy(
            workspaceId,
            clip.entry.path,
            toDir,
            clip.cut ? 'move' : 'copy'
          )
          // 剪切一次即失效：留着会让用户以为还能再粘一次（源已经没了）
          if (clip.cut) setClipboard(null)
          message.success(`已${clip.cut ? '移动' : '复制'}到 ${created.path}`)
          refresh()
          expandDir(toDir)
        } catch (err) {
          message.error(`${clip.cut ? '移动' : '复制'}失败：${describeError(err)}`)
        }
      })()
    }
    if (clip.cut) withTabsClosed(clip.entry.path, apply)
    else apply()
  }

  /** 重命名提交 */
  const submitRename = (): void => {
    const target = renaming
    const name = target?.text.trim() ?? ''
    if (!target) return
    if (!name || name === target.entry.name) {
      setRenaming(null)
      return
    }
    setFsBusy(true)
    withTabsClosed(
      target.entry.path,
      () => {
        void (async () => {
          try {
            await window.api.agent.fs.rename(workspaceId, target.entry.path, name)
            message.success(`已重命名为「${name}」`)
            setRenaming(null)
            refresh()
          } catch (err) {
            message.error(`重命名失败：${describeError(err)}`)
          } finally {
            setFsBusy(false)
          }
        })()
      },
      () => setFsBusy(false)
    )
  }

  /** 新建文件 / 文件夹：新建的文件直接打开，用不着再点一次 */
  const submitCreate = (): void => {
    const draft = creating
    const name = draft?.text.trim() ?? ''
    if (!draft || !name) return
    setFsBusy(true)
    void (async () => {
      try {
        const created = await window.api.agent.fs.create(workspaceId, draft.dir, name, draft.type)
        message.success(`已新建${draft.type === 'dir' ? '目录' : '文件'}「${created.name}」`)
        setCreating(null)
        refresh()
        expandDir(draft.dir)
        if (created.type === 'file') await openFile(created)
      } catch (err) {
        message.error(`新建失败：${describeError(err)}`)
      } finally {
        setFsBusy(false)
      }
    })()
  }

  /** 某一行的右键菜单（触屏长按复用同一份 menu，见 TreeRow） */
  const rowMenu = (entry: AgentFsEntry): MenuProps => ({
    items: [
      {
        key: 'open',
        icon:
          entry.type === 'dir' ? (
            <FolderOpen className="size-3.5" />
          ) : (
            <FileText className="size-3.5" />
          ),
        label: entry.type === 'dir' ? (dirs[entry.path]?.open ? '收起' : '展开') : '打开'
      },
      { key: 'rename', icon: <Pencil className="size-3.5" />, label: '重命名' },
      { key: 'copy', icon: <Copy className="size-3.5" />, label: '复制' },
      { key: 'cut', icon: <Scissors className="size-3.5" />, label: '剪切' },
      // 文件行不给「粘贴」：粘到文件上语义不明，粘到它的父目录即可（父目录那一行有）
      ...(entry.type === 'dir'
        ? [
            {
              key: 'paste',
              icon: <ClipboardPaste className="size-3.5" />,
              label: '粘贴到此处',
              disabled: !clipboard
            }
          ]
        : []),
      { type: 'divider' as const },
      { key: 'delete', icon: <Trash2 className="size-3.5" />, label: '删除', danger: true }
    ],
    onClick: ({ key }) => {
      if (key === 'open') {
        if (entry.type === 'dir') toggleDir(entry.path)
        else void openFile(entry)
      } else if (key === 'rename') {
        setRenaming({ entry, text: entry.name })
      } else if (key === 'copy') {
        runCopy(entry, false)
      } else if (key === 'cut') {
        runCopy(entry, true)
      } else if (key === 'paste') {
        runPaste(entry.path)
      } else if (key === 'delete') {
        runDelete(entry)
      }
    }
  })

  /** 树标题栏的「+」：新建 / 粘贴到根目录（放在头部而不是空白处右键 —— 触屏上有个
   * 明确的点击目标，比「长按空白处」好发现） */
  const treeMenu = (): MenuProps => ({
    items: [
      { key: 'newFile', icon: <FilePlus2 className="size-3.5" />, label: '新建文件' },
      { key: 'newDir', icon: <FolderPlus className="size-3.5" />, label: '新建文件夹' },
      {
        key: 'paste',
        icon: <ClipboardPaste className="size-3.5" />,
        label: '粘贴到根目录',
        disabled: !clipboard
      }
    ],
    onClick: ({ key }) => {
      if (key === 'newFile') setCreating({ dir: '', type: 'file', text: '' })
      else if (key === 'newDir') setCreating({ dir: '', type: 'dir', text: '' })
      else if (key === 'paste') runPaste('')
    }
  })

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
            menu={rowMenu(entry)}
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
            menu={rowMenu(entry)}
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
          {/* 新建 / 粘贴：触屏没有右键，长按也不如一个明确的按钮好发现 */}
          <Dropdown trigger={['click']} placement="bottomRight" menu={treeMenu()}>
            <Button
              type="text"
              size="small"
              icon={<Plus className="size-3.5" />}
              className="w-7 shrink-0 p-0 text-muted-foreground"
              title="新建 / 粘贴"
              aria-label="新建 / 粘贴"
            />
          </Dropdown>
        </div>
        <div className="min-h-0 flex-1 overflow-auto pb-2 select-none">
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

      {/* 重命名 */}
      <Modal
        open={renaming !== null}
        onCancel={() => setRenaming(null)}
        title="重命名"
        okText="保存"
        cancelText="取消"
        centered
        width={400}
        destroyOnHidden
        confirmLoading={fsBusy}
        okButtonProps={{ disabled: !renaming?.text.trim() }}
        onOk={submitRename}
      >
        <Input
          value={renaming?.text ?? ''}
          onChange={(e) => setRenaming((r) => (r ? { ...r, text: e.target.value } : r))}
          onPressEnter={submitRename}
          placeholder="新名字"
        />
        <p className="mt-2 text-xs text-muted-foreground">
          只改名字、不换目录；正在编辑这个文件时会先关掉它的标签（未保存的改动要你确认）。
        </p>
      </Modal>

      {/* 新建文件 / 文件夹 */}
      <Modal
        open={creating !== null}
        onCancel={() => setCreating(null)}
        title={creating?.type === 'dir' ? '新建文件夹' : '新建文件'}
        okText="新建"
        cancelText="取消"
        centered
        width={400}
        destroyOnHidden
        confirmLoading={fsBusy}
        okButtonProps={{ disabled: !creating?.text.trim() }}
        onOk={submitCreate}
      >
        <Input
          value={creating?.text ?? ''}
          onChange={(e) => setCreating((c) => (c ? { ...c, text: e.target.value } : c))}
          onPressEnter={submitCreate}
          placeholder={creating?.type === 'dir' ? '文件夹名，如 components' : '文件名，如 index.ts'}
        />
        <p className="mt-2 text-xs text-muted-foreground">
          将创建在 {creating?.dir || '工作区根目录'}；已存在的同名项不会被覆盖。
        </p>
      </Modal>
    </div>
  )
}
