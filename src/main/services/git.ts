import { spawn } from 'node:child_process'
import { readdir, rm, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  GitAction,
  GitBranchesResult,
  GitChange,
  GitCommit,
  GitStashEntry,
  GitStatusResult
} from '@shared/types'

/** 一次 git 调用的原始结果 */
interface GitRun {
  code: number
  stdout: string
  stderr: string
}

/**
 * 在工作区里跑一条 git 命令。
 *
 * 不靠 shell：参数走数组直传给 git，路径里带空格 / 特殊字符也不会被 shell 解释。
 * windowsHide 避免 Windows 上弹出黑框。
 *
 * ⚠️ 固定带一个 `-c core.quotepath=false`：git 默认会把**非 ASCII 路径按字节转义**，
 * 中文文件名于是变成 `"\344\270\255\346\226\207.txt"` 这种东西（面板里就是这么显示的）。
 * 关掉之后中文 / emoji 都按原样输出（含空格的路径仍会被 `"` 包起来，见 unquotePath）。
 */
function runGit(cwd: string, args: string[]): Promise<GitRun> {
  return new Promise((resolve) => {
    const proc = spawn('git', ['-c', 'core.quotepath=false', ...args], {
      cwd,
      windowsHide: true,
      /**
       * 面板没有 TTY，缺凭据时 git 会**一直等**用户输入密码，表现为「点推送没反应」。
       * `GIT_TERMINAL_PROMPT=0` 让它立刻失败并报错，用户去设置里补远端凭据 ——
       * 比挂死好。只对网络类命令有意义，对本地命令无害。
       */
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
    })
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (d) => (stdout += d))
    proc.stderr.on('data', (d) => (stderr += d))
    proc.on('error', (e) => (stderr += String(e)))
    proc.on('close', (code) => resolve({ code: code ?? 0, stdout, stderr }))
  })
}

/** 是否是 git 仓库（在 cwd 里能找到工作树与仓库根） */
export async function isGitRepo(cwd: string): Promise<boolean> {
  const r = await runGit(cwd, ['rev-parse', '--is-inside-work-tree'])
  return r.stdout.trim() === 'true'
}

/** 仓库根目录（非仓库返回空串） */
export async function gitRoot(cwd: string): Promise<string> {
  const r = await runGit(cwd, ['rev-parse', '--show-toplevel'])
  return r.code === 0 ? r.stdout.trim() : ''
}

/** 解析 `git status --porcelain=v1 -b` 的首行 `## ...` 头部（分支 / 上游 / ahead-behind） */
function parseHeader(
  header: string
): Pick<GitStatusResult, 'branch' | 'detached' | 'upstream' | 'ahead' | 'behind'> {
  const body = header.slice(3).trim()
  if (body.startsWith('HEAD (no branch)') || body === 'HEAD') {
    return { branch: null, detached: true, upstream: null, ahead: 0, behind: 0 }
  }
  const arrow = body.indexOf('...')
  if (arrow === -1) {
    return { branch: body, detached: false, upstream: null, ahead: 0, behind: 0 }
  }
  const branch = body.slice(0, arrow)
  const rest = body.slice(arrow + 3)
  const bracket = rest.indexOf('[')
  let upstream: string | null = rest.trim()
  let ahead = 0
  let behind = 0
  if (bracket >= 0) {
    upstream = rest.slice(0, bracket).trim()
    const inside = rest.slice(bracket + 1, rest.indexOf(']'))
    const a = inside.match(/ahead (\d+)/)
    const b = inside.match(/behind (\d+)/)
    ahead = a ? Number(a[1]) : 0
    behind = b ? Number(b[1]) : 0
  }
  return { branch, detached: false, upstream, ahead, behind }
}

/** 转义表：porcelain 可能用到的 C 风格单字符转义 */
const C_ESCAPES: Record<string, string> = {
  n: '\n',
  t: '\t',
  r: '\r',
  a: '\x07',
  b: '\b',
  f: '\f',
  v: '\v',
  '\\': '\\',
  '"': '"'
}

