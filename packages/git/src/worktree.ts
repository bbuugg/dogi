/**
 * git 辅助：**服务端与容器内 runner 共用同一份**。
 *
 * 分成两处用：
 * - 服务端（`lib/server/tasks/` 与 worktree / git 路由）：校验仓库、建 / 删 worktree、提交；
 * - 容器侧（`docker/container-project/`）：自包含 .mjs 不直接引这份源码，但共用同一套 worktree
 *   约定（挂载布局 / safe.directory / 行尾转换，见 `WORKTREE_CONFIG` 与容器 Dockerfile）。
 *
 * 所以它必须零依赖（只用 node 内置）—— 容器 / 独立 runner 是打进镜像单独跑的，
 * 引不动包里的其它部分（那会拖进 simple-git / AI SDK 一整套）。
 *
 * ⚠️ 三个踩过的坑，都在下面各函数里处理了，别绕过它们直接 spawn git：
 * 1. **一律用 `spawn` / `execFile` 传参数数组**，绝不拼 shell 字符串 —— 路径带空格 / 中文 /
 *    Windows 盘符都会炸，而且拼字符串等于开了个注入口。
 * 2. **面向 worktree 的操作必须带 `WORKTREE_CONFIG`**（safe.directory + 关掉行尾转换）。
 *    漏了 `safe.directory` 是 `detected dubious ownership`；漏了 `core.autocrlf=false`
 *    是**整个仓库被误报成已修改** —— 详细实测见 `WORKTREE_CONFIG` 的注释。
 * 3. **提交必须显式带 `-c user.name -c user.email`**：容器里没有 git 全局身份，
 *    不带就是 `Author identity unknown` 直接失败 —— 而这个失败发生在「agent 已经辛辛苦苦
 *    改完代码」之后，最亏。
 */
import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { isAbsolute, join, relative, resolve } from 'node:path'

export interface GitRunResult {
  code: number
  stdout: string
  stderr: string
}

/** 逐行回调的级别：`error` 只用来给「这行看起来是致命错误」上色，不影响退出码判定 */
export type GitLogLevel = 'info' | 'warn' | 'error'

export interface GitRunOptions {
  cwd?: string
  /** 追加的 `-c key=value`（在子命令之前） */
  config?: Record<string, string>
  /** 超时（毫秒），缺省 60s；clone 之类的大操作自己传大一点 */
  timeoutMs?: number
  /**
   * 外部取消信号：abort 时**杀掉整棵进程树**（`git clone` 自己还会拉
   * `git-remote-https` / `ssh`，只 kill 直接子进程会留下孤儿继续往目标目录写）。
   *
   * 被中止时本函数**照常 resolve**（`code !== 0`），是不是「取消」由调用方看
   * `signal.aborted` 自己判 —— 与 `git()` 不抛异常的整体约定一致。
   */
  signal?: AbortSignal
  /**
   * 每读到一行就回调（stdout / stderr 都走这里）。给「把 git 的输出当日志看」用：
   * `clone` 加上 `--progress` 之后，`Receiving objects: 45%` 这类进度就是这么来的。
   *
   * 回调**同步调用**且不能抛：抛了会打断读流。
   */
  onLine?: (line: string, level: GitLogLevel) => void
}

/**
 * 杀掉一个子进程**整棵树**。
 * Windows 上 `execFile` 的 `kill()` 只终止直接子进程，`taskkill /T` 才是连子孙一起；
 * POSIX 没有进程组概念可用（execFile 未 detached），SIGKILL 直接子进程后，
 * 孤儿子进程写管道会拿到 EPIPE 自行退出。
 */
function killTree(child: ChildProcess | null): Promise<void> {
  if (!child?.pid) return Promise.resolve()
  if (process.platform !== 'win32') {
    try {
      child.kill('SIGKILL')
    } catch {
      // 进程已经没了：正常收场
    }
    return Promise.resolve()
  }
  return new Promise((done) => {
    execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () =>
      done()
    )
  })
}

