'use client'

/**
 * 笔记树的**懒加载缓存**（模块级，不是组件 state）。
 *
 * ## 为什么不做成组件 state
 *
 * 侧栏在切换活动栏时会**整条卸载重挂**（`Sidebar.tsx` 渲染的是 `activity.sidebar`）。
 * 展开态、每层拉到的条目如果放在 `NotesSidebar` 的 `useState` 里，去别的功能区点一下
 * 再回来就全没了 —— 用户看到的是「树自己收起来了，还得从头展开」。放进模块级缓存，
 * 侧栏随便卸载，回来还是原样。
 *
 * ## 懒加载：一次只拉一层
 *
 * 笔记根是用户挑的**任意**目录（可能是整个代码仓库），递归全扫既慢又白扫（大部分子目录
 * 用户根本不会展开）。所以服务端 `GET /api/notes/files` 也只列一层（`dir` 参数），
 * 这里**展开某个目录时才拉它那一层**（`toggleNotesDir` / `expandNotesDir`）。
 *
 * ## key 的口径
 *
 * `treeKey(rootId, dir)` = `${rootId}\u0000${dir}`：
 * - 用 `\u0000` 当分隔符而不是 `/` 或 `:` —— 相对路径里**本来就有 `/`**，Windows 根路径里
 *   还有 `:`（`D:\notes`），拿它们当分隔符会切错段。NUL 不可能出现在路径里。
 * - `dir` 一律 `/` 分隔、根目录是 `''`（与服务端契约一致）。
 *
 * ## 什么时候该重拉
 *
 * 新建 / 重命名 / 删除之后必须重拉**受影响的那一层**（`reloadNotesDir`）—— 否则树里
 * 显示的还是旧内容（新建的笔记不出现、删掉的还挂着）。这条不做「乐观更新」：文件系统才是
 * 真源，笔记树里一次错位比一次请求贵得多。
 */
import { useSyncExternalStore } from 'react'
import type { NotesEntry } from '@fizz/contracts/types'
import { useAgentStore } from '@fizz/agent-kit/shared/lib/stores/agent-store'
import { errorMessage } from '@fizz/agent-kit/shared/lib/stores/shared'

export interface NotesDirState {
  /** 已经列出来的这一层（`null` = 还没拉过） */
  entries: NotesEntry[] | null
  loading: boolean
  /** 列这一层失败的原因（403 越界 / 404 根不存在 / 网络…）；显示在那一层的位置 */
  error: string | null
}

export interface NotesTreeState {
  /** key = `treeKey(rootId, dir)`；**展开过 / 拉过**的目录才有条目 */
  dirs: Record<string, NotesDirState>
  /** 展开中的目录（同一 key 口径） */
  expanded: Record<string, true>
}

const EMPTY: NotesTreeState = { dirs: {}, expanded: {} }

let state: NotesTreeState = EMPTY
const listeners = new Set<() => void>()

function emit(next: NotesTreeState): void {
  state = next
  for (const listener of listeners) listener()
}

/** 树的 key：`rootId` + 相对路径（NUL 分隔，见文件头） */
export function treeKey(rootId: string, dir: string): string {
  return `${rootId}\u0000${dir}`
}