/**
 * 还原 porcelain 里被 C 风格引号包起来的路径。
 *
 * 只关掉 `core.quotepath` 还不够：**含空格的路径**照样会被 git 包成 `"a b.txt"`。
 * 那对引号是给解析用的、不属于路径 —— 直接拿去显示会多一对引号，拿去执行
 * `git add -- "a b.txt"` 更会找不到文件（stage / rollback 全部失效）。
 *
 * 引号里除 `\ooo`（八进制字节）还有 `\n` `\t` `\"` `\\` 这些转义，而且八进制是按
 * **字节**给的 —— 一个汉字是 3 个 `\ooo`。所以先把内容攒成字节序列，最后整体按 UTF-8
 * 解码，混着普通字符也不会错位。
 */
function unquotePath(raw: string): string {
  if (raw.length < 2 || !raw.startsWith('"') || !raw.endsWith('"')) return raw
  const body = raw.slice(1, -1)
  const bytes: number[] = []
  const put = (s: string): void => void bytes.push(...Buffer.from(s, 'utf8'))
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]
    if (ch !== '\\') {
      put(ch)
      continue
    }
    const next = body[i + 1]
    if (next === undefined) {
      put('\\')
      break
    }
    i++
    if (C_ESCAPES[next] !== undefined) {
      put(C_ESCAPES[next])
      continue
    }
    if (next >= '0' && next <= '7') {
      let oct = next
      while (oct.length < 3 && body[i + 1] >= '0' && body[i + 1] <= '7') oct += body[++i]
      bytes.push(parseInt(oct, 8) & 0xff)
      continue
    }
    // 未知转义：原样保留，别把内容吃掉
    put(next)
  }
  return Buffer.from(bytes).toString('utf8')
}

/** 解析单条改动（XY + 路径；重命名/复制带 `old -> new`） */
function parseChange(line: string): GitChange {
  const index = line[0]
  const worktree = line[1]
  const rest = line.slice(3)
  if ((index === 'R' || index === 'C') && rest.includes(' -> ')) {
    const idx = rest.indexOf(' -> ')
    return {
      index,
      worktree,
      path: unquotePath(rest.slice(idx + 4)),
      origPath: unquotePath(rest.slice(0, idx))
    }
  }
  return { index, worktree, path: unquotePath(rest) }
}

/** 列出已配置的远端（去重；只取 fetch 行） */
function parseRemotes(out: string): GitStatusResult['remotes'] {
  const map = new Map<string, string>()
  for (const line of out.split('\n')) {
    const tab = line.indexOf('\t')
    if (tab < 0) continue
    const name = line.slice(0, tab)
    const tail = line.slice(tab + 1)
    const url = tail.replace(/\s*\((fetch|push)\)\s*$/, '').trim()
    if (name && url) map.set(name, url)
  }
  return [...map.entries()].map(([name, url]) => ({ name, url }))
}

/** 改动列表上限：超过这个数就截断，避免巨型仓库（没配 .gitignore）把列表卡死 */
const MAX_CHANGES = 200

/** 贮藏栈最多回这么多条（真到几十条的时候，用户要的多半是最近几条） */
const MAX_STASHES = 50

