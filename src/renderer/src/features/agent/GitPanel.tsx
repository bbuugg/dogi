import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, Checkbox, Dropdown, Input, Modal, Popconfirm, Select, message as toast } from 'antd'
import { cn } from 'cn'
import {
  Archive,
  ArchiveRestore,
  ArrowDown,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Folder,
  GitBranch as GitBranchIcon,
  GitBranchPlus,
  List,
  ListTree,
  Loader2,
  Minus,
  MoreHorizontal,
  Network,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Trash2,
  Upload
} from 'lucide-react'
import type {
  GitBranchesResult,
  GitChange,
  GitCommit,
  GitStashEntry,
  GitStatusResult
} from '@shared/types'
import { buildRows, INDENT, type RowNode } from './git-tree'
import { FileDiffView } from '@/shared/components/FileDiffView'
import { parseUnifiedDiff, type DiffHunk } from '@/shared/lib/diff'

/**
 * 「源代码管理」面板（git）：变更列表 / 暂存区 / 提交 / 检出 / 推送 / 历史 / 贮藏。
 *
 * 参考 fishwork 的 git panel：头部是分支下拉 + 分离头指针 / ↑↓ / 上游 + 刷新 / 树状切换 / 更多；
 * 提交框**贴在变更列表上方**单行（只提交已暂存的改动，Ctrl / ⌘ + Enter 提交，Ctrl / ⌘ + Shift + Enter 推送）；
 * 已暂存 / 更改两组各有 sticky 标题（可折叠、可一键折叠/展开目录）；历史提交 / 贮藏各自独立折叠；
 * diff 走结构化 `FileDiffView`（带行号与 +N/−M 计数）。
 *
 * 只做 git 允许的事：不做 force push、不做丢改动的 reset；检出 / 提交失败时把 git 的原话
 * （「本地改动会被覆盖」这类）直接讲出来，而不是替用户决定要不要覆盖。
 */
const TREE_VIEW_KEY = 'dogi.git.treeView'
function useTreeView(): [boolean, (v: boolean) => void] {
  const [treeView, setTreeView] = useState(
    () => localStorage.getItem(TREE_VIEW_KEY) !== '0'
  )
  const set = (v: boolean): void => {
    setTreeView(v)
    localStorage.setItem(TREE_VIEW_KEY, v ? '1' : '0')
  }
  return [treeView, set]
}

/** git 状态码 → 人话（鼠标悬停显示） */
const STATUS_LABEL: Record<string, string> = {
  M: '修改',
  A: '新增',
  D: '删除',
  R: '重命名',
  C: '复制',
  U: '冲突',
  '?': '未跟踪'
}

