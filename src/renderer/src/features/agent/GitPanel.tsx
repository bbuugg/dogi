import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Button, Dropdown, Input, Modal, Select, message as toast } from 'antd'
import { cn } from 'cn'
import {
  ChevronDown,
  ChevronRight,
  Folder,
  GitBranch as GitBranchIcon,
  GitBranchPlus,
  Loader2,
  Minus,
  Plus,
  RefreshCw,
  RotateCcw,
  Upload
} from 'lucide-react'
import type { GitBranchesResult, GitChange, GitCommit, GitStatusResult } from '@shared/types'
import { buildRows, INDENT, type RowNode } from './git-tree'

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
  return 'text-amber-500'
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** git 的目录条目（未跟踪的目录 / 嵌套仓库）：路径带尾斜杠，文案里要叫「目录」而不是「文件」 */
const isDirEntryPath = (path: string): boolean => path.endsWith('/')

/**
 * 目录条目预览的条数上限（与 `services/git.ts` 的 `listGitDir` 默认值一致）。
 * ⚠️ 别调大：整目录列全会让「更改」区看起来像几百条改动（用户实测以为面板崩了）。
 */
const DIR_PREVIEW_LIMIT = 20

/** 回退会不会把文件本身删掉（决定确认文案） */
function rollbackDeletes(change: GitChange, staged: boolean): boolean {
  const idx = staged ? change.index : change.worktree
  return idx === '?' || (staged && change.index === 'A')
}
function rollbackWarning(change: GitChange, staged: boolean, path: string): string {
  const kind = staged
    ? change.index === 'A'
      ? '只存在于暂存区的新文件'
      : '已暂存那份改动、以及之后的工作区改动'
    : change.worktree === '?'
      ? path.endsWith('/')
        ? '还没被 git 跟踪的目录（git 不会列出里面的文件）'
        : '还没被 git 跟踪（新文件）'
      : '未暂存的改动'
  if (rollbackDeletes(change, staged)) {
    return `「${path}」${kind}：回退会把它从磁盘上删除。此操作无法撤销。`
  }
  return `「${path}」${kind}会丢掉，回到上次提交的状态。未提交的内容无法恢复。`
}

/** 一行 unified diff 的着色 */
function DiffView({ text }: { text: string }) {
  const lines = text.split('\n')
  return (
    <pre className="max-h-72 overflow-auto rounded bg-secondary/40 p-2 font-mono text-[11px] leading-relaxed">
      {/* `min-w-max`：横向滚动容器里的块级行只按容器宽度铺，长行往右滚时那行的
          绿/红底色会在右半边断掉。撑一层到「最长行宽度」的盒子，底色才铺满 */}
      <div className="min-w-max">
        {lines.map((line, i) => {
          let cls = 'text-foreground/80'
          if (line.startsWith('+++') || line.startsWith('---')) cls = 'text-muted-foreground'
          else if (line.startsWith('@@')) cls = 'text-sky-500'
          else if (line.startsWith('+')) cls = 'bg-emerald-500/10 text-emerald-500'
          else if (line.startsWith('-')) cls = 'bg-red-500/10 text-red-500'
          return (
            <div key={i} className={cls}>
              {line || ' '}
            </div>
          )
        })}
      </div>
    </pre>
  )
}

/** diff 预览块：放在文件节点展开后的子节点里，随树缩进、默认左对齐 */
function DiffBlock({ data }: { data?: { text: string | null; loading: boolean } }) {
  if (!data) return null
  if (data.loading) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" /> 读取 diff…
      </div>
    )
  }
  if (data.text) return <DiffView text={data.text} />
  return <div className="text-xs text-muted-foreground">无可显示的差异</div>
}

/** 变更列表折树：纯逻辑在 `git-tree.ts`（可单独跑 `scripts/verify-git-tree.ts`） */