/**
 * 解析 `git stash list --format=%gd%x1f%gs`。
 *
 * 用 `%x1f`（单元分隔符）而不是 `:` 拆：贮藏说明里本来就可能带冒号
 * （git 自动生成的那种形如 `WIP on main: 改了 xx`），而 `\x1f` 不可能出现在
 * git 的引用名或说明里。
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

export async function getGitStatus(cwd: string): Promise<GitStatusResult> {
  if (!(await isGitRepo(cwd))) {
    return {
      isRepo: false,
      root: '',
      branch: null,
      detached: false,
      upstream: null,
      ahead: 0,
      behind: 0,
      remotes: [],
      changes: [],
      truncated: false,
      stashes: []
    }
  }
  const root = await gitRoot(cwd)
  const repo = root || cwd

  /**
   * ⚠️ 未跟踪必须是 `-uall`，**不能**退回 `normal`：normal 会把整个未跟踪目录折叠成
   * `dir/` 一条（git 的省行行为），面板上就是一个「文件夹」条目 —— 它既没有可展开的文件、
   * 也没有 diff，展开只能显示「无可显示的差异」（用户报告：改的是文件夹下的一堆文件）。
   * all 会把目录下的每个文件各列一行，渲染端再按路径把它们折成目录树。
   */
  const [statusRes, remoteRes, stashRes] = await Promise.all([
    runGit(repo, ['status', '--porcelain=v1', '-b', '--untracked-files=all']),
    runGit(repo, ['remote', '-v']),
    runGit(repo, ['stash', 'list', '--format=%gd%x1f%gs'])
  ])

  const lines = statusRes.stdout.split('\n')
  const headerLine = lines.find((l) => l.startsWith('## ')) ?? ''
  const head = parseHeader(headerLine)
  const changeLines = lines.filter((l) => l && !l.startsWith('## '))
  const truncated = changeLines.length > MAX_CHANGES
  const changes = changeLines.slice(0, MAX_CHANGES).map(parseChange)

  return {
    isRepo: true,
    root: repo,
    remotes: parseRemotes(remoteRes.stdout),
    stashes: parseStashes(stashRes.stdout),
    changes,
    truncated,
    ...head
  }
}

export async function getGitBranches(cwd: string, pruneRemote = false): Promise<GitBranchesResult> {
  const root = (await gitRoot(cwd)) || cwd
  /**
   * 手动刷新（pruneRemote=true）时尽力修剪远端已删的分支（`git fetch --prune --all`）。
   *
   * 场景：分支在 GitHub 界面 / 别的客户端删了，本地 `refs/remotes/<remote>/<branch>` 还留着，
   * 分支列表就一直显示它，点「删除远端分支」时 git 报 remote ref does not exist。
   * 只读远端、不动本地分支与提交，所以失败（离线 / 无凭据 / 超时）无所谓 —— 调用方只当没发生。
   * 平时（打开面板、写操作之后）不联网，纯本地 ref，快。
   */
  if (pruneRemote) {
    await runGit(root, ['fetch', '--prune', '--quiet', '--all']).catch(() => {})
  }
  const [local, remote] = await Promise.all([
    runGit(root, ['branch', '--format=%(refname:short)']),
    runGit(root, ['branch', '-r', '--format=%(refname:short)'])
  ])
  const branches = local.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
  // 远端分支里会有 `origin/HEAD -> origin/main` 这种符号引用，跳过
  const remotes = remote.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((b) => !b.includes(' -> '))
  return { branches, remotes }
}

export async function getGitLog(cwd: string, n = 30): Promise<GitCommit[]> {
  const root = (await gitRoot(cwd)) || cwd
  const res = await runGit(root, [
    'log',
    `-n`,
    String(n),
    '--format=%H%x00%h%x00%s%x00%an%x00%ad',
    '--date=short'
  ])
  if (res.code !== 0) return []
  return res.stdout
    .split('\n')
    .map((line) => line.split('\x00'))
    .filter((parts) => parts.length >= 5 && parts[0])
    .map(([hash, short, subject, author, date]) => ({ hash, short, subject, author, date }))
}

/**
 * 取某个文件的 diff（staged=true 取已暂存；否则取工作区未暂存）。
 *
 * ⚠️ 未跟踪文件不在 git 的 index 里，`git diff` 对它**永远输出空** —— 面板上就是
 * 「无可显示的差异」，新文件等于看不到内容。这类文件改用 `--no-index` 跟空设备比，
 * 拿到「整份内容都是新增」的 diff（二进制文件 git 自己会输出 Binary files differ）。
 * `/dev/null` 是 git 内部识别空设备的名字，Windows 上同样成立。
 */