/** 单条命令最多攒这么多 stdout / stderr（超了只截断不杀进程）：与原 execFile 的 maxBuffer 同量级 */
const MAX_CAPTURE_CHARS = 32 * 1024 * 1024

/** 这行看起来是致命错误吗（只用于给日志上色，不参与退出码判定） */
function levelOfLine(line: string): GitLogLevel {
  if (/^(fatal|error)\s*:/i.test(line)) return 'error'
  if (/^warning\s*:/i.test(line)) return 'warn'
  return 'info'
}

/**
 * 跑一条 git 命令；**不抛异常**，非 0 退出码如实放进返回值（调用方自己判断）。
 *
 * 实现是 `spawn` 而不是 `execFile`：只有流式读才能把 `git clone --progress` 的进度
 * 实时转成日志行（`execFile` 会把所有输出攒到进程退出才给）。行为上仍是「等命令跑完
 * 再 resolve」，需要边跑边看就传 `onLine`。
 */
export function git(args: string[], options: GitRunOptions = {}): Promise<GitRunResult> {
  const configArgs: string[] = []
  for (const [key, value] of Object.entries(options.config ?? {})) {
    configArgs.push('-c', `${key}=${value}`)
  }
  const { signal, onLine } = options
  const timeoutMs = options.timeoutMs ?? 60_000
  return new Promise((resolve) => {
    // 已经取消：连进程都不起（否则「取消」会变成「先跑几秒再被砍」）
    if (signal?.aborted) {
      resolve({ code: 1, stdout: '', stderr: '已取消' })
      return
    }
    let child: ChildProcess | null = null
    let settled = false
    let timedOut = false
    let stdout = ''
    let stderr = ''
    let timer: ReturnType<typeof setTimeout> | undefined

    const finish = (result: GitRunResult): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve(result)
    }
    const onAbort = (): void => {
      void killTree(child)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    timer = setTimeout(() => {
      timedOut = true
      void killTree(child)
    }, timeoutMs)

    /**
     * 行切分器：git 的进度是 `\r` 刷新的（`Receiving objects: 3%\r…45%`），只按 `\n`
     * 切等于把整段进度憋到结束才吐出来 —— 那就失去流式的意义了。
     */
    const reader = (emit: (line: string) => void) => {
      let buffer = ''
      return {
        push(chunk: string): void {
          buffer += chunk
          const parts = buffer.split(/\r\n|\r|\n/)
          buffer = parts.pop() ?? ''
          for (const part of parts) {
            const line = part.trimEnd()
            if (line) emit(line)
          }
        },
        flush(): void {
          const line = buffer.trimEnd()
          buffer = ''
          if (line) emit(line)
        }
      }
    }
    const emit = (line: string): void => {
      if (!onLine) return
      try {
        onLine(line, levelOfLine(line))
      } catch {
        // 回调是调用方的代码：它自己炸了也不该把 git 的结果弄丢
      }
    }
    // 没人听行就不切行（大仓库的 `git status` 上万行，白切一遍纯浪费）
    const outReader = onLine ? reader(emit) : null
    const errReader = onLine ? reader(emit) : null

    child = spawn('git', [...configArgs, ...args], {
      cwd: options.cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      if (stdout.length < MAX_CAPTURE_CHARS) stdout += chunk
      outReader?.push(chunk)
    })
    child.stderr?.on('data', (chunk: string) => {
      if (stderr.length < MAX_CAPTURE_CHARS) stderr += chunk
      errReader?.push(chunk)
    })
    // git 不在 PATH / 没执行权限：只有 error 事件，没有 close 的 code
    child.on('error', (err) => {
      outReader?.flush()
      errReader?.flush()
      finish({ code: 1, stdout, stderr: stderr || err.message })
    })
    child.on('close', (code, sig) => {
      outReader?.flush()
      errReader?.flush()
      // 被超时 / 信号砍掉时 code 是 null：一律归到非 0（调用方只看 stderr 有没有话说）
      const exitCode = typeof code === 'number' ? code : 1
      const timeoutNote =
        timedOut && !stderr.trim() ? `超时（${Math.round(timeoutMs / 1000)}s）` : ''
      finish({
        code: exitCode,
        stdout,
        stderr: stderr || timeoutNote || (sig ? `被信号 ${sig} 终止` : '')
      })
    })
  })
}

