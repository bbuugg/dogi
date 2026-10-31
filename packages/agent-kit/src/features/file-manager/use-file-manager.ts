/**
 * 文件管理器的状态与动作（一个 hook 装完，面板只负责画）。
 *
 * ## 从 SFTP 面板抄来的两条教训
 *
 * 1. **`app` 绝不进依赖数组**：它每次渲染都是新对象（AGENTS.md 写死的一条），
 *    进了 `useEffect` / `useCallback` 就会让「初次连接」跟着每一次父级重渲染重跑 ——
 *    表现是「列表自己刷新、还把人顶回根目录」。这里一律经 `apiRef` 读。
 * 2. **刷新分两档**：进入目录 / 手动刷新才显示 loading（行变淡）；改完东西后的刷新
 *    **静默**（数据回来原地换行），否则每建一个文件夹整屏闪一下。
 *
 * ## 为什么批量动作在这里循环而不是交给服务端
 *
 * 复制 / 移动 / 删除 / 还原都是「一条路径一个请求」，客户端 for 循环 + `progress`：
 * 进度条能显示「第 3 / 共 12 项」，单项失败也不会让整批中止（收集成 `failures` 一起报）。
 * 把 12 个路径塞进一个请求，用户就只能看一个转圈，还容易撞上代理超时。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { fileToBase64 } from '@fizz/agent-client/api'
import {
  subscribePrefs,
  writePref
} from '@fizz/agent-kit/shared/lib/prefs-sync'
import type {
  FmEntry,
  FmListResult,
  FmOpInput,
  FmOpResult,
  FmRootsResult,
  FmTrashItem,
  FmTrashResult
} from '@fizz/contracts/agent-api'
import { useAppContext } from '@fizz/agent-kit/shared/hooks/use-app-context'
import {
  breadcrumbOf,
  dirOf,
  isInsideDir,
  joinFsPath,
  nameOf,
  trimSep
} from '@fizz/agent-kit/features/file-manager/fm-paths'

/** 两种浏览模式：普通目录 / 回收站（回收站不是真实目录，单独一套动作） */
export type FileManagerMode = 'files' | 'trash'
/** 两种视图：大图标网格 / 明细列表 */
export type FileManagerView = 'grid' | 'list'

/** 批量动作的进度（界面上就是一条「正在复制 3 / 12」） */
export interface OpProgress {
  label: string
  done: number
  total: number
}

/** 判定失败时给面板用的简短结果 */
export interface BatchResult {
  ok: number
  failures: string[]
}

const VIEW_KEY = 'fizz.file-manager.view'
const HIDDEN_KEY = 'fizz.file-manager.show-hidden'

function readStoredView(): FileManagerView {
  try {
    return localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'grid'
  } catch {
    return 'grid'
  }
}

