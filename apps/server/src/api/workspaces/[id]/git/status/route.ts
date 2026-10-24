/**
 * 源代码管理（git）：仓库状态。
 * GET /api/workspaces/:id/git/status
 *
 * git 调用走 @fizz/git 的 git-panel.ts（simple-git）。status 的解析保留自有的
 * porcelain v2 解析器 —— 不用 simple-git 的 status()，原因见 git-panel.ts 头注释第 4 条。
 */
import { domain } from '@/lib/server/state'
import { jsonError } from '@/app/api/_lib/auth'
import {
  git,
  gitPanel,
  repoRoot,
  unquotePath,
  workspacePrefix,
  type GitChange,
  type GitStashEntry,
  type GitStatusResult
} from '@fizz/git'

/** 改动列表最多回这么多条 */
const MAX_CHANGES = 2000

/** 贮藏栈最多回这么多条（真到几十条的时候，用户要的多半是最近几条） */
const MAX_STASHES = 50

/**
 * 解析 `git stash list --format=%gd%x1f%gs`。
 *
 * 用 `%x1f`（单元分隔符）而不是 `:` 拆：贮藏说明里本来就可能带冒号，
 * 而 `\x1f` 不可能出现在 git 的引用名或说明里。
 */
function parseStashes(stdout: string): GitStashEntry[] {
  const out: GitStashEntry[] = []
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue
    const [ref = '', message = ''] = line.split('\x1f')
    const m = /^stash@\{(\d+)\}$/.exec(ref.trim())
    if (!m) continue
    out.push({ ref: ref.trim(), index: Number(m[1]), message: message.trim() })
    if (out.length >= MAX_STASHES) break
  }
  return out
}

function parseStatus(
  stdout: string
): Omit<GitStatusResult, 'isRepo' | 'root' | 'remotes' | 'stashes'> {
  let branch: string | null = null
  let detached = false
  let upstream: string | null = null
  let ahead = 0
  let behind = 0
  let truncated = false
  const changes: GitChange[] = []
  const collect = (change: GitChange): void => {
    if (changes.length >= MAX_CHANGES) {
      truncated = true
      return
    }
    changes.push(change)
  }

  for (const line of stdout.split('\n')) {
    if (!line) continue
    if (line.startsWith('# branch.head ')) {
      const value = line.slice('# branch.head '.length).trim()
      if (value === '(detached)') detached = true
      else branch = value
      continue
    }
    if (line.startsWith('# branch.upstream ')) {
      upstream = line.slice('# branch.upstream '.length).trim()
      continue
    }
    if (line.startsWith('# branch.ab ')) {
      const m = /\+(\d+)\s+-(\d+)/.exec(line)
      if (m) {
        ahead = Number(m[1])
        behind = Number(m[2])
      }
      continue
    }
    if (line.startsWith('1 ') || line.startsWith('2 ')) {
      const parts = line.split(' ')
      const xy = parts[1] ?? '..'
      const pathIndex = line.startsWith('2 ') ? 9 : 8
      const [rawPath, rawOrigPath] = parts.slice(pathIndex).join(' ').split('\t')
      if (rawPath) {
        const path = unquotePath(rawPath)
        collect({
          path,
          origPath: rawOrigPath ? unquotePath(rawOrigPath) : undefined,
          index: xy[0] ?? '.',
          worktree: xy[1] ?? '.'
        })
      }
    } else if (line.startsWith('u ')) {
      const parts = line.split(' ')
      const xy = parts[1] ?? '..'
      const path = unquotePath(parts.slice(10).join(' '))
      if (path) collect({ path, index: xy[0] ?? 'U', worktree: xy[1] ?? 'U' })
    } else if (line.startsWith('? ')) {
      collect({ path: unquotePath(line.slice(2)), index: '?', worktree: '?' })
    }
  }

  return { branch, detached, upstream, ahead, behind, changes, truncated }
}

// ---------- 路由 ----------

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const workspace = domain.getWorkspace(id)
  if (!workspace) return jsonError(404, '工作区不存在')
  const root = await repoRoot(workspace.path)
  if (!root) {
    const empty: GitStatusResult = {
      isRepo: false,
      root: null,
      branch: null,
      detached: false,
      upstream: null,
      ahead: 0,
      behind: 0,
      changes: [],
      truncated: false,
      remotes: [],
      stashes: []
    }
    return Response.json(empty)
  }
  const [res, remotes, stashRes, prefix] = await Promise.all([
    git(root, ['status', '--porcelain=v2', '--branch', '--untracked-files=all']),
    // remote -v 的解析交给 simple-git（getRemotes(true) 同时给出 fetch / push 地址）
    gitPanel(root).getRemotes(true).then((list) =>
      list.map((r) => ({ name: r.name, url: r.refs.fetch ?? r.refs.push ?? '' }))
    ).catch(() => []),
    // 还没有任何贮藏时 `git stash list` 输出为空但退出码是 0；真出错（没装 git 等）就当没有，别把状态页拖垮。
    // ⚠️ 分隔符是 git 的 `%x1f`（`%` 开头），**别写成 `\x1f`** —— 那会被 JS 先转成一个真的控制字符，
    // 而 git 拿到字面的 `\x1f` 后只会原样输出，解析时按 0x1F 拆就一个也匹配不上（实测过）
    git(root, ['stash', 'list', '--format=%gd%x1f%gs']).catch(() => ({
      ok: false,
      stdout: '',
      stderr: ''
    })),
    workspacePrefix(workspace.path)
  ])
  if (!res.ok) return jsonError(500, res.stderr || 'git status 失败')
  const parsed = parseStatus(res.stdout)
  const result: GitStatusResult = {
    isRepo: true,
    root,
    remotes,
    ...parsed,
    stashes: parseStashes(stashRes.stdout),
    changes: prefix ? parsed.changes.filter((c) => c.path.startsWith(prefix)) : parsed.changes
  }
  return Response.json(result)
}