/** 跑一条 git 命令，非 0 就抛（错误信息带上 stderr 最后几行，够定位） */
export async function gitOrThrow(args: string[], options: GitRunOptions = {}): Promise<string> {
  const result = await git(args, options)
  if (result.code !== 0) {
    const detail = result.stderr.trim().split('\n').slice(-4).join('\n')
    throw new Error(`git ${args.slice(0, 3).join(' ')} 失败：${detail || `退出码 ${result.code}`}`)
  }
  return result.stdout
}

/**
 * worktree / 容器场景的通用 git 配置。**所有面向 worktree 的操作都要带上它**。
 *
 * - `safe.directory=*`：挂载进来的 worktree 属主 uid 和容器里的用户对不上
 *   （宿主机是 PUID/PGID 降权跑的），git 会以 `detected dubious ownership` 拒绝一切操作。
 *   某些 git 版本只认全局配置里的 `*`，所以容器 entrypoint 还会再
 *   `git config --global --add safe.directory /workspace` 兜一道，两条都留着。
 * - `core.autocrlf=false` + `core.eol=lf`：**这条是实测踩出来的，别删**。
 *   宿主机若是 Windows 且全局 `core.autocrlf=true`（默认安装就是这样），
 *   `git worktree add` 检出来的工作区文件是 **CRLF**；而容器是 Linux，
 *   `core.autocrlf` 默认 false —— 于是容器里 `git status` 把**整个仓库**报成已修改，
 *   跑完 `git add -A` 就提交了一整份纯行尾重写，把真正的改动淹掉。
 *
 *   实测对照（三文件仓库，agent 零改动）：
 *   - 宿主机默认建 worktree → 容器视角 `git status` 报 **3 个文件已改**；
 *   - 建 worktree 时带本配置 → 容器视角报 **0 个**，内容字节是 `\n`。
 *
 *   `false` 的含义是「不做任何转换」——检出的就是对象库里存的字节，
 *   这对 Linux 容器是最可预测的语义（仓库本来就存 CRLF 的话也照旧是 CRLF，不会帮倒忙）。
 */
export const WORKTREE_CONFIG = {
  'safe.directory': '*',
  'core.autocrlf': 'false',
  'core.eol': 'lf'
}

/**
 * 任务 worktree 的落点：**仓库根目录里面**，相对路径写死为 `.fizz/worktrees/<taskId>`。
 *
 * 为什么必须放在仓库**内部**（而不是 `~/.fizz/worktrees` 那种外部目录）：
 * 容器只挂载 `.git` 与这一条 worktree 目录，两条挂载点在容器里被摆成
 * 「相对层级与宿主机完全一致」的样子：
 *
 *     宿主机                                    容器
 *     <repo>/.git                            →  /workspace/.git
 *     <repo>/.fizz/worktrees/<taskId>    →  /workspace/.fizz/worktrees/<taskId>
 *
 * 于是 worktree 里那个 `.git` 文件写的相对指针
 * （`gitdir: ../../../.git/worktrees/<taskId>`，由 `--relative-paths` 生成）
 * 在两边解析出**同一个位置**。绝对路径做不到这一点：宿主机是 `D:/repos/foo/...`，
 * 容器里是 `/workspace/...`，把宿主机绝对路径写进 `.git` 文件，容器里必然 `not a git repository`。
 *
 * 实测（把整棵树 `cp -r` 到另一个绝对路径、以及 1:1 复刻上面的容器布局）：
 * `git status` / `rev-parse` / `commit` 全部照常工作 —— 相对指针是可搬移的。
 *
 * `.fizz/` 会由 `ensureWorktreesIgnored()` 写进 `.git/info/exclude`，
 * 所以它不会污染仓库状态，也不需要用户改自己的 `.gitignore`。
 */
export const WORKTREES_DIR = '.fizz/worktrees'