export async function getGitDiff(cwd: string, path: string, staged: boolean): Promise<string> {
  const root = (await gitRoot(cwd)) || cwd
  // 目录条目（`nested/`）没有 diff 可言：git 根本不列出目录里的文件
  if (path.endsWith('/')) return ''
  if (!staged && !(await isTracked(root, path))) {
    // --no-index 有差异时退出码是 1（不是错误），runGit 不看退出码
    const untracked = await runGit(root, ['diff', '--no-index', '--', '/dev/null', path])
    return untracked.stdout
  }
  const args = ['diff']
  if (staged) args.push('--staged')
  args.push('--', path)
  const res = await runGit(root, args)
  return res.stdout
}

/**
 * 列出一个**目录条目**（未跟踪的目录 / 嵌套仓库，见 `buildRows` 的 dirEntry）里的文件。
 *
 * git 不跨仓库边界，`status` 对这种目录只给一行 `nested/` —— 想看里面有什么，只能自己读盘。
 *
 * ⚠️ 这是**只读预览，不参与提交**：里面的文件属于另一个仓库（或链接目录），父仓库 `add`
 * 它们会被 git 拒绝，所以既不能逐个暂存也没有 diff。
 * ⚠️ 默认只取前 **20** 项：整目录列全（曾经是 200）会让「更改」区看起来像几百条改动 ——
 * 用户实测误以为「明明没改东西却列出一堆文件」（见 AGENTS 6.6 第 29 条）。
 * 跳过 `.git`、限制条数并**不跟随符号链接 / junction**（避免绕圈），免得误把依赖目录读爆。
 */
export async function listGitDir(cwd: string, path: string, limit = 20): Promise<string[]> {
  const root = (await gitRoot(cwd)) || cwd
  const out: string[] = []
  const walk = async (dir: string, prefix: string): Promise<void> => {
    if (out.length >= limit) return
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const e of entries) {
      if (out.length >= limit) return
      if (e.name === '.git') continue
      const rel = prefix ? `${prefix}/${e.name}` : e.name
      if (e.isDirectory()) await walk(join(dir, e.name), rel)
      else out.push(rel)
    }
  }
  await walk(join(root, path), '')
  return out
}

/** 文件是否已被 git 跟踪（用来区分 rollback 里「删文件」还是「丢弃改动」） */
async function isTracked(root: string, path: string): Promise<boolean> {
  const r = await runGit(root, ['ls-files', '--error-unmatch', '--', path])
  return r.code === 0
}

/**
 * 丢弃单个文件的工作区改动（连同已暂存的），未跟踪文件则直接从磁盘删除。
 * mode=worktree 只丢工作区那份（保留暂存区）；mode=all 连暂存区一起回 HEAD。
 */
async function rollbackFile(root: string, path: string, mode: 'worktree' | 'all'): Promise<void> {
  const full = join(root, path)
  const tracked = await isTracked(root, path)
  if (!tracked) {
    // 未跟踪：git 没有它的记录，只能从磁盘删。
    // ⚠️ 目录条目（未跟踪的目录 / 嵌套仓库，路径带尾斜杠）必须**递归**删 —— unlink 对目录
    // 在 Windows 上直接失败，表现就是「点了回退没反应」。
    const st = await stat(full).catch(() => null)
    if (st?.isDirectory()) await rm(full, { recursive: true, force: true }).catch(() => {})
    else await unlink(full).catch(() => {})
    return
  }
  if (mode === 'worktree') {
    await runGit(root, ['checkout', '--', path])
  } else {
    await runGit(root, ['checkout', 'HEAD', '--', path])
  }
}

