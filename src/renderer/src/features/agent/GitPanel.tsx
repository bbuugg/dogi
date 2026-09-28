import { useCallback, useEffect, useRef, useState } from 'react'
import type { Key } from 'react'
import { Button, Dropdown, Input, Modal, Select, Tree, message as toast } from 'antd'
import type { TreeDataNode } from 'antd'
import { cn } from 'cn'
import {
  ChevronDown,
  GitBranch as GitBranchIcon,
  GitBranchPlus,
  History,
  Loader2,
  Minus,
  Plus,
  RefreshCw,
  RotateCcw,
  Upload,
  X
} from 'lucide-react'
import type { GitBranchesResult, GitChange, GitCommit, GitStatusResult } from '@shared/types'

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
      ? '还没被 git 跟踪（新文件）'
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

export function GitPanel({
  cwd,
  onClose,
  onChanges
}: {
  /** 工作区目录（用来定位仓库根） */
  cwd: string
  onClose: () => void
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
  /** 树形列表的展开键：分组（staged/unstaged/history）+ 文件节点（s:|w: 前缀） */
  const [expandedKeys, setExpandedKeys] = useState<Key[]>(['staged', 'unstaged', 'history'])
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
  /** 回退 / 批量回滚后清掉已展开文件的 diff 与展开态 */
  function clearDiffs(): void {
    diffReqRef.current = {}
    setExpandedKeys((ks) => ks.filter((k) => !/^[sw]:/.test(String(k))))
    setDiffs({})
  }

  async function toggleStage(path: string, staged: boolean): Promise<void> {
    const key = `${staged ? 's' : 'w'}:${path}`
    setRowBusy({ key, kind: 'stage' })
    try {
      await window.api.git.action(cwd, { action: staged ? 'unstage' : 'stage', paths: [path] })
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

  /** 树形展开/收起：文件节点展开时异步拉取 diff，收起时清掉对应 diff */
  const handleExpand = (keys: Key[]): void => {
    const added = keys.filter((k) => !expandedKeys.includes(k))
    setExpandedKeys(keys)
    for (const k of added) {
      const m = /^([sw]):(.+)$/.exec(String(k))
      if (m) loadDiff(`${m[1]}:${m[2]}`, m[2], m[1] === 's')
    }
    const removed = expandedKeys.filter((k) => !keys.includes(k))
    for (const k of removed) {
      if (!/^[sw]:/.test(String(k))) continue
      delete diffReqRef.current[String(k)]
      setDiffs((d) => {
        const next = { ...d }
        delete next[String(k)]
        return next
      })
    }
  }

  /** 单个文件行的标题（状态字母 + 路径 + 暂存/回退按钮），放在 Tree 节点里，天然左对齐 */
  const fileTitle = (change: GitChange, letter: string, staged: boolean) => {
    const key = `${staged ? 's' : 'w'}:${change.path}`
    const busyKey = rowBusy?.key === key ? rowBusy.kind : null
    return (
      <div className="flex min-w-0 items-center gap-2 py-0.5">
        <span
          className={cn('w-3 shrink-0 text-center font-mono text-xs font-semibold', statusTone(letter))}
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
            change.path
          )}
        </span>
        <Button
          type="text"
          size="small"
          title={staged ? '取消暂存' : '暂存'}
          disabled={busyKey !== null}
          onClick={(e) => {
            e.stopPropagation()
            void toggleStage(change.path, staged)
          }}
          className="!px-0 !h-6 !w-6 !text-muted-foreground hover:!bg-foreground/10"
          icon={busyKey === 'stage' ? <Loader2 className="size-3.5 animate-spin" /> : staged ? <Minus className="size-3.5" /> : <Plus className="size-3.5" />}
        />
        <Button
          type="text"
          size="small"
          title="回退（丢弃未提交的改动）"
          disabled={busyKey !== null}
          onClick={(e) => {
            e.stopPropagation()
            setRollbackTarget({ change, staged })
          }}
          className="!px-0 !h-6 !w-6 !text-muted-foreground/70 hover:!bg-destructive/10 hover:!text-destructive"
          icon={busyKey === 'rollback' ? <Loader2 className="size-3.5 animate-spin" /> : <RotateCcw className="size-3.5" />}
        />
      </div>
    )
  }

  /** 文件节点（可展开看 diff） */
  const fileNode = (change: GitChange, letter: string, staged: boolean): TreeDataNode => {
    const key = `${staged ? 's' : 'w'}:${change.path}`
    const expanded = expandedKeys.includes(key)
    return {
      key,
      isLeaf: false,
      title: fileTitle(change, letter, staged),
      children: expanded
        ? [{ key: `diff:${key}`, selectable: false, isLeaf: true, title: <div className="pr-3 pb-1.5"><DiffBlock data={diffs[key]} /></div> }]
        : undefined
    }
  }

  /** 树形数据：已暂存的更改 / 更改 / 历史提交 三组，分别挂文件列表与提交列表 */
  const treeData: TreeDataNode[] = []
  if (stagedChanges.length > 0) {
    treeData.push({
      key: 'staged',
      title: (
        <div className="flex min-w-0 items-center gap-1.5 py-0.5">
          <span className="shrink-0 font-medium text-muted-foreground">已暂存的更改</span>
          <span className="shrink-0 text-muted-foreground/60">{stagedChanges.length}</span>
          <Button
            type="text"
            size="small"
            title={status?.truncated ? '改动过多、列表已截断，批量操作已停用' : '全部取消暂存'}
            disabled={busy || status?.truncated}
            onClick={(e) => {
              e.stopPropagation()
              void run(() => window.api.git.action(cwd, { action: 'unstage', paths: stagedChanges.map((c) => c.path) }), '已全部取消暂存')
            }}
            className="!ml-auto !px-1 !h-6 !text-muted-foreground hover:!bg-foreground/10"
            icon={<Minus className="size-3" />}
          >
            全部
          </Button>
        </div>
      ),
      children: stagedChanges.map((c) => fileNode(c, c.index, true))
    })
  }
  if (unstagedChanges.length > 0) {
    treeData.push({
      key: 'unstaged',
      title: (
        <div className="flex min-w-0 items-center gap-1.5 py-0.5">
          <span className="shrink-0 font-medium text-muted-foreground">更改</span>
          <span className="shrink-0 text-muted-foreground/60">{unstagedChanges.length}</span>
          <span className="ml-auto flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
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
              onClick={() => void run(() => window.api.git.action(cwd, { action: 'stage', paths: unstagedChanges.map((c) => c.path) }), '已全部暂存')}
              icon={<Plus className="size-3" />}
            >
              全部
            </Button>
          </span>
        </div>
      ),
      children: unstagedChanges.map((c) => fileNode(c, c.worktree, false))
    })
  }
  if (commits.length > 0) {
    treeData.push({
      key: 'history',
      title: (
        <div className="flex min-w-0 items-center gap-1.5 py-0.5">
          <History className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="shrink-0 font-medium text-muted-foreground">历史提交</span>
          <span className="shrink-0 text-muted-foreground/60">{commits.length}</span>
        </div>
      ),
      children: commits.map((c) => ({
        key: `commit:${c.hash}`,
        isLeaf: true,
        title: (
          <div className="flex min-w-0 items-center gap-2 py-0.5">
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
              className="!px-0 !h-6 !text-muted-foreground hover:!bg-foreground/10"
            >
              检出
            </Button>
          </div>
        )
      }))
    })
  }

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
          <Button
            type="text"
            size="small"
            title="关闭"
            onClick={onClose}
            className="!px-0 !h-7 !w-7 !text-muted-foreground hover:!bg-foreground/10"
            icon={<X className="size-4" />}
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
              <Tree
                blockNode
                showLine={{ showLeafIcon: false }}
                expandAction="click"
                treeData={treeData}
                expandedKeys={expandedKeys}
                onExpand={handleExpand}
                selectable={false}
                className="git-tree px-1"
              />
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
        title={rollbackDeletes(rollbackTarget?.change ?? { index: ' ', worktree: ' ', path: '' }, rollbackTarget?.staged ?? false) ? '删除这个文件？' : '放弃这个文件的改动？'}
        onCancel={() => setRollbackTarget(null)}
        onOk={() => void rollbackRow()}
        okText={rollbackDeletes(rollbackTarget?.change ?? { index: ' ', worktree: ' ', path: '' }, rollbackTarget?.staged ?? false) ? '删除文件' : '放弃改动'}
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
