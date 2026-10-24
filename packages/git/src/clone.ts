/**
 * git clone 导入：把远端仓库克隆到服务端指定目录 —— 「添加项目 → 从 Git 导入」用。
 *
 * 与 worktree.ts 同一条零依赖路线（只用 node 内置 + PATH 里的 git）：
 * 容器 / 独立 runner 要能单独引它，不能拖进包里其它依赖。
 */
import { mkdir, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { git, type GitLogLevel, type GitRunResult } from './worktree'

/** clone 缺省超时：大仓库走慢网也要给足（10 分钟），超时由 execFile 杀进程 */
const CLONE_TIMEOUT_MS = 10 * 60 * 1000

/**
 * 克隆**被用户取消**（不是失败）。
 *
 * 单独立一个类型是为了让调用方能把「取消」和「克隆失败」分开：取消是用户主动的正常操作，
 * 不该被当成错误弹红条，也不该把 git 的 `signal: killed` 原样甩给用户。
 */
export class CloneCanceledError extends Error {
  constructor(message = '克隆已取消') {
    super(message)
    this.name = 'CloneCanceledError'
  }
}

/** `err` 是不是「被取消」（跨 bundle 时 `instanceof` 不可靠，兜一个 name 判定） */
export function isCloneCanceled(err: unknown): boolean {
  return err instanceof CloneCanceledError
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
 * 仓库地址的基本合法性：非空、不以 `-` 开头（git 会把以 `-` 开头的参数当选项解析，
 * `git clone -- url` 之外再多一道显式拒绝）、不含换行（spawn 数组形式虽不吃换行注入，
 * 但换行一定不是合法地址）。ssh / https / git:// / 本地路径都放行。
 */
export function assertSafeRepoUrl(url: string): void {
  const trimmed = url.trim()
  if (!trimmed) throw new Error('仓库地址不能为空')
  if (trimmed.startsWith('-')) throw new Error('仓库地址不能以「-」开头')
  if (/[\r\n]/.test(trimmed)) throw new Error('仓库地址不能包含换行')
}

/**
 * 清掉克隆了一半的目录。
 *
 * **只在取消路径调用**：进克隆前调用方已确认目标目录不存在，所以整棵删掉是安全的；
 * 不清的话盘上会留一份残骸，用户「再点一次克隆」直接撞「目标目录已存在」。
 *
 * Windows 上刚被 `taskkill` 的文件句柄可能还没释放，靠 `rm` 的退避重试兜；
 * 真删不掉也只是留个脏目录，**不把清理失败的错糊到取消流程上**。
 */
async function discardPartial(destDir: string): Promise<void> {
  await rm(destDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(
    () => undefined
  )
}

/**
 * 把地址里的凭据抹掉再展示（日志 / 任务标题会进界面，不该把 token 一起显示）。
 *
 * 只处理 `scheme://user:token@host` 这一段：`git@host:owner/repo` 里的 `git` 是用户名、
 * 不是秘密，动它反而让地址看不懂。
 */
export function maskRepoUrl(url: string): string {
  return url.replace(/(\/\/)[^/@\s]+@/, '$1***@')
}

/**
 * 克隆远端仓库到 `destDir`（完整目标路径）。**不抛异常**，结果形状与 `git()` 一致。
 *
 * 唯一的例外是**用户取消**：传了 `signal` 且被 abort 时抛 `CloneCanceledError`
 * （此时 git 已被整树杀掉、半份目录已清掉），调用方据此回「已取消」而不是报故障。
 *
 * `--progress`：非 TTY 下 git 默认**不输出进度**，加上它才会把 `Receiving objects: 45%`
 * 这类行吐到 stderr —— 后台任务列表里的实时进度就是靠这个。
 */
export async function cloneRepo(input: {
  url: string
  destDir: string
  /** 取消信号：abort 时杀 git 并清掉半份目录 */
  signal?: AbortSignal
  /** 逐行日志（git 的进度 / 报错原文）；给了就一路转发出去当任务日志 */
  onLog?: (line: string, level: GitLogLevel) => void
}): Promise<GitRunResult> {
  assertSafeRepoUrl(input.url)
  // 目标父目录不存在就建（用户在弹窗里手输深层路径时不用先去文件管理器里一层层建）
  await mkdir(dirname(input.destDir), { recursive: true })
  if (input.signal?.aborted) throw new CloneCanceledError()
  // `--` 截断选项解析：地址即使用户拼出了 `-xxx` 开头的串也只当 URL 看（双保险）
  const result = await git(['clone', '--progress', '--', input.url.trim(), input.destDir], {
    timeoutMs: CLONE_TIMEOUT_MS,
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.onLog ? { onLine: input.onLog } : {})
  })
  // 取消的收尾：git 可能刚被砍在半路、也可能恰好已经跑完 —— 两种都按「用户要放弃」处理，
  // 目录一律清掉（否则重试撞 409），再以 CloneCanceledError 结束
  if (input.signal?.aborted) {
    input.onLog?.('已终止 git，正在清理已下载的内容…', 'warn')
    await discardPartial(input.destDir)
    input.onLog?.('清理完成，可以重新克隆', 'info')
    throw new CloneCanceledError()
  }
  return result
}