export function subscribeNotesTree(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function getNotesTree(): NotesTreeState {
  return state
}

export function useNotesTree(): NotesTreeState {
  return useSyncExternalStore(subscribeNotesTree, getNotesTree, getNotesTree)
}

function patchDir(key: string, patch: Partial<NotesDirState>): void {
  const prev = state.dirs[key] ?? { entries: null, loading: false, error: null }
  emit({ ...state, dirs: { ...state.dirs, [key]: { ...prev, ...patch } } })
}

/**
 * 拉某一层。`force` 为 true 时无视缓存重拉（新建 / 重命名 / 删除之后用）。
 *
 * 同一层的并发请求会被 `loading` 挡掉（连点两下箭头只发一次）。
 */
export async function loadNotesDir(rootId: string, dir: string, force = false): Promise<void> {
  const key = treeKey(rootId, dir)
  const cur = state.dirs[key]
  if (cur?.loading) return
  if (!force && cur?.entries) return

  const api = useAgentStore.getState().getApi()
  if (!api) {
    patchDir(key, { loading: false, error: '未连接服务端' })
    return
  }
  patchDir(key, { loading: true, error: null })
  try {
    const result = await api.listNoteFiles(rootId, dir)
    // 等待期间这一层可能被 `forgetNotesRoot` 丢掉了（根被移除 / 被别的端摘了）：
    // 此时**不要**写回，否则会把已经忘掉的缓存重新长回来。
    if (!state.dirs[key]) return
    patchDir(key, { entries: result.entries, loading: false, error: null })
  } catch (err) {
    if (!state.dirs[key]) return
    patchDir(key, { loading: false, error: errorMessage(err) })
  }
}

/** 展开 / 收起一个目录（展开时按需拉它那一层） */
export function toggleNotesDir(rootId: string, dir: string): void {
  const key = treeKey(rootId, dir)
  if (state.expanded[key]) {
    const expanded = { ...state.expanded }
    delete expanded[key]
    emit({ ...state, expanded })
    return
  }
  emit({ ...state, expanded: { ...state.expanded, [key]: true } })
  void loadNotesDir(rootId, dir)
}

/** 展开某目录（已展开就什么都不做）并保证这一层已拉过 —— 新建笔记后让父目录可见用 */
export function expandNotesDir(rootId: string, dir: string): void {
  const key = treeKey(rootId, dir)
  if (!state.expanded[key]) emit({ ...state, expanded: { ...state.expanded, [key]: true } })
  void loadNotesDir(rootId, dir)
}

/** 重拉一层（新建 / 重命名 / 删除之后调；保持展开态与已有内容直到新结果回来） */
export function reloadNotesDir(rootId: string, dir: string): void {
  void loadNotesDir(rootId, dir, true)
}

/** 丢掉一个根的全部缓存（移除登记后调） */
export function forgetNotesRoot(rootId: string): void {
  const prefix = `${rootId}\u0000`
  const dirs: Record<string, NotesDirState> = {}
  const expanded: Record<string, true> = {}
  for (const [key, value] of Object.entries(state.dirs)) {
    if (!key.startsWith(prefix)) dirs[key] = value
  }
  for (const key of Object.keys(state.expanded)) {
    if (!key.startsWith(prefix)) expanded[key] = true
  }
  emit({ dirs, expanded })
}

/**
 * 丢掉**不在 `keep` 里**的根的缓存。
 *
 * 根清单走快照域，别的端（或本端另一个窗口）摘掉一个根时会推过来 —— 缓存里那份就成了
 * 幽灵（侧栏不渲染它，但会一直占着，下次重新登记同一个 id 还会读到旧内容）。
 * 由 `NotesSidebar` 在根清单变化后调；没有要丢的就不 emit。
 */
export function pruneNotesRoots(keep: readonly string[]): void {
  const alive = new Set(keep)
  const seen = new Set<string>()
  for (const key of Object.keys(state.dirs)) seen.add(key.split('\u0000')[0])
  for (const key of Object.keys(state.expanded)) seen.add(key.split('\u0000')[0])
  const stale = [...seen].filter((rootId) => !alive.has(rootId))
  if (stale.length === 0) return
  const dirs: Record<string, NotesDirState> = {}
  const expanded: Record<string, true> = {}
  for (const [key, value] of Object.entries(state.dirs)) {
    if (alive.has(key.split('\u0000')[0])) dirs[key] = value
  }
  for (const key of Object.keys(state.expanded)) {
    if (alive.has(key.split('\u0000')[0])) expanded[key] = true
  }
  emit({ dirs, expanded })
}

/** 全部收起（侧栏头部那颗「收起全部」用；不丢缓存，重新展开不用再拉） */
export function collapseAllNotesDirs(): void {
  if (Object.keys(state.expanded).length === 0) return
  emit({ ...state, expanded: {} })
}