/** 某个任务在某个仓库里的 worktree 绝对路径 */
export function worktreePathFor(repoPath: string, taskId: string): string {
  return join(resolve(repoPath), ...WORKTREES_DIR.split('/'), taskId)
}

/** 这个目录是不是 git 仓库（含子目录里判断：用 rev-parse 一路往上找） */
export async function isGitRepo(dir: string): Promise<boolean> {
  const result = await git(['rev-parse', '--git-dir'], { cwd: dir })
  return result.code === 0
}

/**
 * 解析仓库根目录（绝对路径）。
 *
 * 传子目录也能用 —— 这是刻意的：用户在界面上选目录时很可能选到仓库里的某个子目录，
 * 与其报错让他自己找根，不如直接解析出来、把仓库根回写给他看。
 */
export async function resolveRepoRoot(dir: string): Promise<string> {
  const stdout = await gitOrThrow(['rev-parse', '--show-toplevel'], { cwd: dir })
  const root = stdout.trim()
  if (!root) throw new Error(`解析仓库根目录失败：${dir}`)
  return root
}

/** 当前分支名；detached HEAD（或空仓库）时返回 null */
export async function currentBranch(repoPath: string): Promise<string | null> {
  const result = await git(['symbolic-ref', '--short', 'HEAD'], { cwd: repoPath })
  if (result.code !== 0) return null
  const name = result.stdout.trim()
  return name || null
}

/** 本地分支清单 */
export async function listBranches(repoPath: string): Promise<string[]> {
  const result = await git(['branch', '--format=%(refname:short)'], { cwd: repoPath })
  if (result.code !== 0) return []
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

/** 某个 ref 是否存在（用来判断基线分支名有没有写错） */
export async function refExists(repoPath: string, ref: string): Promise<boolean> {
  const result = await git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd: repoPath })
  return result.code === 0
}

/**
 * 仓库里**至少有一个提交**吗（`HEAD` 是否已经指向某个真实提交）。
 *
 * 为什么要单独一个函数：**刚 `git init` 的仓库 `currentBranch()` 照样会返回分支名**
 * （HEAD 指向 `refs/heads/master`，但那个 ref 还不存在）。这种「unborn HEAD」的仓库
 * 上 `git worktree add … <分支名>` 会失败成 `fatal: invalid reference: master` ——
 * 一句看不出所以然的英文。调用方（建任务）应该先用它判一次，给一句人话。
 */
export async function hasCommits(repoPath: string): Promise<boolean> {
  const result = await git(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], { cwd: repoPath })
  return result.code === 0
}

/**
 * 给某个任务建 worktree。
 *
 * `baseRef` 不存在时**回落到 HEAD** —— 用户填的基线分支可能已经被删了，
 * 这时候报错不如按当前 HEAD 拉一个，任务至少能跑起来（界面上会提示回落过）。
 *
 * ⚠️ worktree 的 `.git` 文件必须是**相对指针**（见 `WORKTREES_DIR` 的长注释）：它让
 * `.git` 写成相对路径，容器里换个挂载前缀才能解析得出来。默认行为会写**绝对**
 * 宿主机路径，容器里直接 `fatal: not a git repository`。
 *
 * 相对指针的实现分两档：
 * - git ≥ 2.48：`--relative-paths`（原生支持）；
 * - git < 2.48（如 Ubuntu 24.04 的 2.43）：不带 flag 建（git 会打用法帮助报
 *   unknown option），随后手动把 `.git` 文件改写成相对指针 —— 见 `relativizeGitFile`。
 */