function statusTone(code: string): string {
  if (code === '?' || code === 'A') return 'text-emerald-500'
  if (code === 'D') return 'text-red-500'
  if (code === 'R' || code === 'C') return 'text-sky-500'
  if (code === 'U') return 'text-amber-500'
  return 'text-amber-500'
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** git 的进度类输出（push / checkout）有用的东西常在最后一行 */
function lastLine(text: string): string {
  const lines = text.split('\n').map((s) => s.trim()).filter(Boolean)
  return lines[lines.length - 1] ?? ''
}

/** 目录条目预览的条数上限（与 `services/git.ts` 的 `listGitDir` 默认值一致） */
const DIR_PREVIEW_LIMIT = 20

/**
 * 一次「回退」到底意味着什么（决定发给后端的 mode，以及确认框的文案）：
 * - `untracked`：git 完全不认识的新文件 → 从磁盘删掉；
 * - `added`：只存在于暂存区、HEAD 里没有的新文件 → 索引和磁盘一起删（实测就是删）；
 * - `staged`：已跟踪文件、有已暂存的改动 → 索引 + 工作区一起回到 HEAD；
 * - `worktree`：已跟踪文件、只有未暂存的改动 → 只丢工作区那份，已暂存的留着。
 */
type RollbackKind = 'untracked' | 'added' | 'staged' | 'worktree'

/** 回退会不会把文件本身删掉（决定确认按钮是「删除文件」还是「放弃改动」） */
function rollbackDeletes(kind: RollbackKind | undefined): boolean {
  return kind === 'untracked' || kind === 'added'
}

/** 回退确认框里那句「会发生什么」 */
function rollbackWarning(kind: RollbackKind | undefined, path: string): string {
  if (kind === 'untracked') {
    return `「${path}」还没有被 git 跟踪（新文件），回退会把它从磁盘上删除。此操作无法撤销。`
  }
  if (kind === 'added') {
    return `「${path}」还没提交过、只存在于暂存区，回退会把它从索引和磁盘上一并删除。此操作无法撤销。`
  }
  if (kind === 'staged') {
    return `「${path}」已暂存的那份改动、以及它之后在工作区里的改动都会丢掉，回到上次提交的状态。未提交的内容无法恢复。`
  }
  return `「${path}」未暂存的改动会丢掉（回到已暂存 / 上次提交的状态）。未提交的内容无法恢复。`
}

/** 目录级回退的确认文案：说清涉及几个文件、有几个会被直接删掉 */
function dirRollbackWarning(target: { path: string; changes: GitChange[]; staged: boolean }): string {
  const deletes = target.changes.filter(
    (c) => (target.staged ? c.index === 'A' || c.index === '?' : c.index === '?')
  ).length
  const base = target.staged
    ? `「${target.path}」里这 ${target.changes.length} 个文件已暂存的那份改动、以及它之后在工作区里的改动都会丢掉，回到上次提交的状态。`
    : `「${target.path}」里这 ${target.changes.length} 个文件未暂存的改动会丢掉（回到已暂存 / 上次提交的状态）。`
  const extra = deletes > 0
    ? `其中 ${deletes} 个${target.staged ? '只存在于暂存区的新文件' : '未跟踪文件'}会被从磁盘上删除。`
    : ''
  return `${base}${extra}此操作无法撤销。`
}

/** 确认框的标题 / 确认按钮 / 说明（文件与目录两种目标各写各的，别在 JSX 里堆三元） */
function rollbackDialogTitle(target: RollbackTarget | null): string {
  if (!target) return ''
  if (target.scope === 'dir') return `回滚「${target.path}」里的改动？`
  return rollbackDeletes(target.kind) ? '删除这个文件？' : '放弃这个文件的改动？'
}
function rollbackDialogAction(target: RollbackTarget | null): string {
  if (!target) return '回滚'
  if (target.scope === 'dir') return '回滚这个目录'
  return rollbackDeletes(target.kind) ? '删除文件' : '放弃改动'
}
function rollbackDialogDescription(target: RollbackTarget | null): string {
  if (!target) return ''
  if (target.scope === 'dir') return dirRollbackWarning(target)
  return rollbackWarning(target.kind, target.path)
}

/** 待确认的回退目标：文件行（单文件）或目录行（整棵子树） */
type RollbackTarget =
  | { scope: 'file'; path: string; kind: RollbackKind }
  | { scope: 'dir'; path: string; changes: GitChange[]; staged: boolean }

export function GitPanel({
  cwd,
  onChanges,
  refreshToken
}: {
  /** 工作区目录（用来定位仓库根） */
  cwd: string
  /** 刷新完状态后回报改动数（给入口图标的 badge 用）；null = 不是仓库 */
  onChanges?: (info: { count: number; truncated: boolean } | null) => void
  /**
   * 外部要求重新拉一次状态：每变一次就刷一次。
   *
   * Agent 每跑完一轮（无论成功、失败还是被手动停止）都会改动工作区里的文件，
   * 此时面板内容和入口 badge 都得跟上 —— 但面板自己只认 `cwd` 变化与用户手动操作，
   * 两者都不会发生，所以由外部递一个递增的令牌进来（见 AgentPage 的 gitRefreshSeq）。
   * 不传就是旧行为：只在 cwd 变化时刷新。
   */
  refreshToken?: number
}) {
  const [status, setStatus] = useState<GitStatusResult | null>(null)
  const [branches, setBranches] = useState<GitBranchesResult | null>(null)
  const [commits, setCommits] = useState<GitCommit[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  /** 正在忙的那一行（按 `s?path` / `w?path` 记，避免两组串台）+ 在忙什么 */
  const [rowBusy, setRowBusy] = useState<{ key: string; kind: 'stage' | 'rollback' } | null>(null)
  /** 待确认的回退：破坏性操作，先弹 Modal 说清后果再动手（文件行 / 目录行共用这一个确认框） */
  const [rollbackTarget, setRollbackTarget] = useState<RollbackTarget | null>(null)
  /** 待确认的「批量回滚」（确认框是共用的一个）：`unstaged` = 「更改」组标题上的入口 */
  const [bulkRollback, setBulkRollback] = useState<'unstaged' | null>(null)
  const [message, setMessage] = useState('')
  /** 各组展开态：默认都展开；折叠后标题上的数量与批量按钮仍在 */
  const [stagedOpen, setStagedOpen] = useState(true)
  const [unstagedOpen, setUnstagedOpen] = useState(true)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [stashesOpen, setStashesOpen] = useState(false)
  /** 树状还是平铺（记在 localStorage，默认树状；面板头部的图标切） */
  const [treeView, setTreeView] = useTreeView()
  /**
   * 折叠中的目录：`${staged ? 's' : 'w'}:${目录路径}` → true。两组各折叠各的，
   * 放在组件 state 里是为了 git 刷新后展开态还在。
   */
  const [collapsedDirs, setCollapsedDirs] = useState<Record<string, boolean>>({})
  /** 展开的文件 diff：`openKey` 是 `${staged ? 's' : 'w'}:${path}`，`diff` 是解析后的 hunks */
  const [openKey, setOpenKey] = useState<string | null>(null)
  const [diff, setDiff] = useState<DiffHunk[] | null>(null)
  const [diffLoading, setDiffLoading] = useState(false)
  /** 「新建分支」弹窗 */
  const [newBranchOpen, setNewBranchOpen] = useState(false)
  const [newBranchName, setNewBranchName] = useState('')
  const [newBranchFrom, setNewBranchFrom] = useState<string>('__head__')
  /** 「管理远端」弹窗：列出全部远端，可增 / 改地址 / 删 */
  const [remoteOpen, setRemoteOpen] = useState(false)
  const [remoteDraft, setRemoteDraft] = useState<{ name: string; url: string; editing: boolean }>({
    name: '',
    url: '',
    editing: false
  })
  /** 「贮藏当前更改」弹窗 */
  const [stashOpen, setStashOpen] = useState(false)
  const [stashMessage, setStashMessage] = useState('')
  const [stashUntracked, setStashUntracked] = useState(false)
  /** 待确认删除的贮藏 */
  const [dropStash, setDropStash] = useState<GitStashEntry | null>(null)
  /** 待确认删除的分支（本地 / 远端） */
  const [deleteTarget, setDeleteTarget] = useState<
    | { kind: 'local'; name: string }
    | { kind: 'remote'; remote: string; branch: string }
    | null
  >(null)
  /** 删除确认框里的「强制删除」（本地分支未合并也删 = `git branch -D`） */
  const [deleteForce, setDeleteForce] = useState(false)
  /** 未跟踪目录（嵌套仓库 / 链接目录）展开后的文件列表（git 不列，得自己读盘） */
  const [dirLists, setDirLists] = useState<Record<string, { items: string[]; loading: boolean }>>({})
  /** 未跟踪目录条目的展开态（与 collapsedDirs 分开：它是只读预览、不参与暂存 / 回退） */
  const [dirEntryOpen, setDirEntryOpen] = useState<Record<string, boolean>>({})

  const onChangesRef = useRef(onChanges)
  onChangesRef.current = onChanges

  /**
   * 拉状态 + 分支 + 历史。`pruneRemote` 只由手动点刷新传 true：顺带 fetch --prune 掉远端已删的分支。
   * 平时（打开面板、写操作之后）不联网，纯本地 ref，快。
   */
  const refresh = useCallback(async (pruneRemote = false): Promise<void> => {
    try {
      const next = await window.api.git.status(cwd)
      setStatus(next)
      setLoadError(null)
      onChangesRef.current?.(
        next.isRepo ? { count: next.changes.length, truncated: next.truncated } : null
      )
      if (next.isRepo) {
        const [b, c] = await Promise.all([
          window.api.git.branches(cwd, pruneRemote),
          window.api.git.log(cwd, 30)
        ])
        setBranches(b)
        setCommits(c)
      }
    } catch (err) {
      setLoadError(errText(err))
    } finally {
      setLoading(false)
    }
  }, [cwd])

  const refreshRef = useRef(refresh)
  refreshRef.current = refresh
  // 依赖 refreshToken：Agent 每跑完一轮递一个新值，这里就跟着重拉一次（走 refreshRef 避免把
  // refresh 本身塞进依赖、随 cwd 变而连带重跑）
  useEffect(() => {
    void refreshRef.current()
  }, [cwd, refreshToken])

  async function run(fn: () => Promise<string>, done?: string): Promise<void> {
    setBusy(true)
    try {
      const out = await fn()
      if (done ?? out) toast.success(done ?? out.split('\n').filter(Boolean).pop() ?? '完成')
      await refreshRef.current()
    } catch (err) {
      toast.error(errText(err))
    } finally {
      setBusy(false)
    }
  }

  /** 最近一次点开的文件 key：用来丢弃「点得太快」时回来的过期 diff */
  const diffReqRef = useRef<string | null>(null)

  /** 展开 / 收起一个文件的 diff（同一时刻只展开一个）：展开时异步拉 diff 并解析成 hunks */
  async function toggleFile(path: string, staged: boolean): Promise<void> {
    const key = `${staged ? 's' : 'w'}:${path}`
    if (openKey === key) {
      diffReqRef.current = null
      setOpenKey(null)
      setDiff(null)
      return
    }
    diffReqRef.current = key
    setOpenKey(key)
    setDiff(null)
    setDiffLoading(true)
    try {
      const res = await window.api.git.diff(cwd, path, staged)
      if (diffReqRef.current !== key) return
      setDiff(parseUnifiedDiff(res))
    } catch (err) {
      if (diffReqRef.current !== key) return
      toast.error(errText(err))
      setOpenKey(null)
    } finally {
      if (diffReqRef.current === key) setDiffLoading(false)
    }
  }

  /** 暂存 / 取消暂存一批路径（单个文件、或树状视图里一个目录下的所有文件共用同一套） */
  async function stagePaths(paths: string[], key: string, staged: boolean): Promise<void> {
    if (!paths.length) return
    setRowBusy({ key, kind: 'stage' })
    try {
      await window.api.git.action(
        cwd,
        staged ? { action: 'unstage', paths } : { action: 'stage', paths }
      )
      await refreshRef.current()
    } catch (err) {
      toast.error(errText(err))
    } finally {
      setRowBusy(null)
    }
  }

  /** 暂存 / 取消暂存一个目录（整棵子树里的所有改动文件） */
  function toggleStageDir(dir: Extract<RowNode, { kind: 'dir' }>, staged: boolean): void {
    void stagePaths(dir.paths, `${staged ? 's' : 'w'}:${dir.path}`, staged)
  }

  /** 回退（真正动手的那一步，确认框点过之后才会走到这里）：文件行与目录行都走它 */
  async function confirmRollback(): Promise<void> {
    const target = rollbackTarget
    if (!target) return
    setRollbackTarget(null)
    // 目录行按所在分组的语义走批量接口；已暂存组 = all（连索引一起回到 HEAD）、更改组 = worktree（已暂存的留着）
    const stagedScope = target.scope === 'dir' ? target.staged : target.kind === 'staged' || target.kind === 'added'
    const paths = target.scope === 'dir' ? target.changes.map((c) => c.path) : [target.path]
    if (!paths.length) return
    const key = `${stagedScope ? 's' : 'w'}:${target.path}`
    setRowBusy({ key, kind: 'rollback' })
    try {
      const mode = stagedScope ? 'all' : 'worktree'
      const output = await window.api.git.action(
        cwd,
        target.scope === 'dir'
          ? { action: 'rollback-all', paths, mode }
          : { action: 'rollback', path: target.path, mode }
      )
      if (lastLine(output)) toast.success(lastLine(output))
      // 展开的 diff 属于「回退前」的内容，收掉免得看着像还没回退
      diffReqRef.current = null
      setOpenKey(null)
      setDiff(null)
      await refreshRef.current()
    } catch (err) {
      toast.error(errText(err))
    } finally {
      setRowBusy(null)
    }
  }

  /** 批量回退（确认框点过之后才走到这里）：只碰列出来的这些文件，仓库里别处不动 */
  async function rollbackListed(): Promise<void> {
    const paths = bulkPaths
    setBulkRollback(null)
    if (!paths.length) return
    await run(async () => {
      const output = await window.api.git.action(cwd, { action: 'rollback-all', paths })
      // 展开的 diff 属于「回退前」的内容，收掉免得看着像还没回退
      diffReqRef.current = null
      setOpenKey(null)
      setDiff(null)
      return output
    })
  }

  /** 打开某个目录行的回退确认框（作用到整棵子树） */
  function openRollbackDir(dir: Extract<RowNode, { kind: 'dir' }>, staged: boolean): void {
    if (!dir.paths.length) return
    const changes = (staged ? stagedChanges : unstagedChanges).filter((c) => dir.paths.includes(c.path))
    if (!changes.length) return
    setRollbackTarget({ scope: 'dir', path: dir.path, changes, staged })
  }

  const changes = status?.changes ?? []
  const stagedChanges = changes.filter((c) => c.index !== ' ' && c.index !== '?')
  const unstagedChanges = changes.filter((c) => c.worktree !== ' ')
  const stashes = status?.stashes ?? []
  const branchLabel = status?.branch ?? (status?.detached ? '分离头指针' : '（无分支）')
  const canCommit = !!message.trim() && stagedChanges.length > 0 && !busy
  const canCreateBranch = newBranchName.trim().length > 0 && !busy

  /** 批量回退要动的文件：「更改」组标题的入口 = 只回滚未暂存 + 未跟踪的那一组 */
  const bulkChanges = bulkRollback === 'unstaged' ? unstagedChanges : []
  const bulkPaths = bulkChanges.map((c) => c.path)
  /** 其中会被**删掉文件**的那几个（未跟踪 `?` 与「只存在于暂存区的新文件」`A`） */
  const bulkDeletes = bulkChanges.filter((c) => c.index === '?' || c.index === 'A').length

  async function commit(): Promise<void> {
    const text = message.trim()
    if (!text) return
    await run(async () => {
      const output = await window.api.git.action(cwd, { action: 'commit', message: text })
      setMessage('')
      return output
    })
  }

  async function createBranch(): Promise<void> {
    const name = newBranchName.trim()
    if (!name) return
    await run(async () => {
      const output = await window.api.git.action(cwd, {
        action: 'create-branch',
        name,
        from: newBranchFrom === '__head__' ? undefined : newBranchFrom
      })
      // 成功才关弹窗（失败时留着输入，让用户改个名字再来）
      setNewBranchOpen(false)
      setNewBranchName('')
      return output
    })
  }

  /** 「管理远端」弹窗里那个表单能不能提交（改地址时名字是锁死的，不用再校验） */
  const canSaveRemote =
    remoteDraft.url.trim().length > 0 && (remoteDraft.editing || remoteDraft.name.trim().length > 0) && !busy
  /** 远端分支名（`origin/feature/x`）→ { remote, branch }：分支名允许带 `/`，只能按第一段拆 */
  function splitRemoteBranch(name: string): { remote: string; branch: string } {
    const slash = name.indexOf('/')
    if (slash < 0) return { remote: name, branch: name }
    return { remote: name.slice(0, slash), branch: name.slice(slash + 1) }
  }

  /** 打开「管理远端」：表单复位成「新增」（没有远端时点推送 / 拉取会直接开到这儿） */
  function openRemoteDialog(): void {
    setRemoteDraft({ name: '', url: '', editing: false })
    setRemoteOpen(true)
  }

  /** 把某一行的地址填进表单，进入「改地址」态（名字不给改：改名是 git remote rename，另说） */
  function editRemote(name: string, url: string): void {
    setRemoteDraft({ name, url, editing: true })
  }

  async function saveRemote(): Promise<void> {
    const name = remoteDraft.editing ? remoteDraft.name : remoteDraft.name.trim()
    const url = remoteDraft.url.trim()
    if (!name || !url) return
    await run(async () => {
      const output = await window.api.git.action(cwd, { action: 'set-remote', name, url })
      // 成功后不关弹窗，只把表单复位回「新增」—— 用户多半还要接着加 / 删
      setRemoteDraft({ name: '', url: '', editing: false })
      return output
    })
  }

  async function removeRemote(name: string): Promise<void> {
    await run(async () => {
      const output = await window.api.git.action(cwd, { action: 'remove-remote', name })
      setRemoteDraft((d) => (d.editing && d.name === name ? { name: '', url: '', editing: false } : d))
      return output
    })
  }

  async function push(remote?: string): Promise<void> {
    if (status && status.remotes.length === 0) {
      openRemoteDialog()
      return
    }
    await run(() => window.api.git.action(cwd, remote ? { action: 'push', remote } : { action: 'push' }))
  }

  /** 拉取：没远端就引导去填地址；分离头指针下没有上游可拉 */
  async function pull(): Promise<void> {
    if (status && status.remotes.length === 0) {
      openRemoteDialog()
      return
    }
    if (status?.detached) return
    if (!status?.upstream) {
      toast.info('当前分支没有上游：先推送一次设好上游')
      return
    }
    await run(() => window.api.git.action(cwd, { action: 'pull' }), '已拉取')
  }

  /** 删分支 / 删远端分支（确认框点过「删除」之后才走到这里） */
  async function deleteBranchOrRemote(): Promise<void> {
    const t = deleteTarget
    if (!t) return
    const force = deleteForce
    setDeleteTarget(null)
    setDeleteForce(false)
    await run(async () =>
      t.kind === 'remote'
        ? window.api.git.action(cwd, { action: 'delete-remote-branch', remote: t.remote, branch: t.branch })
        : window.api.git.action(cwd, { action: 'delete-branch', name: t.name, force })
    )
  }

  function openStashDialog(): void {
    setStashMessage('')
    setStashUntracked(false)
    setStashOpen(true)
  }

  async function stashChanges(): Promise<void> {
    await run(async () => {
      const message = stashMessage.trim()
      const output = await window.api.git.action(cwd, {
        action: 'stash-push',
        ...(message ? { message } : {}),
        includeUntracked: stashUntracked
      })
      setStashOpen(false)
      return output || '已贮藏当前改动'
    })
  }

  /**
   * 弹出（pop）/ 应用（apply）一次贮藏。
   *
   * 刻意不走 `run()`：它只在成功时刷新，而 `stash pop` 撞上冲突是**失败但也真的改了工作区**
   * （冲突标记已经落在文件里、stash 还在栈里）。只在成功分支刷新的话，屏幕上的改动列表会和磁盘对不上。
   */
  async function applyStash(target: GitStashEntry, pop: boolean): Promise<void> {
    setBusy(true)
    try {
      const output = await window.api.git.action(cwd, {
        action: pop ? 'stash-pop' : 'stash-apply',
        ref: target.ref
      })
      toast.success(output || (pop ? '已弹出贮藏' : '已应用贮藏'))
      await refreshRef.current()
    } catch (err) {
      // 冲突信息全在 git 的输出里（stdout），所以主进程那边用的是「stderr 优先、stdout 兜底」
      toast.error(errText(err))
      await refreshRef.current()
    } finally {
      setBusy(false)
    }
  }

  async function dropStashEntry(): Promise<void> {
    const target = dropStash
    setDropStash(null)
    if (!target) return
    await run(() => window.api.git.action(cwd, { action: 'stash-drop', ref: target.ref }))
  }

  /** 展开行下方的 diff 区（加载中 / 无可展示内容 / 正常渲染） */
  function diffArea(path: string, staged: boolean): ReactNode {
    if (!diff) return null
    return (
      <FileDiffView
        path={staged ? `${path}（已暂存）` : path}
        hunks={diff}
      />
    )
  }

  function toggleDir(staged: boolean, dirPath: string): void {
    const key = `${staged ? 's' : 'w'}:${dirPath}`
    setCollapsedDirs((prev) => ({ ...prev, [key]: !prev[key] }))
  }

  /** 一次性折叠 / 展开这一组里的所有目录 */
  function setAllDirsCollapsed(staged: boolean, dirs: string[], collapse: boolean): void {
    const prefix = staged ? 's:' : 'w:'
    setCollapsedDirs((prev) => {
      const next = { ...prev }
      for (const dir of dirs) next[`${prefix}${dir}`] = collapse
      return next
    })
  }

  /**
   * 组标题行上的「全部折叠 / 全部展开」：一键把这一组的目录收起来或摊开。
   * 只在树状视图、且这一组里真有目录时出现（平铺视图没有目录可言）。
   */
  function collapseAllButton(staged: boolean): ReactNode {
    if (!treeView) return null
    const dirs = buildRows(
      (staged ? stagedChanges : unstagedChanges).map((c) => ({ change: c, letter: c.index }))
    ).flatMap((n) => (n.kind === 'dir' ? [n.path, ...collectDirPaths(n)] : []))
    if (!dirs.length) return null
    const prefix = staged ? 's:' : 'w:'
    const allCollapsed = dirs.every((dir) => collapsedDirs[`${prefix}${dir}`])
    const label = allCollapsed ? '展开这一组里的所有目录' : '折叠这一组里的所有目录'
    return (
      <Button
        type="text"
        size="small"
        title={label}
        aria-label={label}
        onClick={() => setAllDirsCollapsed(staged, dirs, !allCollapsed)}
        className="!h-5 !w-5 !px-0 !text-muted-foreground hover:!bg-foreground/10"
        icon={allCollapsed ? <ChevronsUpDown className="size-3.5" /> : <ChevronsDownUp className="size-3.5" />}
      />
    )
  }

  // 展开的 diff 可能藏在某个目录里：点开文件时把它的祖先目录一并展开，不然那个 diff 会跟着目录一起收起来
  useEffect(() => {
    if (!openKey) return
    const sep = openKey.indexOf(':')
    const parts = openKey.slice(sep + 1).split('/')
    if (parts.length < 2) return
    const prefix = `${openKey.slice(0, sep)}:`
    const openDirs: Record<string, boolean> = {}
    let dirPath = ''
    for (const seg of parts.slice(0, -1)) {
      dirPath = dirPath ? `${dirPath}/${seg}` : seg
      openDirs[`${prefix}${dirPath}`] = false
    }
    setCollapsedDirs((prev) => {
      const changed = Object.keys(openDirs).some((k) => prev[k] === true)
      return changed ? { ...prev, ...openDirs } : prev
    })
  }, [openKey])

  /** 树状下只显示文件名（目录名已在父目录行里），完整路径进 title；重命名的旧名由 `fileTitle` 自己取 */
  function shortLabel(change: GitChange): string {
    return change.path.split('/').pop() ?? change.path
  }

  /** 一行文件（点开看 diff，右侧是暂存 / 回退）。`name` 是树里显示的短名，完整路径留在 tooltip。 */
  function changeRow(change: GitChange, staged: boolean, depth: number): ReactNode {
    const key = `${staged ? 's' : 'w'}:${change.path}`
    const open = openKey === key
    const letter = staged ? change.index : (change.index === '?' ? '?' : change.worktree)
    return (
      <div key={key}>
        <div
          onClick={() => void toggleFile(change.path, staged)}
          style={{ paddingLeft: depth * INDENT + 2 }}
          className="flex min-w-0 cursor-pointer items-center gap-1.5 rounded py-0.5 pr-1 hover:bg-foreground/5"
        >
          {arrow(open)}
          {fileTitle(change, letter, staged, treeView ? shortLabel(change) : change.path)}
        </div>
        {open && (
          <div className="pb-1.5 pr-1" style={{ paddingLeft: (depth + 1) * INDENT + 2 }}>
            {diffLoading ? (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" /> 读取 diff…
              </div>
            ) : (
              diffArea(change.path, staged)
            )}
          </div>
        )}
      </div>
    )
  }

  /** 目录行右侧的两个按钮：暂存 / 取消暂存整棵子树、回退整棵子树 */
  function dirActions(dir: Extract<RowNode, { kind: 'dir' }>, staged: boolean): ReactNode {
    const key = `${staged ? 's' : 'w'}:${dir.path}`
    const busyKind = rowBusy?.key === key ? rowBusy.kind : null
    const stageLabel = staged ? '取消暂存这个目录' : '暂存这个目录'
    const rollbackLabel = staged
      ? '放弃这个目录的全部改动（含已暂存的），回到上次提交'
      : '丢弃这个目录里未暂存的改动'
    return (
      <>
        <Button
          type="text"
          size="small"
          title={stageLabel}
          disabled={busy || busyKind !== null || status?.truncated === true}
          onClick={(e) => {
            e.stopPropagation()
            void toggleStageDir(dir, staged)
          }}
          className="!px-0 !h-6 !w-6 !text-muted-foreground hover:!bg-foreground/10"
          icon={
            busyKind === 'stage' ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : staged ? (
              <Minus className="size-3.5" />
            ) : (
              <Plus className="size-3.5" />
            )
          }
        />
        <Button
          type="text"
          size="small"
          title={rollbackLabel}
          disabled={busy || busyKind !== null}
          onClick={(e) => {
            e.stopPropagation()
            void openRollbackDir(dir, staged)
          }}
          className="!px-0 !h-6 !w-6 !text-muted-foreground/70 hover:!bg-destructive/10 hover:!text-destructive"
          icon={busyKind === 'rollback' ? <Loader2 className="size-3.5 animate-spin" /> : <RotateCcw className="size-3.5" />}
        />
      </>
    )
  }

  /** 折成目录树后递归渲染（树状视图）；平铺时每条一行、显示完整路径 */
  function changeTree(group: 's' | 'w', list: GitChange[], letter: (c: GitChange) => string): ReactNode {
    if (!treeView) return <>{list.map((c) => changeRow(c, group === 's', 0))}</>
    const nodes = buildRows(list.map((c) => ({ change: c, letter: letter(c) })))
    const render = (ns: RowNode[], depth: number): ReactNode => (
      <>
        {ns.map((node) => {
          if (node.kind === 'dir') {
            const key = `${group}:${node.path}`
            const open = !collapsedDirs[key]
            return (
              <div key={key}>
                <div
                  onClick={() => toggleDir(group === 's', node.path)}
                  style={{ paddingLeft: depth * INDENT + 2 }}
                  className="flex min-w-0 cursor-pointer items-center gap-1.5 rounded py-0.5 pr-1 hover:bg-foreground/5"
                >
                  {open ? (
                    <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
                  ) : (
                    <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
                  )}
                  <Folder className="size-3.5 shrink-0 text-muted-foreground/60" />
                  <span
                    className="min-w-0 flex-1 truncate text-sm text-muted-foreground"
                    title={`${node.path}（${node.paths.length} 个文件）`}
                  >
                    {node.name}
                  </span>
                  <span className="shrink-0 font-mono text-xs text-muted-foreground/50">{node.paths.length}</span>
                  {dirActions(node, group === 's')}
                </div>
                {open && render(node.children, depth + 1)}
              </div>
            )
          }
          if (node.kind === 'dirEntry') {
            // 未跟踪的目录（嵌套仓库 / 链接目录）：git 不列里面的文件，展开只读预览，不参与提交
            const key = `${group}:${node.change.path}`
            const open = !!dirEntryOpen[key]
            const list = dirLists[key]
            return (
              <div key={key}>
                <div
                  onClick={() => {
                    const wasOpen = open
                    setDirEntryOpen((p) => ({ ...p, [key]: !open }))
                    if (!wasOpen && !dirLists[key]) loadDirList(key, node.change.path)
                  }}
                  style={{ paddingLeft: depth * INDENT + 2 }}
                  className="flex min-w-0 cursor-pointer items-center gap-1.5 rounded py-0.5 pr-1 hover:bg-foreground/5"
                  title={`${node.change.path}\n未跟踪的目录（独立仓库 / 链接目录）：git 不列出里面的文件；展开只是磁盘内容预览，不参与提交`}
                >
                  {open ? (
                    <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
                  ) : (
                    <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
                  )}
                  <Folder className="size-3.5 shrink-0 text-muted-foreground/60" />
                  <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">{node.name}</span>
                  {rowActions({ kind: 'dir', paths: [node.change.path] }, group === 's', key)}
                </div>
                {open && (
                  <div style={{ paddingLeft: (depth + 1) * INDENT + 2 }} className="pb-1 pr-1">
                    {list?.loading ? (
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <Loader2 className="size-3.5 animate-spin" /> 读取目录…
                      </div>
                    ) : (
                      <div className="rounded border border-border/50 bg-secondary/20 p-1.5">
                        <div className="mb-1 text-[11px] leading-4 text-muted-foreground">
                          目录内容预览（只读、不参与提交）：git 不跨入独立仓库 / 链接目录。
                        </div>
                        {list && list.items.length > 0 ? (
                          <div className="max-h-40 overflow-y-auto font-mono text-[11px] text-muted-foreground/80">
                            {list.items.map((p) => (
                              <div key={p} className="truncate" title={p}>
                                {p}
                              </div>
                            ))}
                            {list.items.length >= DIR_PREVIEW_LIMIT && (
                              <div className="text-muted-foreground/60">
                                …（还有更多，只列前 {DIR_PREVIEW_LIMIT} 项）
                              </div>
                            )}
                          </div>
                        ) : (
                          <div className="text-[11px] text-muted-foreground">目录里没有文件</div>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          }
          return changeRow(node.change, group === 's', depth)
        })}
      </>
    )
    return render(nodes, 0)
  }

  /** 展开箭头：手写（antd Tree 的 switcher 样式 / 图标不受控），展开时转 90° */
  const arrow = (open: boolean): ReactNode => (
    <ChevronRight
      className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')}
    />
  )

  /** 单个文件行的内容（状态字母 + 文件名 + 暂存 / 回退按钮） */
  function fileTitle(change: GitChange, letter: string, staged: boolean, name: string): ReactNode {
    const key = `${staged ? 's' : 'w'}:${change.path}`
    return (
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <span
          className={cn('w-3.5 shrink-0 text-center font-mono text-xs font-semibold', statusTone(letter))}
          title={STATUS_LABEL[letter] ?? letter}
        >
          {letter}
        </span>
        <span
          className="min-w-0 flex-1 truncate text-sm"
          title={change.origPath ? `${change.origPath} → ${change.path}` : change.path}
        >
          {change.origPath ? (
            <>
              <span className="text-muted-foreground/70">{change.origPath}</span>
              <span className="text-muted-foreground/50"> → </span>
              <span>{change.path}</span>
            </>
          ) : (
            name
          )}
        </span>
        {rowActions({ kind: 'file', change }, staged, key)}
      </div>
    )
  }

  /**
   * 行右侧的「暂存 / 回退」按钮。
   * - 文件行：只作用于这一个文件；
   * - 目录行：作用于该目录下**所有变更条目**（含子目录）—— 回退统一走批量确认弹窗。
   */
  const rowActions = (
    target: { kind: 'file'; change: GitChange } | { kind: 'dir'; paths: string[] },
    staged: boolean,
    busyKey: string
  ) => {
    const busy = rowBusy?.key === busyKey ? rowBusy.kind : null
    const paths = target.kind === 'file' ? [target.change.path] : target.paths
    const scopeHint = target.kind === 'dir' ? `（该目录下 ${paths.length} 个改动）` : ''
    return (
      <>
        <Button
          type="text"
          size="small"
          title={staged ? `取消暂存${scopeHint}` : `暂存${scopeHint}`}
          disabled={busy !== null}
          onClick={(e) => {
            e.stopPropagation()
            void stagePaths(paths, busyKey, staged)
          }}
          className="!px-0 !h-6 !w-6 !text-muted-foreground hover:!bg-foreground/10"
          icon={
            busy === 'stage' ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : staged ? (
              <Minus className="size-3.5" />
            ) : (
              <Plus className="size-3.5" />
            )
          }
        />
        <Button
          type="text"
          size="small"
          title={target.kind === 'dir' ? `回退${scopeHint}` : '回退（丢弃未提交的改动）'}
          disabled={busy !== null}
          onClick={(e) => {
            e.stopPropagation()
            if (target.kind === 'file') {
              setRollbackTarget({ scope: 'file', path: target.change.path, kind: kindOf(target.change, staged) })
            } else {
              // 目录（含未跟踪目录条目）：把整棵子树 / 该目录路径收进 changes，确认时按路径批量回退
              const changes = (staged ? stagedChanges : unstagedChanges).filter((c) =>
                target.paths.includes(c.path)
              )
              setRollbackTarget({ scope: 'dir', path: target.paths[0] ?? '', changes, staged })
            }
          }}
          className="!px-0 !h-6 !w-6 !text-muted-foreground/70 hover:!bg-destructive/10 hover:!text-destructive"
          icon={busy === 'rollback' ? <Loader2 className="size-3.5 animate-spin" /> : <RotateCcw className="size-3.5" />}
        />
      </>
    )
  }

  /** 单行文件的回退类型（未跟踪 / 只暂存 / 已暂存 / 工作区） */
  function kindOf(change: GitChange, staged: boolean): RollbackKind {
    return staged
      ? change.index === 'A'
        ? 'added'
        : 'staged'
      : change.index === '?'
        ? 'untracked'
        : 'worktree'
  }

  /** 展开未跟踪目录时读它的文件列表（只用于展示，不参与暂存 / 回退） */
  function loadDirList(key: string, path: string): void {
    setDirLists((d) => ({ ...d, [key]: { items: [], loading: true } }))
    window.api.git
      .dirList(cwd, path)
      .then((items) => setDirLists((d) => ({ ...d, [key]: { items, loading: false } })))
      .catch((err) => {
        toast.error(errText(err))
        setDirLists((d) => ({ ...d, [key]: { items: [], loading: false } }))
      })
  }

  /** sticky 分组标题（标题即开关，右侧是批量操作 / 折叠目录） */
  function groupHeader(opts: {
    open: boolean
    setOpen: () => void
    label: string
    count: number
    extra?: ReactNode
  }): ReactNode {
    return (
      <div className="sticky top-0 z-10 -mx-1 flex items-center gap-1.5 bg-background px-2.5 py-1 text-sm font-medium text-muted-foreground">
        <button
          type="button"
          onClick={opts.setOpen}
          title={opts.open ? '收起这一组' : '展开这一组'}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left hover:text-foreground"
        >
          {opts.open ? (
            <ChevronDown className="size-3.5 shrink-0" />
          ) : (
            <ChevronRight className="size-3.5 shrink-0" />
          )}
          <span className="shrink-0">{opts.label}</span>
          <span className="shrink-0 text-muted-foreground/60">{opts.count}</span>
        </button>
        {opts.extra}
      </div>
    )
  }

  /** 历史提交行（叶子，不可展开） */
  const commitRow = (c: GitCommit): ReactNode => (
    <div
      key={`commit:${c.hash}`}
      style={{ paddingLeft: INDENT + 2 }}
      className="flex min-w-0 items-center gap-2 rounded py-0.5 pr-1 hover:bg-foreground/5"
    >
      <span className="w-3.5 shrink-0" />
      <span className="shrink-0 font-mono text-xs text-muted-foreground">{c.short}</span>
      <span className="min-w-0 flex-1 truncate text-sm" title={`${c.subject}\n${c.author} · ${c.date}`}>
        {c.subject}
      </span>
      <Button
        type="text"
        size="small"
        title="检出这次提交（分离头指针）"
        disabled={busy}
        onClick={(e) => {
          e.stopPropagation()
          void run(() => window.api.git.action(cwd, { action: 'checkout', ref: c.hash }))
        }}
        className="!px-1.5 !h-5 !text-muted-foreground hover:!bg-foreground/10"
      >
        检出
      </Button>
    </div>
  )

  /** 贮藏行：引用名 + 说明 + 弹出 / 应用 / 删除 */
  const stashRow = (s: GitStashEntry): ReactNode => (
    <div
      key={s.ref}
      style={{ paddingLeft: INDENT + 2 }}
      className="flex min-w-0 items-center gap-1.5 rounded py-0.5 pr-1 hover:bg-foreground/5"
    >
      <span className="shrink-0 font-mono text-xs text-muted-foreground">{s.ref}</span>
      <span className="min-w-0 flex-1 truncate text-sm" title={s.message}>
        {s.message}
      </span>
      <Button
        type="text"
        size="small"
        title="弹出（git stash pop）：应用这次贮藏，并从栈里删掉"
        disabled={busy}
        onClick={() => void applyStash(s, true)}
        className="!px-1.5 !h-5 !text-muted-foreground hover:!bg-foreground/10"
        icon={<ArchiveRestore className="size-3" />}
      >
        弹出
      </Button>
      <Button
        type="text"
        size="small"
        title="应用（git stash apply）：应用这次贮藏，但留在栈里"
        disabled={busy}
        onClick={() => void applyStash(s, false)}
        className="!px-1.5 !h-5 !text-muted-foreground hover:!bg-foreground/10"
      >
        应用
      </Button>
      <Button
        type="text"
        size="small"
        title="删除这次贮藏（git stash drop）…"
        aria-label="删除这次贮藏"
        disabled={busy}
        onClick={() => setDropStash(s)}
        className="!px-0 !h-6 !w-6 !text-muted-foreground/70 hover:!bg-destructive/10 hover:!text-destructive"
        icon={<Trash2 className="size-3.5" />}
      />
    </div>
  )

  /**
   * 分支下拉（头部标题位）：切换本地 / 远端分支，行尾那颗垃圾桶删分支。
   * 不是仓库（含加载中）时返回 null（此时标题位显示「源代码管理」）。
   */
  function branchDropdown(): ReactNode {
    if (!status?.isRepo) return null
    const trashBtn = (
      title: string,
      disabled: boolean,
      onClick: (e: { stopPropagation: () => void }) => void
    ): ReactNode => (
      <Button
        type="text"
        size="small"
        title={title}
        aria-label={title}
        disabled={disabled}
        onClick={(e) => {
          e.stopPropagation()
          onClick(e)
        }}
        className="!h-6 !w-6 !px-0 !text-muted-foreground/50 hover:!bg-destructive/10 hover:!text-destructive"
        icon={<Trash2 className="size-3.5" />}
      />
    )
    return (
      <Dropdown
        trigger={['click']}
        menu={{
          items: [
            {
              type: 'group',
              label: '本地分支',
              children: branches?.branches.length
                ? branches.branches.map((name) => ({
                    key: `local:${name}`,
                    label: (
                      <div className="flex min-w-0 items-center gap-1.5">
                        <span className="min-w-0 flex-1 truncate">{name}</span>
                        {name === status.branch && <Check className="size-3.5 shrink-0" />}
                        {trashBtn(
                          name === status.branch ? '不能删除当前所在的分支' : `删除本地分支 ${name}…`,
                          name === status.branch || busy,
                          () => {
                            setDeleteForce(false)
                            setDeleteTarget({ kind: 'local', name })
                          }
                        )}
                      </div>
                    ),
                    onClick: () =>
                      void run(() => window.api.git.action(cwd, { action: 'checkout', ref: name }))
                  }))
                : [{ key: 'nobranch', label: '还没有任何分支（先提交一次）', disabled: true }]
            },
            ...(branches?.remotes.length
              ? [
                  { type: 'divider' as const },
                  {
                    type: 'group' as const,
                    label: '远端分支（检出为分离头指针）',
                    children: branches.remotes.map((name) => ({
                      key: `remote:${name}`,
                      label: (
                        <div className="flex min-w-0 items-center gap-1.5">
                          <span className="min-w-0 flex-1 truncate">{name}</span>
                          {trashBtn(
                            `删除远端分支 ${name}…`,
                            busy,
                            () => {
                              const { remote, branch } = splitRemoteBranch(name)
                              setDeleteForce(false)
                              setDeleteTarget({ kind: 'remote', remote, branch })
                            }
                          )}
                        </div>
                      ),
                      onClick: () =>
                        void run(() => window.api.git.action(cwd, { action: 'checkout', ref: name }))
                    }))
                  }
                ]
              : [])
          ]
        }}
      >
        <Button
          type="text"
          size="small"
          disabled={busy}
          title={status.root}
          className="flex min-w-0 items-center gap-1 !px-1.5 !h-7 !text-foreground hover:!bg-foreground/10"
        >
          <span className="max-w-[140px] truncate">{branchLabel}</span>
          {status.detached && (
            <span className="shrink-0 rounded bg-amber-500/15 px-1 py-0.5 text-[10px] text-amber-600">
              分离头
            </span>
          )}
          {status.ahead > 0 && <span className="shrink-0 text-[10px] text-emerald-500">↑{status.ahead}</span>}
          {status.behind > 0 && <span className="shrink-0 text-[10px] text-amber-500">↓{status.behind}</span>}
          {status.remotes.length === 0 ? (
            <span className="shrink-0 text-[10px] text-amber-600">未配置远端</span>
          ) : status.upstream ? (
            <span className="hidden min-w-0 truncate text-[10px] text-muted-foreground/70 sm:inline">
              {status.upstream}
            </span>
          ) : null}
          <ChevronDown className="size-3 shrink-0" />
        </Button>
      </Dropdown>
    )
  }

  /** 「拉取」那条为什么不能点（或该先去做什么）—— 直接写进菜单项的 tooltip */
  function pullTitle(): string {
    if (!status) return ''
    if (status.remotes.length === 0) return '还没有远端：先填一个远端地址'
    if (status.detached) return '分离头指针状态下不能拉取'
    if (!status.upstream) return '当前分支没有上游：先推送一次设好上游'
    return `从 ${status.upstream} 拉取`
  }

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      // Ctrl / ⌘ + Shift + Enter = 推送（提交是 Ctrl + Enter，见提交输入框 —— 那边刻意排除了 shift，所以两套组合不会互相触发）
      onKeyDown={(e) => {
        if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'Enter') {
          e.preventDefault()
          void push()
        }
      }}
    >
      <div className="flex shrink-0 items-center gap-1.5 border-b border-border/70 px-3 py-2">
        <GitBranchIcon className="size-4 shrink-0 text-muted-foreground" />
        {status?.isRepo ? branchDropdown() : <span className="text-sm font-medium">源代码管理</span>}
        <span className="ml-auto flex items-center gap-1">
          <Button
            type="text"
            size="small"
            title="刷新"
            disabled={busy}
            onClick={() => void refresh(true)}
            className="!px-0 !h-7 !w-7 !text-muted-foreground hover:!bg-foreground/10"
            icon={<RefreshCw className={cn('size-3.5', loading && 'animate-spin')} />}
          />
          {status?.isRepo && (
            <Button
              type="text"
              size="small"
              title={treeView ? '改为平铺列表' : '按目录树显示'}
              aria-label={treeView ? '改为平铺列表' : '按目录树显示'}
              disabled={busy}
              onClick={() => setTreeView(!treeView)}
              className="!px-0 !h-7 !w-7 !text-muted-foreground hover:!bg-foreground/10"
              icon={treeView ? <ListTree className="size-3.5" /> : <List className="size-3.5" />}
            />
          )}
          {status?.isRepo && (
            <Dropdown
              trigger={['click']}
              menu={{
                items: [
                  {
                    key: 'pull',
                    label: `拉取${status.behind > 0 ? ` ${status.behind}` : ''}`,
                    icon: <ArrowDown className="size-3.5" />,
                    title: pullTitle(),
                    disabled: busy || status.detached,
                    onClick: () => void pull()
                  },
                  {
                    key: 'push',
                    label: `推送${status.ahead > 0 ? ` ${status.ahead}` : ''}`,
                    icon: <Upload className="size-3.5" />,
                    disabled: busy || status.detached,
                    onClick: () => void push()
                  },
                  ...(status.remotes.length > 1
                    ? [
                        {
                          key: 'push-to',
                          label: '推送到…',
                          icon: <Network className="size-3.5" />,
                          disabled: busy || status.detached,
                          children: status.remotes.map((r) => ({
                            key: `push:${r.name}`,
                            label: r.name,
                            title: r.url,
                            onClick: () => void push(r.name)
                          }))
                        }
                      ]
                    : []),
                  { type: 'divider' as const },
                  {
                    key: 'stash',
                    label: '贮藏当前更改…',
                    icon: <Archive className="size-3.5" />,
                    title: '把工作区与暂存区的改动收进贮藏栈，工作区回到干净状态',
                    disabled: busy,
                    onClick: () => openStashDialog()
                  },
                  { type: 'divider' as const },
                  {
                    key: 'new-branch',
                    label: '新建分支…',
                    icon: <GitBranchPlus className="size-3.5" />,
                    disabled: busy,
                    onClick: () => {
                      setNewBranchName('')
                      setNewBranchFrom('__head__')
                      setNewBranchOpen(true)
                    }
                  },
                  {
                    key: 'remotes',
                    label: '管理远端…',
                    icon: <Network className="size-3.5" />,
                    disabled: busy,
                    onClick: () => openRemoteDialog()
                  }
                ]
              }}
            >
              <Button
                type="text"
                size="small"
                title="更多操作"
                aria-label="更多操作"
                disabled={busy}
                className="!px-0 !h-7 !w-7 !text-muted-foreground hover:!bg-foreground/10"
                icon={<MoreHorizontal className="size-3.5" />}
              />
            </Dropdown>
          )}
        </span>
      </div>

      {loading ? (
        <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> 读取仓库状态…
        </div>
      ) : loadError ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center text-sm text-muted-foreground">
          <span>{loadError}</span>
          <Button size="small" onClick={() => void refresh(true)}>
            重试
          </Button>
        </div>
      ) : !status?.isRepo ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <GitBranchIcon className="size-6 text-muted-foreground/50" />
          <p className="text-sm text-muted-foreground">这个工作区还不是 git 仓库。</p>
          <Button
            type="primary"
            size="small"
            loading={busy}
            icon={<Plus className="size-3.5" />}
            onClick={() => void run(() => window.api.git.action(cwd, { action: 'init' }), '已初始化 git 仓库')}
          >
            初始化 git 仓库
          </Button>
          <p className="max-w-[280px] text-xs text-muted-foreground/70">
            初始化后所有文件都是未跟踪状态；建议先补一个 <code>.gitignore</code> 再提交。
          </p>
        </div>
      ) : (
        <>
          {/* 提交区：一行贴在变更列表上方 —— 输入提交信息，点提交（或 Ctrl / ⌘ + Enter）；只提交已暂存的改动 */}
          <div className="flex shrink-0 items-center gap-1.5 border-b border-border/70 p-2">
            <Input
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              onKeyDown={(e) => {
                // 刻意排除 shift：Ctrl / ⌘ + Shift + Enter 是面板级的「推送」，不排掉的话这个输入框会把带 shift 的那一下也吞成提交
                if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key === 'Enter' && canCommit) {
                  e.preventDefault()
                  void commit()
                }
              }}
              placeholder="提交信息（Ctrl / ⌘ + Enter 提交）"
              className="min-w-0 flex-1"
            />
            <Button
              type="primary"
              size="small"
              disabled={!canCommit}
              title={stagedChanges.length === 0 ? '先在「已暂存的更改」里暂存改动' : '提交已暂存的改动'}
              onClick={() => void commit()}
            >
              提交
            </Button>
            {busy && <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
            {changes.length === 0 && commits.length === 0 ? (
              <div className="px-3 py-2 text-xs text-muted-foreground">没有未提交的改动</div>
            ) : (
              <>
                {status.truncated && (
                  <div className="mx-1.5 mb-2 rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-xs text-amber-600">
                    改动太多，只列出前 {changes.length} 项（多半是没配 <code>.gitignore</code> 的依赖 / 产物目录）。
                    为避免漏提交，批量暂存已停用，建议先把这些目录加进 <code>.gitignore</code>。
                  </div>
                )}
                {stagedChanges.length > 0 && (
                  <div className="mb-2">
                    {groupHeader({
                      open: stagedOpen,
                      setOpen: () => setStagedOpen((v) => !v),
                      label: '已暂存的更改',
                      count: stagedChanges.length,
                      extra: (
                        <>
                          {collapseAllButton(true)}
                          <Button
                            type="text"
                            size="small"
                            title={status?.truncated ? '改动过多、列表已截断，批量操作已停用' : '全部取消暂存'}
                            disabled={busy || status?.truncated}
                            onClick={() =>
                              void run(
                                () =>
                                  window.api.git.action(cwd, {
                                    action: 'unstage',
                                    paths: stagedChanges.map((c) => c.path)
                                  }),
                                '已全部取消暂存'
                              )
                            }
                            className="!h-5 !gap-1 !px-1.5 !text-muted-foreground hover:!bg-foreground/10"
                            icon={<Minus className="size-3" />}
                          >
                            全部
                          </Button>
                        </>
                      )
                    })}
                    {stagedOpen && (
                      <div className="pl-2">{changeTree('s', stagedChanges, (c) => c.index)}</div>
                    )}
                  </div>
                )}
                {unstagedChanges.length > 0 && (
                  <div className="mb-2">
                    {groupHeader({
                      open: unstagedOpen,
                      setOpen: () => setUnstagedOpen((v) => !v),
                      label: '更改',
                      count: unstagedChanges.length,
                      extra: (
                        <>
                          {collapseAllButton(false)}
                          <Button
                            type="text"
                            size="small"
                            title="回滚「更改」里列出的这些文件（未暂存 + 未跟踪）"
                            disabled={busy}
                            onClick={() => setBulkRollback('unstaged')}
                            className="!h-5 !gap-1 !px-1.5 !text-muted-foreground hover:!text-destructive"
                            icon={<RotateCcw className="size-4" />}
                          >
                            回滚
                          </Button>
                          <Button
                            type="text"
                            size="small"
                            title={status?.truncated ? '改动过多、列表已截断，批量操作已停用' : '全部暂存'}
                            disabled={busy || status?.truncated}
                            onClick={() =>
                              void run(
                                () =>
                                  window.api.git.action(cwd, {
                                    action: 'stage',
                                    paths: unstagedChanges.map((c) => c.path)
                                  }),
                                '已全部暂存'
                              )
                            }
                            className="!h-5 !gap-1 !px-1.5 !text-muted-foreground hover:!bg-foreground/10"
                            icon={<Plus className="size-4" />}
                          >
                            全部
                          </Button>
                        </>
                      )
                    })}
                    {unstagedOpen && (
                      <div className="pl-2">
                        {changeTree('w', unstagedChanges, (c) => (c.index === '?' ? '?' : c.worktree))}
                      </div>
                    )}
                  </div>
                )}
              </>
            )}

            {/* 历史：点「检出」切到某次提交（分离头指针），用分支下拉切回去 */}
            <div className="mt-1 border-t border-border/60">
              <div className="sticky top-0 z-10 -mx-1 bg-background px-1">
                <button
                  type="button"
                  onClick={() => setHistoryOpen((v) => !v)}
                  className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-sm font-medium text-muted-foreground hover:bg-foreground/5"
                >
                  {historyOpen ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
                  历史提交
                  <span className="text-muted-foreground/60">{commits.length}</span>
                </button>
              </div>
              {historyOpen && (
                <div className="pl-2">
                  {commits.length ? (
                    commits.map(commitRow)
                  ) : (
                    <div className="px-2 py-1 text-xs text-muted-foreground">还没有提交</div>
                  )}
                </div>
              )}
            </div>

            {/* 贮藏：与「历史提交」同一套折叠；每一行可弹出（pop）/ 应用（apply）/ 删除（drop） */}
            <div className="mt-1 border-t border-border/60 pt-1">
              <div className="sticky top-0 z-10 -mx-1 flex items-center gap-1 bg-background px-1">
                <button
                  type="button"
                  onClick={() => setStashesOpen((v) => !v)}
                  className="flex min-w-0 flex-1 items-center gap-1.5 rounded px-1.5 py-1 text-sm font-medium text-muted-foreground hover:bg-foreground/5"
                >
                  {stashesOpen ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
                  贮藏
                  <span className="text-muted-foreground/60">{stashes.length}</span>
                </button>
                <Button
                  type="text"
                  size="small"
                  title="贮藏当前更改（git stash）：工作区清空，改动收进贮藏栈"
                  aria-label="贮藏当前更改"
                  disabled={busy}
                  onClick={() => openStashDialog()}
                  className="!h-6 !w-6 !px-0 !text-muted-foreground hover:!text-foreground"
                  icon={<Archive className="size-3.5" />}
                />
              </div>
              {stashesOpen && (
                <div className="pl-2">
                  {stashes.length ? (
                    stashes.map(stashRow)
                  ) : (
                    <div className="px-2 py-1 text-xs text-muted-foreground">还没有贮藏</div>
                  )}
                </div>
              )}
            </div>
          </div>

          <Modal
            open={newBranchOpen}
            title="新建分支"
            onCancel={() => setNewBranchOpen(false)}
            onOk={() => void createBranch()}
            okText="创建并切换"
            okButtonProps={{ disabled: !canCreateBranch || busy }}
          >
            <div className="space-y-2!">
              <Input
                value={newBranchName}
                onChange={(e) => setNewBranchName(e.target.value)}
                onPressEnter={() => void createBranch()}
                placeholder="分支名，如 feature/login"
                autoFocus
              />
              <div className="flex items-center gap-2">
                <span className="shrink-0 text-xs text-muted-foreground">起点</span>
                <Select
                  value={newBranchFrom}
                  onChange={(v) => setNewBranchFrom(v as string)}
                  className="flex-1"
                  options={[
                    { value: '__head__', label: `当前 HEAD${branchLabel ? `（${branchLabel}）` : ''}` },
                    ...(branches?.branches ?? []).map((name) => ({ value: name, label: name })),
                    ...(branches?.remotes ?? []).map((name) => ({ value: name, label: name }))
                  ]}
                />
              </div>
              <p className="text-xs text-muted-foreground/70">
                从下面的起点切出一条新分支并切过去（当前未提交的改动会带到新分支）。
              </p>
            </div>
          </Modal>

          {/* 管理远端：新增 / 改地址 / 删，都在一个弹窗里 */}
          <Modal
            open={remoteOpen}
            title="管理远端"
            onCancel={() => setRemoteOpen(false)}
            footer={null}
            styles={{ body: { maxHeight: '72vh', overflowY: 'auto' } }}
          >
            <div className="space-y-2">
              {/* 表单行：flex-wrap，远端地址很长时整行换行而不是溢出弹窗宽度 */}
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  value={remoteDraft.name}
                  onChange={(e) => setRemoteDraft((d) => ({ ...d, name: e.target.value }))}
                  disabled={remoteDraft.editing}
                  onPressEnter={() => void saveRemote()}
                  placeholder="origin"
                  className="w-28 shrink-0"
                />
                <Input
                  value={remoteDraft.url}
                  onChange={(e) => setRemoteDraft((d) => ({ ...d, url: e.target.value }))}
                  onPressEnter={() => void saveRemote()}
                  placeholder="git@github.com:you/repo.git"
                  autoFocus
                  className="min-w-0 flex-1"
                />
                <Button
                  type="primary"
                  size="small"
                  disabled={!canSaveRemote}
                  onClick={() => void saveRemote()}
                  className="shrink-0"
                >
                  {remoteDraft.editing ? '保存' : '添加'}
                </Button>
                {remoteDraft.editing && (
                  <Button
                    size="small"
                    onClick={() => setRemoteDraft({ name: '', url: '', editing: false })}
                    className="shrink-0"
                  >
                    取消
                  </Button>
                )}
              </div>
              {remoteDraft.editing && (
                <p className="text-xs text-muted-foreground">
                  正在修改远端「{remoteDraft.name}」的地址（名称不可改，改名请用 git remote rename）。
                </p>
              )}
              <p className="text-xs text-muted-foreground/70">
                填一个远端地址就能推送（同名已存在时改的就是它的地址）。
              </p>
              {status?.remotes.length ? (
                status.remotes.map((r) => (
                  <div key={r.name} className="flex flex-wrap items-center gap-2">
                    <span className="w-20 shrink-0 truncate font-mono text-sm">{r.name}</span>
                    <span
                      className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
                      title={r.url}
                    >
                      {r.url}
                    </span>
                    <Button
                      size="small"
                      icon={<Pencil className="size-3.5" />}
                      onClick={() => editRemote(r.name, r.url)}
                      className="shrink-0"
                    >
                      改地址
                    </Button>
                    <Popconfirm
                      title="删除远端"
                      description={`确定删除远端「${r.name}」吗？它的远端跟踪分支与当前分支对它的上游配置会一起消失（不影响本地分支与提交）。`}
                      okText="删除"
                      cancelText="取消"
                      okButtonProps={{ danger: true }}
                      onConfirm={() => void removeRemote(r.name)}
                    >
                      <Button size="small" danger icon={<Trash2 className="size-3.5" />} className="shrink-0" />
                    </Popconfirm>
                  </div>
                ))
              ) : (
                <p className="text-sm text-muted-foreground">还没有配置任何远端。</p>
              )}
            </div>
          </Modal>

          <Modal
            open={stashOpen}
            title="贮藏当前更改"
            onCancel={() => setStashOpen(false)}
            onOk={() => void stashChanges()}
            okText="贮藏"
            okButtonProps={{ disabled: busy }}
          >
            <div className="space-y-2">
              <Input
                value={stashMessage}
                onChange={(e) => setStashMessage(e.target.value)}
                placeholder="说明（可选），如：临时收起登录接口改动"
                autoFocus
              />
              <Checkbox checked={stashUntracked} onChange={(e) => setStashUntracked(e.target.checked)}>
                连未跟踪文件一起收（<code>git stash -u</code>）
              </Checkbox>
              <p className="text-xs text-muted-foreground/70">
                工作区与暂存区会回到干净状态，改动收进贮藏栈，之后可在「贮藏」分组里弹出或应用。
                不勾上面那项的话，新文件会留在工作区。
              </p>
            </div>
          </Modal>

          <Modal
            open={dropStash !== null}
            title="删除这次贮藏？"
            onCancel={() => setDropStash(null)}
            onOk={() => void dropStashEntry()}
            okText="删除"
            okButtonProps={{ danger: true }}
          >
            <p className="text-sm text-muted-foreground">
              <span className="font-mono">{dropStash?.ref}</span>（{dropStash?.message}）
              会从贮藏栈里删掉，此操作不可恢复。
            </p>
          </Modal>

          <Modal
            open={deleteTarget !== null}
            title={
              deleteTarget?.kind === 'local'
                ? '删除本地分支？'
                : '删除远端分支？'
            }
            onCancel={() => setDeleteTarget(null)}
            onOk={() => void deleteBranchOrRemote()}
            okText="删除"
            okButtonProps={{ danger: true }}
          >
            <div className="space-y-2 text-sm text-muted-foreground">
              {deleteTarget?.kind === 'local' && (
                <>
                  <p>
                    <span className="font-mono">{deleteTarget.name}</span> 会被删除。
                    删除后该分支上的提交只剩 <code>reflog</code>（默认约 90 天）能找回。
                  </p>
                  <Checkbox checked={deleteForce} onChange={(e) => setDeleteForce(e.target.checked)}>
                    强制删除（连未合并的提交一起删，即 <code>git branch -D</code>）
                  </Checkbox>
                </>
              )}
              {deleteTarget?.kind === 'remote' && (
                <p>
                  远端分支{' '}
                  <span className="font-mono">
                    {deleteTarget.remote}/{deleteTarget.branch}
                  </span>{' '}
                  会被删除（<code>git push --delete</code>），需要远端写权限。此操作不可恢复。
                </p>
              )}
            </div>
          </Modal>

          <Modal
            open={rollbackTarget !== null}
            title={rollbackDialogTitle(rollbackTarget)}
            onCancel={() => setRollbackTarget(null)}
            onOk={() => void confirmRollback()}
            okText={rollbackDialogAction(rollbackTarget)}
            okButtonProps={{ danger: true }}
          >
            <p className="text-sm text-muted-foreground">{rollbackDialogDescription(rollbackTarget)}</p>
          </Modal>

          <Modal
            open={bulkRollback !== null}
            title="回滚改动？"
            onCancel={() => setBulkRollback(null)}
            onOk={() => void rollbackListed()}
            okText="回滚"
            okButtonProps={{ danger: true }}
          >
            <p className="text-sm text-muted-foreground">
              将放弃下面 {bulkPaths.length} 个文件的未提交改动（含未跟踪文件会被删除）
              {bulkDeletes > 0 ? `，其中 ${bulkDeletes} 个会被从磁盘上删除` : ''}，此操作不可恢复。
            </p>
          </Modal>
        </>
      )}
    </div>
  )
}

/** 收集一个目录节点下的所有子目录路径（给「一键折叠/展开目录」用） */
function collectDirPaths(dir: Extract<RowNode, { kind: 'dir' }>): string[] {
  const out: string[] = []
  for (const child of dir.children) {
    if (child.kind === 'dir') {
      out.push(child.path)
      out.push(...collectDirPaths(child))
    }
  }
  return out
}