/**
 * 分支 / 远端名的合法性：不允许以 `-` 开头（会被 git 当成选项）、不允许含空白。
 * @returns 出错的人话；合法则 null
 */
function invalidRefName(name: string, label: string): string | null {
  if (!name) return `${label}不能为空`
  if (name.startsWith('-')) return `${label}不合法：${name}`
  if (/\s/.test(name)) return `${label}不合法：${name}`
  return null
}

/** 本地分支是否存在（判定交给 git，不自己猜） */
async function branchExists(repo: string, name: string): Promise<boolean> {
  const r = await runGit(repo, ['show-ref', '--verify', '--quiet', `refs/heads/${name}`])
  return r.code === 0
}

/**
 * 网络动作的输出：**stderr 优先、退回 stdout**。
 *
 * git 的成功信息常写在 stderr（`push`、`pull` 的进度都是），只看 stdout 会把
 * 「已推送」显示成空串；而 `stash pop` 撞上冲突时退出码是 1、「哪个文件冲突、
 * stash 还留着」这些关键信息全在 stdout 上 —— 只看 stderr 会把一段有用的诊断丢掉。
 */
function outputOf(res: GitRun): string {
  return (res.stderr.trim() || res.stdout.trim()).trimEnd()
}

/** 统一跑写操作：非零退出把 git 的原话抛出来，让渲染端当错误消息展示 */
async function runAction(repo: string, action: GitAction): Promise<string> {
  let res: GitRun
  switch (action.action) {
    case 'init':
      res = await runGit(repo, ['init'])
      break
    case 'stage':
      res = await runGit(repo, ['add', '--', ...action.paths])
      break
    case 'unstage':
      res = await runGit(repo, ['restore', '--staged', '--', ...action.paths])
      break
    case 'commit':
      res = await runGit(repo, ['commit', '-m', action.message])
      break
    case 'checkout':
      res = await runGit(repo, ['checkout', action.ref])
      break
    case 'create-branch': {
      const bad = invalidRefName(action.name.trim(), '分支名')
      if (bad) throw new Error(bad)
      if (await branchExists(repo, action.name.trim())) {
        throw new Error(`分支 ${action.name.trim()} 已经存在`)
      }
      res = action.from
        ? await runGit(repo, ['checkout', '-b', action.name, action.from])
        : await runGit(repo, ['checkout', '-b', action.name])
      break
    }
    case 'delete-branch': {
      const name = action.name.trim()
      const bad = invalidRefName(name, '分支名')
      if (bad) throw new Error(bad)
      if (!(await branchExists(repo, name))) throw new Error(`本地分支 ${name} 不存在`)
      // 当前分支 git 一定不让删（也可能被别的 worktree 占着），自己先判一句人话 ——
      // git 的原话是 "cannot delete branch 'x' used by worktree at …"，看不出是被谁占
      const cur = await runGit(repo, ['branch', '--show-current'])
      if (cur.stdout.trim() === name) {
        throw new Error('不能删除当前所在的分支：先切到别的分支再删')
      }
      res = await runGit(
        repo,
        action.force ? ['branch', '--delete', '--force', name] : ['branch', '--delete', name]
      )
      // 把「没合并」翻成面板上的下一步操作：光把 git 原话丢给前端，
      // 用户不知道确认框里还有个「强制删除」的勾能继续
      if (res.code !== 0 && /not fully merged/i.test(res.stderr)) {
        throw new Error(
          `分支 ${name} 还没合并到任何其它分支：勾上「强制删除」才会删（未合并的提交删完只剩 reflog 能找回）`
        )
      }
      break
    }
    case 'delete-remote-branch': {
      const remote = action.remote.trim()
      const branch = action.branch.trim()
      const bad = invalidRefName(remote, '远端名') ?? invalidRefName(branch, '分支名')
      if (bad) throw new Error(bad)
      res = await runGit(repo, ['push', remote, '--delete', branch])
      break
    }
    case 'set-remote': {
      const bad = invalidRefName(action.name.trim(), '远端名')
      if (bad) throw new Error(bad)
      const exists = await runGit(repo, ['remote', 'get-url', action.name])
      res = exists.code === 0
        ? await runGit(repo, ['remote', 'set-url', action.name, action.url])
        : await runGit(repo, ['remote', 'add', action.name, action.url])
      break
    }
    case 'remove-remote': {
      const bad = invalidRefName(action.name.trim(), '远端名')
      if (bad) throw new Error(bad)
      res = await runGit(repo, ['remote', 'remove', action.name.trim()])
      break
    }
    case 'rollback':
      await rollbackFile(repo, action.path, action.mode)
      return ''
    case 'rollback-all': {
      // 目录级回退按所在分组区分语义：未暂存组只丢工作区那份、已暂存组连索引一起回 HEAD
      const mode = action.mode ?? 'all'
      for (const p of action.paths) await rollbackFile(repo, p, mode)
      return ''
    }
    case 'push': {
      const st = await getGitStatus(repo)
      // 指定远端：有上游也**不改**上游配置，只推这一趟；没有上游才顺带 -u
      if (action.remote) {
        if (!st.remotes.some((r) => r.name === action.remote)) {
          throw new Error(`还没有名为 ${action.remote} 的远端：先在「管理远端」里添加`)
        }
        const ref = st.branch ?? 'HEAD'
        res = st.upstream
          ? await runGit(repo, ['push', action.remote, ref])
          : await runGit(repo, ['push', '-u', action.remote, ref])
        break
      }
      // 没指定：按上游推（没有上游就 `--set-upstream` 第一个远端，没有远端则报错）
      if (st.upstream) {
        res = await runGit(repo, ['push'])
      } else if (st.remotes.length === 0) {
        throw new Error('还没有配置远端：先设置远端地址再推送')
      } else {
        const remote = st.remotes[0].name
        const branch = st.branch ?? 'HEAD'
        res = await runGit(repo, ['push', '-u', remote, branch])
      }
      break
    }
    case 'pull':
      res = await runGit(repo, ['pull'])
      break
    case 'stash-push': {
      const args = ['stash', 'push']
      if (action.includeUntracked) args.push('--include-untracked')
      const message = (action.message ?? '').trim()
      if (message) {
        // `-m` 的值以 `-` 开头会被 git 当成选项
        if (message.startsWith('-')) throw new Error('贮藏说明不能以 - 开头')
        args.push('-m', message)
      }
      res = await runGit(repo, args)
      break
    }
    case 'stash-pop':
    case 'stash-apply':
    case 'stash-drop': {
      const ref = (action.ref ?? '').trim()
      // ref 是拼进命令行的，只认 `stash@{n}` 这一种形状，别让它变成任意参数
      if (ref && !/^stash@\{\d+\}$/.test(ref)) throw new Error(`贮藏引用不合法：${ref}`)
      const sub =
        action.action === 'stash-pop'
          ? 'pop'
          : action.action === 'stash-apply'
            ? 'apply'
            : 'drop'
      res = await runGit(repo, ['stash', sub, ...(ref ? [ref] : [])])
      // ⚠️ 用 outputOf（stderr 优先、退回 stdout）而不是只看 stderr：
      // `stash pop` 撞上冲突时退出码是 1，而「哪个文件冲突、stash 还留着」全在 stdout 上
      if (res.code !== 0) throw new Error(outputOf(res) || `git stash ${sub} 失败`)
      return outputOf(res)
    }
  }
  if (res.code !== 0) {
    const msg = res.stderr.trim() || res.stdout.trim() || 'git 命令执行失败'
    throw new Error(msg)
  }
  return outputOf(res)
}

export async function runGitAction(cwd: string, action: GitAction): Promise<string> {
  const root = (await gitRoot(cwd)) || cwd
  return runAction(root, action)
}