export async function addWorktree(opts: {
  repoPath: string
  worktreePath: string
  /** 新分支名 */
  branch: string
  /** 从哪个 ref 拉；不存在则回落 HEAD */
  baseRef?: string
}): Promise<{ baseRef: string; fellBack: boolean }> {
  let baseRef = opts.baseRef?.trim() || ''
  let fellBack = false
  if (!baseRef) {
    baseRef = (await currentBranch(opts.repoPath)) ?? 'HEAD'
  } else if (!(await refExists(opts.repoPath, baseRef))) {
    // 用户填的基线分支已经不存在了（被删 / 打错字）
    baseRef = 'HEAD'
    fellBack = true
  }
  /*
   * 再统一确认一次这个 ref 真的存在 —— **两条来源都要查**。
   *
   * 上面那条 `if (!baseRef)` 分支原来漏了这一步，而它恰恰是最容易出问题的一条：
   * `currentBranch()` 走的是 `symbolic-ref --short HEAD`，**刚 `git init`、还没有任何
   * 提交的仓库照样会返回 `master` / `main`**（HEAD 指向那个 ref，只是 ref 还不存在）。
   * 拿这个名字去 `git worktree add` 就是那句没头没尾的
   * `fatal: invalid reference: master`。
   *
   * 回落到 `HEAD` 之后仍然可能是 unborn（下面 git 自己会报错），但那种情况调用方应该
   * 先用 `hasCommits()` 拦住并给一句人话（见 `apps/server/src/server/projects.ts` 的建 worktree 分支）。
   */
  if (baseRef !== 'HEAD' && !(await refExists(opts.repoPath, baseRef))) {
    baseRef = 'HEAD'
    fellBack = true
  }
  // 顺手修掉老版本留下的坑：仓库若被打上 `extensions.relativeWorktrees`，
  // 容器里的旧 git 会直接拒绝工作（见 clearRelativeWorktreesExtension 的说明）
  await clearRelativeWorktreesExtension(opts.repoPath)

  /*
   * 目标：worktree 的 `.git` 里写**相对指针**（容器里挂载前缀不同，绝对路径必然解析不到）。
   * 两条路，**优先第一条**：
   *
   * 1. 宿主 git ≥ 2.48 → `--relative-paths`，**指针由 git 自己写**，我们一个字节都不碰。
   *    它会把 `extensions.relativeWorktrees = true` 写进仓库 config，所以紧接着必须清掉 ——
   *    否则容器里更旧的 git 一读就 `fatal: unknown repository extension found:
   *    relativeworktrees`，整个仓库在容器里都不可用（见 clearRelativeWorktreesExtension）。
   *
   * 2. 宿主 git < 2.48（没有这个 flag）→ 普通方式建完，由 `relativizeGitFile` 自己改写
   *    那个文件。⚠️ 这条路在 **Windows** 上很脆：`git worktree add` 刚退出，文件句柄
   *    往往还没释放（杀毒 / 索引器也可能持有），我们去 open 它写就会拿到
   *    `EPERM: operation not permitted` —— 所以在那里还带了 stat 守卫 + 清只读属性 + 退避重试。
   *
   * 两条路写出来的**内容是一样的**（都是 `gitdir: ../../../.git/worktrees/<id>`），
   * 所以容器里的行为不会因为走哪条而不同。
   */
  const useGitRelative = await supportsRelativeWorktrees()
  await gitOrThrow(
    [
      'worktree',
      'add',
      ...(useGitRelative ? ['--relative-paths'] : []),
      '-b',
      opts.branch,
      opts.worktreePath,
      baseRef
    ],
    { cwd: opts.repoPath, config: WORKTREE_CONFIG }
  )
  if (useGitRelative) {
    // 指针已经相对了，扩展留着只会让容器里的旧 git 罢工
    await clearRelativeWorktreesExtension(opts.repoPath)
  } else {
    await relativizeGitFile(opts.worktreePath)
  }
  return { baseRef, fellBack }
}

/**
 * 清掉仓库上的 `extensions.relativeWorktrees`（如果存在）。
 *
 * 早先的实现用 `git worktree add --relative-paths` 建 worktree，那个 flag 会把
 * `extensions.relativeWorktrees = true` 写进仓库 config。**容器里的旧 git（< 2.48）
 * 一读到这个不认识的扩展就拒绝工作**：
 *
 *     fatal: unknown repository extension found: relativeworktrees
 *
 * 结果就是「任务在容器里提交不了」，而且这个仓库从此对旧 git 不可用。
 *
 * **去掉它是安全的**：那个扩展保护的场景是「`.git` 文件写了相对指针，而老 git 解析
 * 不了」—— 但相对指针本来就是 git 的标准行为（相对 `.git` 文件所在目录解析），
 * 新旧版本都认，`relativizeGitFile` 写的也正是这种。
 *
 * 幂等；没有这个 key 时 git 返回非 0，这里不作为错误。
 */
