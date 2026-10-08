import { spawn } from 'node:child_process'
import { mkdir, readdir, rm, stat, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type {
  GitAction,
  GitBranchesResult,
  GitChange,
  GitCommit,
  GitStashEntry,
  GitStatusResult
} from '@shared/types'

/** 一次 git 调用的原始结果 */
export interface GitRun {
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
function runGit(
  cwd: string,
  args: string[],
  opts?: { timeoutMs?: number }
): Promise<GitRun> {
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
    /**
     * 超时兜底：网络类命令（push / pull / fetch / clone）没配凭据、SSH 卡在交互、
     * 代理黑洞时可能永远不结束。超时后 kill 掉，错误信息里带上「超时」两个字，
     * 别让面板停在一个转圈的按钮上（挂死比失败难查）。
     */
    let timedOut = false
    const timer =
      opts?.timeoutMs !== undefined
        ? setTimeout(() => {
            timedOut = true
            proc.kill()
          }, opts.timeoutMs)
        : null
    proc.stdout.on('data', (d) => (stdout += d))
    proc.stderr.on('data', (d) => (stderr += d))
    proc.on('error', (e) => (stderr += String(e)))
    proc.on('close', (code) => {
      if (timer) clearTimeout(timer)
      resolve({
        code: code ?? 0,
        stdout,
        stderr: timedOut ? `git ${args[0] ?? ''} 超时（${opts?.timeoutMs}ms）已终止` : stderr
      })
    })
  })
}

/**
 * **只读** git 命令的执行入口，给 Agent 的 `git_read` 工具用（见 services/ai/git-read.ts）。
 *
 * ⚠️ 与 `runAction` 的写路径分开：这里只负责跑命令，**不碰仓库状态**。
 * 参数白名单在调用方（git-read.ts）把关 —— 这个函数不做校验，别把它当安全边界。
 * 固定 30s 超时：只读命令都是本地操作，跑不完基本是仓库损坏或巨量 diff。
 */
export async function runGitRead(cwd: string, args: string[]): Promise<GitRun> {
  return runGit(cwd, args, { timeoutMs: 30_000 })
}

/** 路径是否存在（clone 前判目标目录用） */
async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** 是否是 git 仓库（在 cwd 里能找到工作树与仓库根） */
export async function isGitRepo(cwd: string): Promise<boolean> {
  const r = await runGit(cwd, ['rev-parse', '--is-inside-work-tree'])
  return r.stdout.trim() === 'true'
}

/**
 * 这台机器上有没有装 git（面板的「未安装」引导用）。
 *
 * 判据用 `git --version` 的**退出码**而不是 stdout 内容：没装时 spawn 触发 `error`
 * 事件（ENOENT），stderr 里是 node 的一段报错；装了但输出异常（老版本 / 别的实现）
 * 只要退出码 0 就算能用。
 */
export async function gitVersion(): Promise<{ installed: boolean; version: string | null }> {
  const r = await runGit(process.cwd(), ['--version'])
  return r.code === 0
    ? { installed: true, version: r.stdout.trim() || null }
    : { installed: false, version: null }
}

/**
 * 从仓库地址推导默认目录名：取路径最后一段、去掉 `.git` 后缀。
 * `https://host/owner/repo.git`、`git@host:owner/repo.git` 都适用；推不出来返回空串。
 */
export function repoNameFromUrl(url: string): string {
  const cleaned = url.trim().replace(/\/+$/, '').replace(/\.git$/, '')
  return cleaned.split(/[/:]/).filter(Boolean).pop() ?? ''
}

/**
 * 仓库地址的基本合法性：非空、不以 `-` 开头（git 会把以 `-` 开头的参数当选项解析）、
 * 不含换行。ssh / https / git:// / 本地路径都放行。
 */
export function assertSafeRepoUrl(url: string): void {
  const trimmed = url.trim()
  if (!trimmed) throw new Error('仓库地址不能为空')
  if (trimmed.startsWith('-')) throw new Error('仓库地址不能以「-」开头')
  if (/[\r\n]/.test(trimmed)) throw new Error('仓库地址不能包含换行')
}

/** clone 缺省超时：大仓库走慢网也要给足（10 分钟） */
const CLONE_TIMEOUT_MS = 10 * 60 * 1000

/**
 * 克隆远端仓库到 `destDir`（完整目标路径），返回克隆后的仓库根（即 destDir）。
 *
 * 两条防线叠着挡参数注入：`assertSafeRepoUrl` 显式拒绝 `-` 开头的地址，
 * 命令行再加 `--` 截断选项解析（即使地址被拼成 `-xxx` 也只当 URL 看）。
 * 目标目录**必须不存在**（git 自己也会拒）—— 克隆进一个非空目录是用户最容易踩的坑，
 * 早一步报错比让 git 报一屏 log 清楚。
 */
export async function cloneRepo(input: { url: string; destDir: string }): Promise<string> {
  assertSafeRepoUrl(input.url)
  if (await exists(input.destDir)) {
    throw new Error(`目标目录已存在：${input.destDir}（换一个空目录，或先把已有的挪走）`)
  }
  await mkdir(dirname(input.destDir), { recursive: true })
  const res = await runGit(process.cwd(), ['clone', '--', input.url.trim(), input.destDir], {
    timeoutMs: CLONE_TIMEOUT_MS
  })
  if (res.code !== 0) {
    throw new Error(res.stderr.trim() || res.stdout.trim() || 'git clone 失败')
  }
  return input.destDir
}