function readStoredHidden(): boolean {
  try {
    return localStorage.getItem(HIDDEN_KEY) === '1'
  } catch {
    return false
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function useFileManager() {
  const { app } = useAppContext()
  /** 最新 api 的 ref（不进依赖数组，见文件头第 1 条） */
  const apiRef = useRef(app.api)
  apiRef.current = app.api

  /**
   * 取文件管理接口。`app.api` 在「还没连上服务端」时是 null（`getApi()` 的返回类型就是
   * 可空的），这里统一抛一句人能读懂的话 —— 否则每一处调用都要写一次判空。
   */
  const filesApi = useCallback(() => {
    const api = apiRef.current
    if (!api) throw new Error('还没连上服务端，稍后再试')
    return api.files
  }, [])

  const [mode, setMode] = useState<FileManagerMode>('files')
  const [path, setPath] = useState('')
  const [entries, setEntries] = useState<FmEntry[]>([])
  const [truncated, setTruncated] = useState(false)
  const [trashItems, setTrashItems] = useState<FmTrashItem[]>([])
  const [roots, setRoots] = useState<FmRootsResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [history, setHistory] = useState<string[]>([])
  const [historyIndex, setHistoryIndex] = useState(-1)
  const [view, setViewState] = useState<FileManagerView>(readStoredView)
  const [showHidden, setShowHiddenState] = useState<boolean>(readStoredHidden)
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [clipboard, setClipboard] = useState<{ mode: 'copy' | 'cut'; paths: string[] } | null>(null)
  const [progress, setProgress] = useState<OpProgress | null>(null)

  /** 请求序号：只认最后一次列表请求的回包（静默刷新多了以后，旧回包会盖掉新结果） */
  const seqRef = useRef(0)
  const aliveRef = useRef(true)
  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  const setView = useCallback((next: FileManagerView) => {
    setViewState(next)
    // 写盘即广播 + 同步到服务端（见 prefs-sync）
    writePref(VIEW_KEY, next)
  }, [])

  const setShowHidden = useCallback((next: boolean) => {
    setShowHiddenState(next)
    writePref(HIDDEN_KEY, next ? '1' : '0')
  }, [])

  /*
   * 服务端下行 / 别的窗口改了视图偏好：本组件用的是 useState，不会自己重读。
   * 同窗口写盘不触发 `storage` 事件，所以订阅总线兜住（首次挂载也会立刻收到一次无意义的通知，
   * 值没变时 setState 是同一份值，不会多渲染）。
   */
  useEffect(
    () =>
      subscribePrefs([VIEW_KEY, HIDDEN_KEY], () => {
        setViewState(readStoredView())
        setShowHiddenState(readStoredHidden())
      }),
    []
  )

  // ---------------- 读 ----------------

  /**
   * 列目录。
   *
   * `silent` = 不显示 loading（改完东西后的刷新走这条）。**任何情况下都不清空现有条目**：
   * 列表在数据回来前保持原样，才不会「点一下全屏白一下」。
   */
  const loadDir = useCallback(
    async (dir: string, opts?: { silent?: boolean }): Promise<FmListResult | null> => {
      const seq = ++seqRef.current
      if (!opts?.silent) setLoading(true)
      try {
        const result = await filesApi().list(dir)
        if (!aliveRef.current || seq !== seqRef.current) return null
        setEntries(result.entries)
        setTruncated(result.truncated === true)
        setPath(result.path)
        setError(null)
        return result
      } catch (err) {
        if (!aliveRef.current || seq !== seqRef.current) return null
        const message = messageOf(err)
        if (opts?.silent) toast.error('刷新失败：' + message)
        else setError(message)
        return null
      } finally {
        // 不看 silent：静默刷新可能顶掉一次非静默请求，谁最后落地谁收尾，否则 loading 会卡住
        if (aliveRef.current && seq === seqRef.current) setLoading(false)
      }
    },
    []
  )

  const loadTrash = useCallback(async (opts?: { silent?: boolean }): Promise<void> => {
    const seq = ++seqRef.current
    if (!opts?.silent) setLoading(true)
    try {
      const result: FmTrashResult = await filesApi().trash()
      if (!aliveRef.current || seq !== seqRef.current) return
      setTrashItems(result.items)
      setError(null)
    } catch (err) {
      if (!aliveRef.current || seq !== seqRef.current) return
      setError(messageOf(err))
    } finally {
      if (aliveRef.current && seq === seqRef.current) setLoading(false)
    }
  }, [])

  /** 按当前模式重新读一遍（改完东西后调它，静默） */
  const reload = useCallback(
    (opts?: { silent?: boolean }) => {
      void (mode === 'trash' ? loadTrash(opts) : loadDir(path, opts))
    },
    [mode, path, loadTrash, loadDir]
  )

  /** 打开时先拿「可跳转的位置」，再进主目录 */
  useEffect(() => {
    let cancelled = false
    void (async () => {
      setLoading(true)
      try {
        const result = await filesApi().roots()
        if (cancelled || !aliveRef.current) return
        setRoots(result)
        setHistory([result.home])
        setHistoryIndex(0)
        await loadDir(result.home)
      } catch (err) {
        if (cancelled || !aliveRef.current) return
        setError(messageOf(err))
        setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
    // 只在挂载时跑一次：`loadDir` 是稳定引用，`apiRef` 不进依赖
  }, [loadDir])

  /**
   * 跳到某个目录并记进历史。
   *
   * `fromHistory` = 前进 / 后退触发的跳转，**不再写历史**（否则历史会长出重复项，
   * 前进键永远点不完）。
   */
  const navigateTo = useCallback(
    async (target: string, opts?: { fromHistory?: boolean }) => {
      const result = await loadDir(target)
      if (result && !opts?.fromHistory) {
        setHistory((prev) => {
          const cut = prev.slice(0, historyIndex + 1)
          return [...cut, result.path]
        })
        setHistoryIndex((i) => i + 1)
      }
      setSelected(new Set())
    },
    [loadDir, historyIndex]
  )

  const back = useCallback(() => {
    if (historyIndex <= 0) return
    const target = history[historyIndex - 1]
    setHistoryIndex(historyIndex - 1)
    void navigateTo(target, { fromHistory: true })
  }, [history, historyIndex, navigateTo])

  const forward = useCallback(() => {
    if (historyIndex >= history.length - 1) return
    const target = history[historyIndex + 1]
    setHistoryIndex(historyIndex + 1)
    void navigateTo(target, { fromHistory: true })
  }, [history, historyIndex, navigateTo])

  const goUp = useCallback(() => {
    const crumbs = breadcrumbOf(path)
    if (crumbs.length < 2) return
    void navigateTo(crumbs[crumbs.length - 2].path)
  }, [path, navigateTo])

  /** 切模式：进回收站就拉回收站清单，回文件模式就重进主目录 */
  const setModeAndLoad = useCallback(
    (next: FileManagerMode) => {
      setMode(next)
      setSelected(new Set())
      if (next === 'trash') {
        void loadTrash()
        return
      }
      const home = roots?.home ?? ''
      setHistory([home])
      setHistoryIndex(0)
      void loadDir(home)
    },
    [loadDir, loadTrash, roots]
  )

  // ---------------- 选中 ----------------

  const visibleEntries = useMemo(
    () => (showHidden ? entries : entries.filter((e) => !e.hidden)),
    [entries, showHidden]
  )

  const clearSelection = useCallback(() => setSelected(new Set()), [])

  const selectAll = useCallback(() => {
    if (mode === 'trash') setSelected(new Set(trashItems.map((t) => t.id)))
    else setSelected(new Set(visibleEntries.map((e) => e.path)))
  }, [mode, trashItems, visibleEntries])

  /** Shift 范围选的锚点 */
  const anchorRef = useRef<string | null>(null)

  /** 一次点击的选中语义：普通 = 单选，Ctrl/⌘ = 切换，Shift = 从锚点连选 */
  const selectItem = useCallback(
    (id: string, event: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) => {
      const list = mode === 'trash' ? trashItems.map((t) => t.id) : visibleEntries.map((e) => e.path)
      if (event.shiftKey && anchorRef.current) {
        const from = list.indexOf(anchorRef.current)
        const to = list.indexOf(id)
        if (from >= 0 && to >= 0) {
          const [lo, hi] = from < to ? [from, to] : [to, from]
          setSelected((prev) => {
            const next = new Set(prev)
            for (let i = lo; i <= hi; i++) next.add(list[i])
            return next
          })
          return
        }
      }
      if (event.ctrlKey || event.metaKey) {
        setSelected((prev) => {
          const next = new Set(prev)
          if (next.has(id)) next.delete(id)
          else next.add(id)
          return next
        })
        anchorRef.current = id
        return
      }
      setSelected(new Set([id]))
      anchorRef.current = id
    },
    [mode, trashItems, visibleEntries]
  )

  // ---------------- 改动动作 ----------------

  /** 单条 op + 统一错误提示；返回是否成功 */
  const runOp = useCallback(
    async (input: FmOpInput, opts?: { success?: string }): Promise<FmOpResult | null> => {
      try {
        const result = await filesApi().op(input)
        if (opts?.success) toast.success(opts.success)
        return result
      } catch (err) {
        toast.error(messageOf(err))
        return null
      }
    },
    []
  )

  /**
   * 批量动作的统一壳：逐条跑，收集失败，最后静默刷新一次。
   *
   * `label` 直接显示在进度条上（「正在复制」「正在删除」），不要写「处理中」——
   * 用户要知道自己在等什么。
   */
  const runBatch = useCallback(
    async (
      label: string,
      items: string[],
      fn: (item: string) => Promise<unknown>
    ): Promise<BatchResult> => {
      if (!items.length) return { ok: 0, failures: [] }
      const failures: string[] = []
      let ok = 0
      setProgress({ label, done: 0, total: items.length })
      for (let i = 0; i < items.length; i++) {
        try {
          await fn(items[i])
          ok++
        } catch (err) {
          failures.push(messageOf(err))
        }
        if (!aliveRef.current) return { ok, failures }
        setProgress({ label, done: i + 1, total: items.length })
      }
      setProgress(null)
      return { ok, failures }
    },
    []
  )

  /** 改完东西后的收尾：清选中 + 静默刷新 + 汇总失败 */
  const afterBatch = useCallback(
    (result: BatchResult, successText: string) => {
      if (result.ok) toast.success(`${successText} ${result.ok} 项`)
      if (result.failures.length) toast.error(result.failures[0])
      setSelected(new Set())
      reload({ silent: true })
    },
    [reload]
  )

  const mkdir = useCallback(
    async (name: string): Promise<boolean> => {
      const result = await runOp({ op: 'mkdir', parent: path, name }, { success: `已新建文件夹「${name}」` })
      if (result) reload({ silent: true })
      return !!result
    },
    [path, runOp, reload]
  )

  const createFile = useCallback(
    async (name: string): Promise<boolean> => {
      const result = await runOp({ op: 'create', parent: path, name }, { success: `已新建文件「${name}」` })
      if (result) reload({ silent: true })
      return !!result
    },
    [path, runOp, reload]
  )

  const rename = useCallback(
    async (target: string, name: string): Promise<boolean> => {
      const result = await runOp({ op: 'rename', path: target, name })
      if (result) reload({ silent: true })
      return !!result
    },
    [runOp, reload]
  )

  const batchRename = useCallback(
    async (paths: string[], base: string): Promise<boolean> => {
      const result = await runOp({ op: 'batchRename', paths, base }, { success: `已重命名 ${paths.length} 项` })
      if (result) {
        setSelected(new Set())
        reload({ silent: true })
      }
      return !!result
    },
    [runOp, reload]
  )

  const copySelection = useCallback((paths: string[]) => {
    setClipboard({ mode: 'copy', paths })
    toast.success(`已复制 ${paths.length} 项`)
  }, [])

  const cutSelection = useCallback((paths: string[]) => {
    setClipboard({ mode: 'cut', paths })
    toast.success(`已剪切 ${paths.length} 项`)
  }, [])

  /** 粘贴到当前目录（剪切 = 移动，复制 = 复制） */
  const paste = useCallback(async (): Promise<void> => {
    if (!clipboard) return
    const { mode: clipMode, paths } = clipboard
    const result = await runBatch(clipMode === 'cut' ? '正在移动' : '正在复制', paths, (item) =>
      filesApi().op({ op: clipMode === 'cut' ? 'move' : 'copy', path: item, to: path })
    )
    afterBatch(result, clipMode === 'cut' ? '已移动' : '已复制')
    // 剪切成功后剪贴板就该空了；复制保留（可以连续粘贴到多个目录）
    if (clipMode === 'cut' && !result.failures.length) setClipboard(null)
  }, [clipboard, path, runBatch, afterBatch])

  /**
   * 把一批路径**移动 / 复制到某个目录**（拖拽到文件夹 / 面包屑上时走这里）。
   *
   * 与 `paste` 分开而不是复用它：`paste` 的目标是「当前目录」并且会动剪贴板，而拖拽是
   * 「拖到哪就是哪」的一次性动作，不该顺手清掉用户剪了还没粘的东西。
   *
   * 先做三件客户端的筛除，剩下的才发请求：
   * - 本来就在那个目录里 → 跳过（不然会得到一堆「目标里已经有同名的…」）；
   * - 目标是自己或自己的子目录 → 跳过（服务端会拒，但在这里拒能整体拒绝、不必半途报错）；
   * - 空目标（目录名取不到）→ 直接不干。
   */
  const transfer = useCallback(
    async (paths: string[], destDir: string, op: 'copy' | 'move'): Promise<void> => {
      if (!destDir || !paths.length) return
      const skipped: string[] = []
      const items: string[] = []
      for (const item of paths) {
        if (trimSep(dirOf(item)) === trimSep(destDir)) continue
        if (isInsideDir(item, destDir) || isInsideDir(destDir, item)) {
          skipped.push(nameOf(item))
          continue
        }
        items.push(item)
      }
      if (skipped.length) {
        toast.error(
          `「${skipped[0]}」${op === 'move' ? '不能移动到' : '不能复制到'}它自己或它的子目录里`
        )
        return
      }
      if (!items.length) return
      const result = await runBatch(op === 'copy' ? '正在复制' : '正在移动', items, (item) =>
        filesApi().op({ op, path: item, to: destDir })
      )
      afterBatch(result, op === 'copy' ? '已复制' : '已移动')
    },
    [runBatch, afterBatch]
  )

  /** 删除（默认进回收站；`permanent` 彻底删） */
  const remove = useCallback(
    async (paths: string[], permanent: boolean): Promise<void> => {
      const result = await runBatch(permanent ? '正在删除' : '正在移到回收站', paths, (item) =>
        filesApi().op({ op: permanent ? 'delete' : 'trash', path: item })
      )
      afterBatch(result, permanent ? '已删除' : '已移到回收站')
    },
    [runBatch, afterBatch]
  )

  const restoreTrash = useCallback(
    async (ids: string[]): Promise<void> => {
      const result = await runBatch('正在还原', ids, (id) =>
        filesApi().op({ op: 'restore', id })
      )
      afterBatch(result, '已还原')
    },
    [runBatch, afterBatch]
  )

  const deleteTrash = useCallback(
    async (ids: string[]): Promise<void> => {
      const result = await runBatch('正在彻底删除', ids, (id) =>
        filesApi().op({ op: 'deleteTrash', id })
      )
      afterBatch(result, '已彻底删除')
    },
    [runBatch, afterBatch]
  )

  const emptyTrash = useCallback(async (): Promise<void> => {
    const result = await runOp({ op: 'emptyTrash' }, { success: '回收站已清空' })
    if (result) {
      setSelected(new Set())
      reload({ silent: true })
    }
  }, [runOp, reload])

  const compress = useCallback(
    async (paths: string[], to: string): Promise<boolean> => {
      const result = await runOp({ op: 'compress', paths, to })
      if (!result) return false
      toast.success(
        result.skipped
          ? `已压缩 ${paths.length} 项（跳过 ${result.skipped} 项：太大或超数量上限）`
          : `已压缩 ${paths.length} 项`
      )
      setSelected(new Set())
      reload({ silent: true })
      return true
    },
    [runOp, reload]
  )

  const extract = useCallback(
    async (archive: string, to: string): Promise<boolean> => {
      const result = await runOp({ op: 'extract', path: archive, to })
      if (!result) return false
      toast.success(result.message ?? '已解压')
      reload({ silent: true })
      return true
    },
    [runOp, reload]
  )

  const writeText = useCallback(
    async (target: string, content: string): Promise<boolean> => {
      const result = await runOp({ op: 'write', path: target, content }, { success: '已保存' })
      if (result) reload({ silent: true })
      return !!result
    },
    [runOp, reload]
  )

  /** 下载：文件走原样，目录由服务端打 zip */
  const download = useCallback(async (items: FmEntry[]): Promise<void> => {
    for (const item of items) {
      try {
        await filesApi().download(item.path, item.isDir ? `${item.name}.zip` : item.name)
      } catch (err) {
        toast.error(`下载「${item.name}」失败：${messageOf(err)}`)
        return
      }
    }
  }, [])

  /**
   * 上传一批本地文件到当前目录。
   *
   * 文件夹上传（`webkitRelativePath`）的两步走：先把相对路径里的**各级目录**建出来
   * （`mkdir` 撞名就当已存在），再逐文件 `upload` —— 目录结构才保得住。进度按文件数走。
   */
  const upload = useCallback(
    async (files: File[], targetDir: string): Promise<void> => {
      if (!files.length) return
      setProgress({ label: '正在上传', done: 0, total: files.length })
      const failures: string[] = []
      let ok = 0
      /** 已经确认存在的目录（含服务端回「已存在」的） */
      const madeDirs = new Set<string>([targetDir])
      for (let i = 0; i < files.length; i++) {
        const file = files[i]
        try {
          const relative =
            (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name
          const segments = relative.split('/').filter(Boolean)
          const name = segments.pop() || file.name
          let dir = targetDir
          for (const segment of segments) {
            const next = joinFsPath(dir, segment)
            if (!madeDirs.has(next)) {
              try {
                await filesApi().op({ op: 'mkdir', parent: dir, name: segment })
              } catch {
                /* 已存在：直接用它 */
              }
              madeDirs.add(next)
            }
            dir = next
          }
          await filesApi().upload({
            dir,
            name,
            dataBase64: await fileToBase64(file),
            overwrite: false
          })
          ok++
        } catch (err) {
          failures.push(`${file.name}：${messageOf(err)}`)
        }
        if (!aliveRef.current) return
        setProgress({ label: '正在上传', done: i + 1, total: files.length })
      }
      setProgress(null)
      if (ok) toast.success(`已上传 ${ok} 个文件`)
      if (failures.length) toast.error(failures[0])
      reload({ silent: true })
    },
    [reload]
  )

  const crumbs = useMemo(() => breadcrumbOf(path), [path])

  return {
    // 状态
    mode,
    path,
    crumbs,
    entries,
    truncated,
    visibleEntries,
    trashItems,
    roots,
    loading,
    error,
    view,
    showHidden,
    selected,
    clipboard,
    progress,
    canBack: historyIndex > 0,
    canForward: historyIndex < history.length - 1,
    canUp: crumbs.length > 1,
    // 读
    navigateTo,
    back,
    forward,
    goUp,
    reload,
    setMode: setModeAndLoad,
    setView,
    setShowHidden,
    // 选中
    selectItem,
    selectAll,
    clearSelection,
    setSelected,
    // 动作
    mkdir,
    createFile,
    rename,
    batchRename,
    copySelection,
    cutSelection,
    paste,
    transfer,
    remove,
    restoreTrash,
    deleteTrash,
    emptyTrash,
    compress,
    extract,
    writeText,
    download,
    upload
  }
}

export type FileManagerController = ReturnType<typeof useFileManager>