export async function clearRelativeWorktreesExtension(repoPath: string): Promise<void> {
  await git(['config', '--local', '--unset', 'extensions.relativeWorktrees'], { cwd: repoPath })
}

/**
 * 宿主 git 支不支持 `git worktree add --relative-paths`（≥ 2.48 才有）。
 * 探测一次缓存住：同进程内 git 不会变。
 */
let relativeWorktreeSupport: boolean | null = null

async function supportsRelativeWorktrees(): Promise<boolean> {
  if (relativeWorktreeSupport === null) {
    const result = await git(['worktree', 'add', '-h'])
    relativeWorktreeSupport = `${result.stdout}\n${result.stderr}`.includes('relative-paths')
  }
  return relativeWorktreeSupport
}

/**
 * 旧版 git 建出的 worktree `.git` 文件写的是**绝对**宿主机路径，容器里解析不到；
 * 这里按容器侧同样的解析规则改写成相对指针（相对「.git 文件所在目录」= worktree 根）。
 *
 * 以 git 实际写下的 gitdir 路径为基准来算相对路径，不猜 admin 目录名 ——
 * worktree 重名时 git 会加 `~N` 后缀，猜名字会写错指针。
 * admin 侧的 `gitdir` 回指文件**保持 git 默认的绝对路径**不动：容器内常规操作
 * （status / add / commit）不读它（实测 git 2.39 验证），而宿主机侧任何 git 版本对
 * 绝对路径的理解都是完美的，`worktree list` / `remove` 不踩坑。
 */
async function relativizeGitFile(worktreePath: string): Promise<void> {
  const { chmod, lstat, readFile, writeFile } = await import('node:fs/promises')
  const gitFile = join(worktreePath, '.git')

  /*
   * 只处理「linked worktree 的 `.git` 指针**文件**」。
   *
   * 这一步是 Windows 上最容易踩坑的地方：`.git` 是**目录**时（主工作区才是那样），
   * 对它 `writeFile` 会报 `EPERM: operation not permitted, open` —— 看着像权限问题，
   * 实则是「对象类型不对」，重试一万次也不会好。所以先用 `lstat` 判类型。
   */
  const info = await lstat(gitFile).catch(() => null)
  if (!info?.isFile()) return

  const content = await readFile(gitFile, 'utf8').catch(() => '')
  const current = /^gitdir:\s*(.+)$/m.exec(content)?.[1]?.trim() ?? ''
  // 已经是相对指针就别动；只把绝对路径改写成相对
  if (!current || !isAbsolute(current)) return
  const target = relative(worktreePath, current).replace(/\\/g, '/')

  /*
   * ⚠️ Windows 上这一步很容易撞 `EPERM: operation not permitted, open '<...>\.git'`。
   *
   * 它**几乎从来不是权限问题**：`git worktree add` 的子进程刚退出，而 Windows 不会
   * 立刻释放它的文件句柄（杀毒软件 / 搜索索引器 / 编辑器也可能短暂持有），于是紧接着
   * 的重写就被判成「文件被占用」。等一会儿重试就好 —— 所以这里退避重试，而不是
   * 直接把一个 EPERM 抛给用户（那个报错既看不出是哪个文件、也看不出该怎么办）。
   *
   * 注意：`git worktree add` 已经成功了，这里失败**只是**容器侧解析不了 gitdir，
   * 所以重试到底仍失败时要给出人话，而不是让调用方收到一个裸 errno。
   */
  let lastError: unknown
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      // 带只读属性时 Windows 会拒绝写入（同样是 EPERM）；先清掉属性再写，代价是一次 chmod
      await chmod(gitFile, 0o666).catch(() => undefined)
      await writeFile(gitFile, `gitdir: ${target}\n`, 'utf8')
      return
    } catch (err) {
      lastError = err
      await new Promise((resolve) => setTimeout(resolve, 80 * (attempt + 1)))
    }
  }
  const detail = lastError instanceof Error ? lastError.message : String(lastError)
  throw new Error(
    `worktree 建好了，但无法把它的 .git 改写成相对指针（重试 6 次仍失败）：${detail}。` +
      'Windows 上多半是这个文件被别的进程短暂占用（杀毒 / 索引 / 编辑器），稍后重试即可。'
  )
}