/** 仓库根目录（非仓库返回空串） */
export async function gitRoot(cwd: string): Promise<string> {
  const r = await runGit(cwd, ['rev-parse', '--show-toplevel'])
  return r.code === 0 ? r.stdout.trim() : ''
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

/**
 * 解析 `git status --porcelain=v2 --branch` 的输出（移植自 fishwork 的 status route）。
 *
 * ⚠️ **必须是 v2、不能用 v1**：v1 在「刚 init、还没有任何提交」时首行给的是
 * `## No commits yet on master` —— 那句话会被当成**分支名**，面板头部就会显示
 * 「No commits yet on master」而不是分支名与「先提交一次」的提示（实测 git 输出如此）。
 * v2 把头部拆成 `# branch.head <name>` 这样的独立字段，没有这个坑。
 *
 * v2 的行型（`--branch` 会额外给 `#` 开头的头部行）：
 * - `1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>`：普通改动，路径在**下标 8**；
 * - `2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>\t<origPath>`：
 *   重命名 / 复制，`<X><score>` 在下标 8、路径在下标 9，原路径用 **制表符**分隔；
 * - `u <XY> ... <path>`：未合并（冲突），共 10 个字段，路径在下标 10；
 * - `? <path>`：未跟踪；`! <path>`：被忽略（面板不显示）。
 */
function parseStatusV2(
  stdout: string
): Pick<GitStatusResult, 'branch' | 'detached' | 'upstream' | 'ahead' | 'behind' | 'changes' | 'truncated'> {
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
      else branch = value || null
      continue
    }
    if (line.startsWith('# branch.upstream ')) {
      const value = line.slice('# branch.upstream '.length).trim()
      upstream = value || null
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
    if (line.startsWith('#')) continue // branch.oid 之类的头部字段，面板不用

    if (line.startsWith('1 ') || line.startsWith('2 ')) {
      const parts = line.split(' ')
      const xy = parts[1] ?? '..'
      const pathIndex = line.startsWith('2 ') ? 9 : 8
      const [rawPath, rawOrigPath] = parts.slice(pathIndex).join(' ').split('\t')
      if (!rawPath) continue
      collect({
        path: unquotePath(rawPath),
        origPath: rawOrigPath ? unquotePath(rawOrigPath) : undefined,
        index: xy[0] ?? '.',
        worktree: xy[1] ?? '.'
      })
      continue
    }
    if (line.startsWith('u ')) {
      const parts = line.split(' ')
      const xy = parts[1] ?? '..'
      const rawPath = parts.slice(10).join(' ')
      if (rawPath) {
        collect({ path: unquotePath(rawPath), index: xy[0] ?? 'U', worktree: xy[1] ?? 'U' })
      }
      continue
    }
    if (line.startsWith('? ')) {
      collect({ path: unquotePath(line.slice(2)), index: '?', worktree: '?' })
    }
    // `! `（被忽略）不收集：面板不显示忽略文件
  }

  return { branch, detached, upstream, ahead, behind, changes, truncated }
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

/**
 * 改动列表上限：超过这个数就截断，避免巨型仓库（没配 .gitignore）把列表卡死。
 *
 * 取 2000（与 fishwork 一致）：200 太紧，稍脏一点的仓库（比如装完依赖忘了 gitignore）
 * 就会撞上限，面板只能显示「已截断」而用户什么也定位不了。
 */
const MAX_CHANGES = 2000

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
    runGit(repo, ['status', '--porcelain=v2', '--branch', '--untracked-files=all']),
    runGit(repo, ['remote', '-v']),
    runGit(repo, ['stash', 'list', '--format=%gd%x1f%gs'])
  ])

  const parsed = parseStatusV2(statusRes.stdout)
  const { changes: allChanges, ...head } = parsed
  /**
   * 工作区可能只是仓库的一个**子目录**（用户挑的是 packages/app，不是仓库根）。
   * 这时 `git status` 给出的是整个仓库的改动，面板里会出现一堆与当前工作区无关的文件；
   * 用 `rev-parse --show-prefix` 拿到工作区相对仓库根的前缀，只留它下面的（与 fishwork 一致）。
   * ⚠️ 未跟踪项的路径本来就是仓库根相对，同样按这个前缀过滤才不会漏。
   */
  const prefixRes =
    repo === cwd ? null : await runGit(cwd, ['rev-parse', '--show-prefix']).catch(() => null)
  const prefix = prefixRes && prefixRes.code === 0 ? prefixRes.stdout.trim() : ''
  const changes = prefix ? allChanges.filter((c) => c.path.startsWith(prefix)) : allChanges

  return {
    isRepo: true,
    root: repo,
    remotes: parseRemotes(remoteRes.stdout),
    stashes: parseStashes(stashRes.stdout),
    changes,
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
    case 'init-commit': {
      // 三步一步到位：init → 暂存全部（含未跟踪）→ 首次提交。
      // `git add -A` 在 unborn HEAD 上完全合法，不需要先有一个提交。
      const init = await runGit(repo, ['init'])
      if (init.code !== 0) {
        res = init
        break
      }
      const add = await runGit(repo, ['add', '-A'])
      if (add.code !== 0) {
        res = add
        break
      }
      const message = (action.message ?? '').trim() || 'Initial commit'
      if (message.startsWith('-')) throw new Error('提交信息不能以 - 开头')
      res = await runGit(repo, ['commit', '-m', message])
      break
    }
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