export function GitPanel({
  cwd,
  onChanges
}: {
  /** 工作区目录（用来定位仓库根） */
  cwd: string
  /** 刷新完状态后回报改动数（给入口图标的 badge 用）；null = 不是仓库 */
  onChanges?: (info: { count: number; truncated: boolean } | null) => void
}) {
  const [status, setStatus] = useState<GitStatusResult | null>(null)
  const [branches, setBranches] = useState<GitBranchesResult | null>(null)
  const [commits, setCommits] = useState<GitCommit[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [rowBusy, setRowBusy] = useState<{ key: string; kind: 'stage' | 'rollback' } | null>(null)
  const [message, setMessage] = useState('')
  /** 展开键：分组（staged / unstaged / history）+ 目录节点（dir: 前缀）+ 文件节点（s: / w: 前缀） */
  const [expandedKeys, setExpandedKeys] = useState<string[]>(['staged', 'unstaged', 'history'])
  /** 每个展开文件的 diff：key 同文件节点 key */
  const [diffs, setDiffs] = useState<Record<string, { text: string | null; loading: boolean }>>({})
  const [newBranchOpen, setNewBranchOpen] = useState(false)
  const [newBranchName, setNewBranchName] = useState('')
  const [newBranchFrom, setNewBranchFrom] = useState<string>('__head__')
  const [remoteOpen, setRemoteOpen] = useState(false)
  const [remoteName, setRemoteName] = useState('origin')
  const [remoteUrl, setRemoteUrl] = useState('')
  const [rollbackTarget, setRollbackTarget] = useState<{ change: GitChange; staged: boolean } | null>(null)
  /** 批量回滚确认：非空时弹出 antd Modal 二次确认，存的是待回滚的文件路径 */
  const [rollbackAllPaths, setRollbackAllPaths] = useState<string[] | null>(null)

  const onChangesRef = useRef(onChanges)
  onChangesRef.current = onChanges

  const refresh = useCallback(async () => {
    try {
      const next = await window.api.git.status(cwd)
      setStatus(next)
      setLoadError(null)
      onChangesRef.current?.(next.isRepo ? { count: next.changes.length, truncated: next.truncated } : null)
      if (next.isRepo) {
        const [b, c] = await Promise.all([window.api.git.branches(cwd), window.api.git.log(cwd, 30)])
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
  useEffect(() => {
    void refreshRef.current()
  }, [cwd])

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

  const diffReqRef = useRef<Record<string, number>>({})
  /** 展开文件节点时异步拉取 diff（由 Tree 的 onExpand 调用）。每个文件单独记一个请求号，避免多个文件同时展开时互相覆盖。 */
  function loadDiff(key: string, path: string, staged: boolean): void {
    const reqId = (diffReqRef.current[key] ?? 0) + 1
    diffReqRef.current[key] = reqId
    setDiffs((d) => ({ ...d, [key]: { text: null, loading: true } }))
    window.api.git
      .diff(cwd, path, staged)
      .then((res) => {
        if (diffReqRef.current[key] === reqId) setDiffs((d) => ({ ...d, [key]: { text: res, loading: false } }))
      })
      .catch((err) => {
        if (diffReqRef.current[key] === reqId) {
          toast.error(errText(err))
          setDiffs((d) => ({ ...d, [key]: { text: null, loading: false } }))
        }
      })
  }
  /** 目录条目展开后的文件列表（git 不列，得自己读盘）；key 同该行 */
  const [dirLists, setDirLists] = useState<Record<string, { items: string[]; loading: boolean }>>({})

  /** 展开目录条目时读它的文件列表（只用于展示，不参与暂存 / 回退） */
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

  /** 回退 / 批量回滚后清掉已展开文件的 diff 与展开态 */
  function clearDiffs(): void {
    diffReqRef.current = {}
    setExpandedKeys((ks) => ks.filter((k) => !/^[sw]:/.test(k)))
    setDiffs({})
  }

  /**
   * 暂存 / 取消暂存一批路径：
   * 文件行传单个文件；目录行传该目录下**所有变更条目**（含子目录，由 buildRows 收好）。
   */
  async function toggleStage(paths: string[], staged: boolean, busyKey: string): Promise<void> {
    setRowBusy({ key: busyKey, kind: 'stage' })
    try {
      await window.api.git.action(cwd, { action: staged ? 'unstage' : 'stage', paths })
      await refreshRef.current()
    } catch (err) {
      toast.error(errText(err))
    } finally {
      setRowBusy(null)
    }
  }

  async function rollbackRow(): Promise<void> {
    const t = rollbackTarget
    if (!t) return
    const stagedRow = t.staged
    const key = `${stagedRow ? 's' : 'w'}:${t.change.path}`
    setRollbackTarget(null)
    setRowBusy({ key, kind: 'rollback' })
    try {
      await window.api.git.action(cwd, {
        action: 'rollback',
        path: t.change.path,
        mode: stagedRow ? 'all' : 'worktree'
      })
      clearDiffs()
      toast.success('已回退改动')
      await refreshRef.current()
    } catch (err) {
      toast.error(errText(err))
    } finally {
      setRowBusy(null)
    }
  }

  async function rollbackListed(paths: string[]): Promise<void> {
    if (!paths.length) return
    await run(async () => {
      await window.api.git.action(cwd, { action: 'rollback-all', paths })
      clearDiffs()
      return '已回滚列出的改动'
    })
  }

  async function commit(all: boolean): Promise<void> {
    const text = message.trim()
    if (!text) return
    await run(async () => {
      if (all) {
        const paths = (status?.changes ?? []).map((c) => c.path)
        if (paths.length) await window.api.git.action(cwd, { action: 'stage', paths })
      }
      const out = await window.api.git.action(cwd, { action: 'commit', message: text })
      setMessage('')
      return out
    })
  }

  async function createBranch(): Promise<void> {
    const name = newBranchName.trim()
    if (!name) return
    await run(async () => {
      const out = await window.api.git.action(cwd, {
        action: 'create-branch',
        name,
        from: newBranchFrom === '__head__' ? undefined : newBranchFrom
      })
      setNewBranchOpen(false)
      setNewBranchName('')
      return out
    })
  }

  function openRemoteDialog(): void {
    const origin = status?.remotes.find((r) => r.name === 'origin')
    setRemoteName(origin?.name ?? 'origin')
    setRemoteUrl(origin?.url ?? '')
    setRemoteOpen(true)
  }

  async function setRemote(): Promise<void> {
    const name = remoteName.trim() || 'origin'
    const url = remoteUrl.trim()
    if (!url) return
    await run(async () => {
      const out = await window.api.git.action(cwd, { action: 'set-remote', name, url })
      setRemoteOpen(false)
      return out
    })
  }

  async function push(): Promise<void> {
    if (status && status.remotes.length === 0) {
      openRemoteDialog()
      return
    }
    await run(() => window.api.git.action(cwd, { action: 'push' }))
  }

  const changes = status?.changes ?? []
  const stagedChanges = changes.filter((c) => c.index !== ' ' && c.index !== '?')
  const unstagedChanges = changes.filter((c) => c.worktree !== ' ')
  const branchLabel = status?.branch ?? (status?.detached ? '分离头指针' : '（无分支）')
  const canCommit = !!message.trim() && stagedChanges.length > 0 && !busy
  const canCommitAll = !!message.trim() && changes.length > 0 && !busy && !status?.truncated
  /** 回退确认弹窗的措辞：是「整个删掉」还是「丢弃改动」，删的是目录还是文件 */
  const rollbackDeletesRow = rollbackTarget
    ? rollbackDeletes(rollbackTarget.change, rollbackTarget.staged)
    : false
  const rollbackIsDir = !!rollbackTarget && isDirEntryPath(rollbackTarget.change.path)

  /**
   * 展开 / 收起一个节点（分组、目录、文件共用同一个开关）：
   * 文件节点展开时拉 diff，收起时清掉它的缓存。
   */
  const toggleNode = (key: string): void => {
    const open = expandedKeys.includes(key)
    setExpandedKeys(open ? expandedKeys.filter((k) => k !== key) : [...expandedKeys, key])
    const m = /^([sw]):(.+)$/.exec(key)
    if (!m) return
    if (open) {
      delete diffReqRef.current[key]
      setDiffs((d) => {
        const next = { ...d }
        delete next[key]
        return next
      })
      return
    }
    loadDiff(key, m[2], m[1] === 's')
  }

  /**
   * 行右侧的「暂存 / 回退」按钮。
   * - 文件行：只作用于这一个文件；
   * - 目录行：作用于该目录下**所有变更条目**（含子目录）—— 回退统一走批量确认弹窗，
   *   避免手一抖丢掉一整个目录的改动。
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
            void toggleStage(paths, staged, busyKey)
          }}
          className="!px-0 !h-6 !w-6 !text-muted-foreground hover:!bg-foreground/10"
          icon={busy === 'stage' ? <Loader2 className="size-3.5 animate-spin" /> : staged ? <Minus className="size-3.5" /> : <Plus className="size-3.5" />}
        />
        <Button
          type="text"
          size="small"
          title={target.kind === 'dir' ? `回退${scopeHint}` : '回退（丢弃未提交的改动）'}
          disabled={busy !== null}
          onClick={(e) => {
            e.stopPropagation()
            if (target.kind === 'file') setRollbackTarget({ change: target.change, staged })
            else setRollbackAllPaths(paths)
          }}
          className="!px-0 !h-6 !w-6 !text-muted-foreground/70 hover:!bg-destructive/10 hover:!text-destructive"
          icon={busy === 'rollback' ? <Loader2 className="size-3.5 animate-spin" /> : <RotateCcw className="size-3.5" />}
        />
      </>
    )
  }

  /**
   * 单个文件行的内容（状态字母 + 文件名 + 暂存 / 回退按钮），挂在可点击的行容器里。
   * `name` 是树里显示的短名（所在目录那一级已由父行表达），完整路径留在 tooltip 里。
   */
  const fileTitle = (change: GitChange, letter: string, staged: boolean, name: string) => {
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

  /** 展开箭头：手写（antd Tree 的 switcher 样式 / 图标不受控），展开时转 90° */
  const arrow = (open: boolean): ReactNode => (
    <ChevronRight
      className={cn(
        'size-3.5 shrink-0 text-muted-foreground transition-transform',
        open && 'rotate-90'
      )}
    />
  )

  /**
   * 渲染一组树行（**手写树**，不用 antd Tree）。
   *
   * 缩进 = depth × INDENT，行高 / hover / 箭头全由自己控制；点整行 = 展开收起。
   * 目录只做分组容器（展开列出子节点），diff 挂在文件节点下面。
   */
  const renderRows = (group: 's' | 'w', nodes: RowNode[], depth: number): ReactNode => (
    <>
      {nodes.map((node) => {
        if (node.kind === 'dir') {
          const key = `dir:${group}:${node.path}`
          const open = expandedKeys.includes(key)
          return (
            <div key={key}>
              <div
                onClick={() => toggleNode(key)}
                title={node.path}
                style={{ paddingLeft: depth * INDENT + 2 }}
                className="flex min-w-0 cursor-pointer items-center gap-1.5 rounded py-0.5 pr-1 hover:bg-foreground/5"
              >
                {arrow(open)}
                <Folder className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate text-sm">{node.name}</span>
                {rowActions({ kind: 'dir', paths: node.paths }, group === 's', key)}
              </div>
              {open && renderRows(group, node.children, depth + 1)}
            </div>
          )
        }
        if (node.kind === 'dirEntry') {
          // 目录条目（未跟踪的目录 / 嵌套仓库）：git 不列里面的文件，展开时我们自己读盘看
          const key = `dirEntry:${group}:${node.change.path}`
          const open = expandedKeys.includes(key)
          const list = dirLists[key]
          return (
            <div key={key}>
              <div
                onClick={() => {
                  const wasOpen = open
                  toggleNode(key)
                  if (!wasOpen && !dirLists[key]) loadDirList(key, node.change.path)
                }}
                title={`${node.change.path}\n未跟踪的目录（独立仓库 / 链接目录）：git 不列出里面的文件；展开只是磁盘内容预览，不参与提交`}
                style={{ paddingLeft: depth * INDENT + 2 }}
                className="flex min-w-0 cursor-pointer items-center gap-1.5 rounded py-0.5 pr-1 hover:bg-foreground/5"
              >
                {arrow(open)}
                <Folder className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate text-sm">{node.name}</span>
                {rowActions({ kind: 'dir', paths: [node.change.path] }, group === 's', key)}
              </div>
              {open && (
                <div style={{ paddingLeft: (depth + 1) * INDENT + 2 }} className="pb-1 pr-1">
                  {list?.loading ? (
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Loader2 className="size-3.5 animate-spin" /> 读取目录…
                    </div>
                  ) : (
                    /* 明确写成「只读预览」：这里的名字不是变更行，点了也没有 diff 可看 ——
                       否则一屏文件名会被当成「一堆被修改的文件」（用户实测误解）。 */
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
        const key = `${group}:${node.change.path}`
        const open = expandedKeys.includes(key)
        return (
          <div key={key}>
            <div
              onClick={() => toggleNode(key)}
              style={{ paddingLeft: depth * INDENT + 2 }}
              className="flex min-w-0 cursor-pointer items-center gap-1.5 rounded py-0.5 pr-1 hover:bg-foreground/5"
            >
              {arrow(open)}
              {fileTitle(node.change, node.letter, group === 's', node.name)}
            </div>
            {open && (
              <div className="pb-1.5 pr-1" style={{ paddingLeft: (depth + 1) * INDENT + 2 }}>
                <DiffBlock data={diffs[key]} />
              </div>
            )}
          </div>
        )
      })}
    </>
  )

  /** 分组行：可展开的标题（箭头 + 名称 + 计数）+ 右侧操作按钮，`body` 是展开后的内容 */
  const groupRow = (
    key: string,
    label: string,
    count: number,
    actions: ReactNode,
    body: ReactNode
  ): ReactNode => {
    const open = expandedKeys.includes(key)
    return (
      <div key={key} className="mb-1">
        <div
          onClick={() => toggleNode(key)}
          className="flex min-w-0 cursor-pointer items-center gap-1.5 rounded px-1 py-1 hover:bg-foreground/5"
        >
          {arrow(open)}
          <span className="shrink-0 text-sm font-medium text-muted-foreground">{label}</span>
          <span className="shrink-0 text-xs text-muted-foreground/60">{count}</span>
          {actions && (
            <span className="ml-auto flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
              {actions}
            </span>
          )}
        </div>
        {open && body}
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
      <span
        className="min-w-0 flex-1 truncate text-sm"
        title={`${c.subject}\n${c.author} · ${c.date}`}
      >
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
        className="!px-0 !h-6 !text-muted-foreground hover:!bg-foreground/10"
      >
        检出
      </Button>
    </div>
  )

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border/70 px-3 py-2">
        <GitBranchIcon className="size-4 shrink-0 text-muted-foreground" />
        <span className="text-sm font-medium">源代码管理</span>
        <span className="ml-auto flex items-center gap-1">
          <Button
            type="text"
            size="small"
            title={changes.length === 0 ? '没有未提交的改动' : '回滚列表里列出的全部改动'}
            disabled={busy || changes.length === 0}
            onClick={() => setRollbackAllPaths(changes.map((c) => c.path))}
            icon={<RotateCcw className="size-3.5" />}
            className="!text-muted-foreground hover:!text-destructive disabled:!opacity-40"
          >
            回滚全部
          </Button>
          <Button
            type="text"
            size="small"
            title="刷新"
            disabled={busy}
            onClick={() => void refresh()}
            className="!px-0 !h-7 !w-7 !text-muted-foreground hover:!bg-foreground/10"
            icon={<RefreshCw className={cn('size-3.5', loading && 'animate-spin')} />}
          />
        </span>
      </div>

      {loading ? (
        <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> 读取仓库状态…
        </div>
      ) : loadError ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center text-sm text-muted-foreground">
          <span>{loadError}</span>
          <Button size="small" onClick={() => void refresh()}>
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
        </div>
      ) : (
        <>
          <div className="flex shrink-0 items-center gap-1.5 border-b border-border/70 px-2 py-1.5 text-xs">
            <Dropdown
              menu={{
                items: [
                  ...(branches?.branches.length
                    ? branches.branches.map((name) => ({
                        key: `local:${name}`,
                        label: name,
                        onClick: () => void run(() => window.api.git.action(cwd, { action: 'checkout', ref: name }))
                      }))
                    : [{ key: 'nobranch', label: '还没有任何分支（先提交一次）', disabled: true }]),
                  ...(branches?.remotes.length
                    ? [
                        { type: 'divider' as const },
                        {
                          type: 'group' as const,
                          label: '远端分支（检出为分离头指针）',
                          children: branches.remotes.map((name) => ({
                            key: `remote:${name}`,
                            label: name,
                            onClick: () => void run(() => window.api.git.action(cwd, { action: 'checkout', ref: name }))
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
                className="flex min-w-0 items-center gap-1 !px-1.5 !text-foreground hover:!bg-foreground/10"
              >
                <span className="max-w-[180px] truncate">{branchLabel}</span>
                <ChevronDown className="size-3 shrink-0" />
              </Button>
            </Dropdown>

            {status.detached && (
              <span className="shrink-0 rounded bg-amber-500/15 px-1.5 py-0.5 text-amber-600">分离头指针</span>
            )}
            {status.ahead > 0 && <span className="shrink-0 text-emerald-500">↑{status.ahead}</span>}
            {status.behind > 0 && <span className="shrink-0 text-amber-500">↓{status.behind}</span>}
            {status.remotes.length === 0 ? (
              <Button type="link" size="small" onClick={openRemoteDialog} className="!text-amber-600">
                未配置远端
              </Button>
            ) : status.upstream ? (
              <span className="min-w-0 truncate text-muted-foreground/70">{status.upstream}</span>
            ) : null}

            <Button
              type="text"
              size="small"
              title="新建分支"
              disabled={busy}
              onClick={() => {
                setNewBranchName('')
                setNewBranchFrom('__head__')
                setNewBranchOpen(true)
              }}
              className="ml-auto !px-0 !h-6 !w-6 !text-muted-foreground hover:!bg-foreground/10"
              icon={<GitBranchPlus className="size-3.5" />}
            />
            <Button
              size="small"
              disabled={busy || status.detached}
              title={
                status.remotes.length === 0
                  ? '还没有远端：先填一个远端地址'
                  : status.detached
                    ? '分离头指针状态下不能推送'
                    : '推送到远端（不做强推）'
              }
              onClick={() => void push()}
              icon={<Upload className="size-3.5" />}
            >
              推送{status.ahead > 0 ? ` ${status.ahead}` : ''}
            </Button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-1 py-2">
            {status.truncated && (
              <div className="mx-1.5 mb-2 rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-xs text-amber-600">
                改动太多，只列出前 {changes.length} 项（多半是没配 <code>.gitignore</code> 的依赖 / 产物目录）。
                为避免漏提交，批量暂存已停用，建议先把这些目录加进 <code>.gitignore</code>。
              </div>
            )}
            {changes.length === 0 && commits.length === 0 ? (
              <div className="px-3 py-2 text-sm text-muted-foreground">没有未提交的改动</div>
            ) : (
              <div className="px-1">
                {stagedChanges.length > 0 &&
                  groupRow(
                    'staged',
                    '已暂存的更改',
                    stagedChanges.length,
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
                      className="!px-1 !h-6 !text-muted-foreground hover:!bg-foreground/10"
                      icon={<Minus className="size-3" />}
                    >
                      全部
                    </Button>,
                    renderRows(
                      's',
                      buildRows(stagedChanges.map((c) => ({ change: c, letter: c.index }))),
                      0
                    )
                  )}
                {unstagedChanges.length > 0 &&
                  groupRow(
                    'unstaged',
                    '更改',
                    unstagedChanges.length,
                    <>
                      <Button
                        type="text"
                        size="small"
                        title="回滚「更改」里列出的文件（未暂存 + 未跟踪）"
                        disabled={busy}
                        onClick={() => setRollbackAllPaths(unstagedChanges.map((c) => c.path))}
                        icon={<RotateCcw className="size-3" />}
                        className="!text-muted-foreground hover:!text-destructive"
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
                        icon={<Plus className="size-3" />}
                      >
                        全部
                      </Button>
                    </>,
                    renderRows(
                      'w',
                      buildRows(unstagedChanges.map((c) => ({ change: c, letter: c.worktree }))),
                      0
                    )
                  )}
                {commits.length > 0 &&
                  groupRow('history', '历史提交', commits.length, null, <>{commits.map(commitRow)}</>)}
              </div>
            )}
          </div>

          <div className="shrink-0 border-t border-border/70 p-2">
            <Input.TextArea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="提交信息（Ctrl / ⌘ + Enter 提交）"
              rows={2}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && canCommit) {
                  e.preventDefault()
                  void commit(false)
                }
              }}
            />
            <div className="mt-1.5 flex items-center gap-1.5">
              <Button type="primary" size="small" disabled={!canCommit} onClick={() => void commit(false)}>
                提交
              </Button>
              <Button
                size="small"
                disabled={!canCommitAll}
                onClick={() => void commit(true)}
                title={status.truncated ? '改动过多、列表已截断，批量操作已停用' : '把所有改动（含新文件）暂存后提交'}
              >
                暂存全部并提交
              </Button>
              {busy && <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />}
            </div>
          </div>
        </>
      )}

      <Modal
        open={newBranchOpen}
        title="新建分支"
        onCancel={() => setNewBranchOpen(false)}
        onOk={() => void createBranch()}
        okText="创建并切换"
        okButtonProps={{ disabled: !newBranchName.trim() || busy }}
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
          <p className="text-xs text-muted-foreground/70">从下面的起点切出一条新分支并切过去（当前未提交的改动会带到新分支）。</p>
        </div>
      </Modal>

      <Modal
        open={remoteOpen}
        title="设置远端"
        onCancel={() => setRemoteOpen(false)}
        onOk={() => void setRemote()}
        okText="保存"
        okButtonProps={{ disabled: !remoteUrl.trim() || busy }}
      >
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Input
              value={remoteName}
              onChange={(e) => setRemoteName(e.target.value)}
              onPressEnter={() => void setRemote()}
              placeholder="origin"
              className="w-28 shrink-0"
            />
            <Input
              value={remoteUrl}
              onChange={(e) => setRemoteUrl(e.target.value)}
              onPressEnter={() => void setRemote()}
              placeholder="git@github.com:you/repo.git"
              autoFocus
              className="min-w-0 flex-1"
            />
          </div>
          {status?.remotes.length ? (
            <p className="break-all text-xs text-muted-foreground/70">
              已有远端：{status.remotes.map((r) => `${r.name} → ${r.url}`).join('；')}
            </p>
          ) : null}
          <p className="text-xs text-muted-foreground/70">填一个远端地址就能推送了（同名已存在时改的就是它的地址）。</p>
        </div>
      </Modal>

      <Modal
        open={rollbackTarget !== null}
        title={
          rollbackDeletesRow
            ? rollbackIsDir
              ? '删除这个目录？'
              : '删除这个文件？'
            : '放弃这个文件的改动？'
        }
        onCancel={() => setRollbackTarget(null)}
        onOk={() => void rollbackRow()}
        okText={rollbackDeletesRow ? (rollbackIsDir ? '删除目录' : '删除文件') : '放弃改动'}
        okButtonProps={{ danger: true }}
      >
        <p className="text-sm text-muted-foreground">
          {rollbackTarget && rollbackWarning(rollbackTarget.change, rollbackTarget.staged, rollbackTarget.change.path)}
        </p>
      </Modal>

      <Modal
        open={rollbackAllPaths !== null}
        title="回滚改动？"
        onCancel={() => setRollbackAllPaths(null)}
        onOk={() => {
          const paths = rollbackAllPaths ?? []
          setRollbackAllPaths(null)
          void rollbackListed(paths)
        }}
        okText="回滚"
        okButtonProps={{ danger: true }}
      >
        <p className="text-sm text-muted-foreground">
          将放弃下面 {rollbackAllPaths?.length ?? 0} 个文件的未提交改动（含未跟踪文件会被删除），此操作不可恢复。
        </p>
      </Modal>
    </div>
  )
}