/**
 * 删 worktree。
 *
 * 先 `worktree remove --force`（会连目录一起删），失败再退一步手动删目录 + `prune` ——
 * 目录里有 agent 留下的未跟踪文件（node_modules 之类）时 remove 会拒绝，这一步是兜底。
 * **分支不删**：任务的分支是产物，删了改动就找不回来了。
 */
export async function removeWorktree(opts: {
  repoPath: string
  worktreePath: string
}): Promise<void> {
  const result = await git(['worktree', 'remove', '--force', opts.worktreePath], {
    cwd: opts.repoPath,
    config: WORKTREE_CONFIG
  })
  if (result.code !== 0) {
    const { rm } = await import('node:fs/promises')
    await rm(opts.worktreePath, { recursive: true, force: true }).catch(() => undefined)
    await git(['worktree', 'prune'], { cwd: opts.repoPath, config: WORKTREE_CONFIG })
  }
}

/** worktree 清单（`git worktree list --porcelain` 的解析） */
export async function listWorktrees(
  repoPath: string
): Promise<Array<{ path: string; branch: string | null }>> {
  const result = await git(['worktree', 'list', '--porcelain'], { cwd: repoPath })
  if (result.code !== 0) return []
  // porcelain 是「空行分隔的块」，每块形如：
  //   worktree /path
  //   HEAD <sha>
  //   branch refs/heads/x        ← detached HEAD 时这行不存在
  // 所以按块解析，不能按行流式地「看到 branch 就收一个」—— detached 的块会被吞掉。
  const out: Array<{ path: string; branch: string | null }> = []
  for (const block of result.stdout.split(/\n\s*\n/)) {
    const lines = block.split('\n').map((line) => line.trim())
    const worktreeLine = lines.find((line) => line.startsWith('worktree '))
    if (!worktreeLine) continue
    const branchLine = lines.find((line) => line.startsWith('branch '))
    out.push({
      path: worktreeLine.slice('worktree '.length).trim(),
      // refs/heads/fizz/xxx → fizz/xxx
      branch: branchLine ? branchLine.slice('branch '.length).trim().replace(/^refs\/heads\//, '') : null
    })
  }
  return out
}

/** worktree 里有没有未提交的改动（含未跟踪文件） */
export async function hasChanges(worktreePath: string): Promise<boolean> {
  const result = await git(['status', '--porcelain'], {
    cwd: worktreePath,
    config: WORKTREE_CONFIG
  })
  return result.code === 0 && result.stdout.trim().length > 0
}

/** 提交时用的身份（容器里没有全局 git 配置，必须显式给） */
export const COMMIT_IDENTITY = {
  'user.name': 'Fizz Agent',
  'user.email': 'agent@fizz.local'
}

/**
 * 把 worktree 里的全部改动提交掉。
 *
 * `git add -A` 会把**未跟踪文件**一起收进来 —— 这是有意的：agent 新建的文件
 * （新组件、新测试）才是这个任务的主要产出，漏掉它们等于白跑。
 * `.gitignore` 仍然生效，所以 node_modules / 构建产物不会被误提交。
 *
 * 没有任何改动时返回 `null`（不产生空提交）—— 这不算失败，是「agent 认为不需要改」。
 */
export async function commitAll(opts: {
  worktreePath: string
  message: string
}): Promise<{ commit: string; changedFiles: number } | null> {
  if (!(await hasChanges(opts.worktreePath))) return null
  const config = { ...WORKTREE_CONFIG, ...COMMIT_IDENTITY }
  await gitOrThrow(['add', '-A'], { cwd: opts.worktreePath, config })
  await gitOrThrow(['commit', '-m', opts.message], { cwd: opts.worktreePath, config })
  const commit = (await gitOrThrow(['rev-parse', 'HEAD'], { cwd: opts.worktreePath, config })).trim()
  // 数一下这次提交动了几个文件（相对它的父提交）；首个提交没有父提交，那就数全部
  const parents = (await git(['rev-list', '--parents', '-n', '1', 'HEAD'], {
    cwd: opts.worktreePath,
    config
  })).stdout.trim()
  const isRootCommit = parents.split(/\s+/).length <= 1
  const diffArgs = isRootCommit
    ? ['show', '--pretty=format:', '--name-only', 'HEAD']
    : ['diff', '--name-only', 'HEAD^', 'HEAD']
  const changed = (await git(diffArgs, { cwd: opts.worktreePath, config })).stdout
  const changedFiles = changed.split('\n').filter((line) => line.trim()).length
  return { commit, changedFiles }
}

/** 把本地分支推给远端（当前只在用户显式要求时用，任务流程里不自动推） */
export async function pushBranch(opts: {
  repoPath: string
  branch: string
  remote?: string
}): Promise<void> {
  await gitOrThrow(['push', '-u', opts.remote ?? 'origin', opts.branch], {
    cwd: opts.repoPath,
    config: WORKTREE_CONFIG,
    timeoutMs: 5 * 60_000
  })
}

/**
 * 仓库的 `.git` 目录绝对路径；**`.git` 是文件时抛错**。
 *
 * 为什么强制要求是目录：容器要把 `<repo>/.git` 单独挂到 `/workspace/.git`
 * （见 `WORKTREES_DIR`），而 `.git` 是文件的情况（子模块、或这个仓库自己就是个
 * worktree）意味着真正的 gitdir 在别处 —— 那种情况下 `git worktree add` 写出来的
 * 相对指针层级对不上，容器里必然坏掉。与其让任务跑到一半莫名其妙失败，
 * 不如在「添加项目」那一步就说清楚。
 */
export async function gitDirPath(repoPath: string): Promise<string> {
  const gitDir = (await gitOrThrow(['rev-parse', '--absolute-git-dir'], { cwd: repoPath })).trim()
  if (!gitDir) throw new Error(`解析 .git 目录失败：${repoPath}`)
  const expected = resolve(join(repoPath, '.git'))
  if (resolve(gitDir) !== expected) {
    throw new Error(
      `这个仓库的 .git 不在仓库根目录下（${gitDir}）。任务功能要求标准仓库布局，` +
        `子模块 / worktree 目录暂时不支持。`
    )
  }
  return gitDir
}

/**
 * 把一个忽略项写进 `.git/info/exclude`（幂等）。
 *
 * 用 `info/exclude` 而不是 `.gitignore`：前者是**纯本地**的忽略规则、不进版本库，
 * 不会在用户的仓库里留下一个「这个改动是谁加的」的文件，也不会跟他的 `.gitignore`
 * 打架。写失败不算致命（顶多是仓库状态里多一条 `?? xxx/`），所以不抛。
 *
 * `marker` 缺省是任务 worktree 的 `.fizz/`；创建 worktree 项目时传 `.worktree/`。
 */
export async function ensureWorktreesIgnored(
  repoPath: string,
  marker = '.fizz/'
): Promise<void> {
  const { appendFile, readFile } = await import('node:fs/promises')
  const excludePath = join(repoPath, '.git', 'info', 'exclude')
  try {
    const existing = await readFile(excludePath, 'utf8').catch(() => '')
    if (existing.split('\n').some((line) => line.trim() === marker)) return
    await appendFile(excludePath, `${existing.endsWith('\n') || !existing ? '' : '\n'}${marker}\n`, 'utf8')
  } catch {
    // 忽略：只是让仓库状态好看一点，失败不影响功能
  }
}
