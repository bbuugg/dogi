/**
 * 系统监控 + 任务管理器：进程表的「取数」与「结束进程」。
 *
 * ## 与 `services/system-monitor.ts` 的分工（**两条独立通路，互不影响**）
 *
 * | | 状态栏那颗监控徽标 | 这个任务管理器 |
 * |---|---|---|
 * | 端点 | `GET /api/system` | `GET /api/system/tasks` |
 * | 采集 | 常驻采样器，`node:os`，零子进程，每 2s | 按请求现采，`ps` / `tasklist` |
 * | 生命周期 | 只要「系统监控」开关开着就一直跑 | 只在任务管理器标签打开时有请求，关掉即停 |
 * | 内容 | CPU 每核 / 内存 / 磁盘 / fizz 自身进程 | 每个进程的 CPU / 内存 / 命令行，可结束 |
 *
 * 这就是「**独立于目前的系统监控条**」这句需求的具体落法：两条通路各采各的，关掉其中
 * 一条不会让另一条变空。面板会**同时**读这两个端点（指标卡用 `/api/system`，进程表用
 * 这里），因为它们本来就只是「同一台机器的两个视角」。
 *
 * ## CPU 占用是算出来的
 *
 * 采集层只给**累计** CPU 时间（`ps` 的 `time` / `tasklist` 的 `CPU Time`），瞬时占用 =
 * 两次采集的累计之差 ÷ 墙上时间。由此带来三条必须处理的现实：
 *
 * 1. **首次没有基准**：第一帧全填 0 会让人以为读坏了，所以首次先采一帧当基准、隔
 *    `PRIME_GAP_MS` 再采一帧，用这 250ms 的增量给出一个像样的初值；
 * 2. **断档太久不能直接除**：用户关掉标签半小时后再打开，上一帧的 `at` 已经很久远，
 *    直接除会把「半小时的平均」冒充成「刚才那一瞬间」—— 所以超过 `MAX_BASE_AGE_MS`
 *    就重新立基准（同样走上面那条补采路径）；
 * 3. **pid 会被复用**：旧 pid 若换了进程，累计时间差会是负数或大得离谱。同 pid 但
 *    **名字不同**一律当作新进程（占用 0），负差值直接丢弃。
 *
 * ## 状态挂 globalThis
 *
 * 与 `services/system-monitor.ts` 同一个理由：`listSystemTasks` 由路由模块加载，
 * 层级 / 打包后的加载路径未必只有一份，模块级 `let` 会分裂成好几份基准（每份都以为
 * 自己是第一次采，于是每帧都补采两次）。
 */
import {
  availableParallelism,
  cpus,
  totalmem
} from 'node:os'
import type {
  SystemTaskKillInput,
  SystemTaskKillResult,
  SystemTaskList,
  SystemTaskNet,
  SystemTaskProcess,
  SystemTaskState
} from '@fizz/contracts/agent-api'
import { collectPosix } from './collect-posix'
import { collectWindows } from './collect-win32'
import type { RawProcess, RawSnapshot } from './raw'
import { messageOf, runCapture } from './raw'

/** 清单上限：超过就只回前面的（按 CPU 降序），避免一次吐几万条把前端拖死 */
const MAX_PROCESSES = 2_000
/** 极短缓存：两个标签同时轮询 / 连点刷新时别连开两次子进程 */
const CACHE_MS = 700
/** 基准超过这个岁数就作废（见文件头第 2 条） */
const MAX_BASE_AGE_MS = 5_000
/**
 * 首次（或重新立基准）时补采的间隔。
 *
 * 不能太短：瞬时占用是「累计时间差 ÷ 间隔」，而各平台累计时间的**量化粒度**不同 ——
 * Linux 经 `/proc` 是 10ms、Windows 的 CIM 值是 15.6ms 的系统滴答。间隔只有 250ms 时，
 * Windows 上一粒滴答就是 6% 的误差，第一帧会跳出一堆假的高占用。400ms 下这个量化误差
 * 降到 4% 且不再出现「同一个值重复很多行」的假象。
 */
const PRIME_GAP_MS = 400

interface TaskState {
  /** 上一次**成功**的采集：算 delta 的基准，也是「进程树」的依据 */
  prev: RawSnapshot | null
  /** 单飞：同一时刻只允许一个采集在跑 */
  inflight: Promise<SystemTaskList> | null
  /** 极短缓存（连点 / 多客户端同时来） */
  last: { at: number; result: SystemTaskList } | null
}

const GLOBAL_KEY = '__FIZZ_SYSTEM_TASKS__'

function getState(): TaskState {
  const global = globalThis as Record<string, unknown>
  let state = global[GLOBAL_KEY] as TaskState | undefined
  if (!state) {
    state = { prev: null, inflight: null, last: null }
    global[GLOBAL_KEY] = state
  }
  return state
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 取一帧原始数据（按平台分派） */
function readRaw(): Promise<RawSnapshot> {
  return process.platform === 'win32' ? collectWindows() : collectPosix()
}

// ---------------------------------------------------------------------------
// 取数
// ---------------------------------------------------------------------------

/**
 * 读一份进程表（带内存 / CPU 占用）。
 *
 * 并发安全：同一时刻只有一个采集在跑，其余调用直接复用它的 promise。
 */
export function listSystemTasks(): Promise<SystemTaskList> {
  const state = getState()
  if (state.last && Date.now() - state.last.at < CACHE_MS) {
    return Promise.resolve(state.last.result)
  }
  if (state.inflight) return state.inflight
  state.inflight = collect(state).finally(() => {
    state.inflight = null
  })
  return state.inflight
}

async function collect(state: TaskState): Promise<SystemTaskList> {
  const memTotal = totalmem()
  const cores = cpus().length || availableParallelism()

  let current = await readRaw()
  let base = state.prev
  const age = base ? current.at - base.at : Number.POSITIVE_INFINITY

  // 没有基准 / 断档太久 / 两次挨得太近：先立基准，再补采一帧（见文件头第 1、2 条）
  if (!base || age > MAX_BASE_AGE_MS || age < 50) {
    await sleep(PRIME_GAP_MS)
    base = current
    current = await readRaw()
  }

  const result = build(current, base, memTotal, cores)
  state.prev = current
  state.last = { at: Date.now(), result }
  return result
}

/** 把两帧原始数据合成一份契约里的 `SystemTaskList` */
function build(
  current: RawSnapshot,
  base: RawSnapshot | null,
  memTotal: number,
  cores: number
): SystemTaskList {
  const windowMs = base ? Math.max(0, current.at - base.at) : 0
  const seconds = windowMs / 1000
  const before = new Map<number, RawProcess>()
  if (base) for (const proc of base.procs) before.set(proc.pid, proc)

  const processes: SystemTaskProcess[] = current.procs.map((proc) => {
    const rss = proc.rssKb * 1024
    let cpuPercent = 0
    if (seconds > 0) {
      const previous = before.get(proc.pid)
      // pid 复用时（同名判断）差值无意义，按新进程处理（见文件头第 3 条）
      if (previous && previous.name === proc.name) {
        const delta = proc.cpuSeconds - previous.cpuSeconds
        if (delta > 0) cpuPercent = Math.round((delta / seconds) * 1000) / 10
      }
    }
    return {
      pid: proc.pid,
      ppid: proc.ppid,
      name: proc.name,
      cmdline: proc.cmdline,
      user: proc.user,
      // 上限是「核数 × 100」：跑满所有核的进程就是 cores×100%，再高只可能是采样毛刺
      cpuPercent: Math.min(cpuPercent, cores * 100),
      rss,
      memPercent: memTotal > 0 ? Math.round((rss / memTotal) * 1000) / 10 : 0,
      cpuSeconds: Math.round(proc.cpuSeconds),
      state: stateOf(proc.rawState),
      rawState: proc.rawState,
      self: proc.pid === process.pid
    }
  })

  processes.sort(
    (a, b) => b.cpuPercent - a.cpuPercent || b.memPercent - a.memPercent || a.pid - b.pid
  )

  const truncated = processes.length > MAX_PROCESSES
  const note = NOTE_BY_SOURCE[current.source]

  return {
    at: current.at,
    source: current.source,
    windowMs,
    memTotal,
    cores,
    total: processes.length,
    truncated,
    processes: truncated ? processes.slice(0, MAX_PROCESSES) : processes,
    net: netOf(current.net, base?.net, seconds),
    ...(note ? { note } : {})
  }
}

/** 采集后端的能力说明（只在有平台限制时给） */
const NOTE_BY_SOURCE: Record<string, string | undefined> = {
  // Win32_Process 没有「运行用户」属性，逐进程 GetOwner() 比整个采集还慢；ExecutionState 也不可信
  cim: 'Windows：读不到「运行用户」与「进程状态」，其余字段（含命令行 / 父进程 / 累计 CPU）都是实采',
  // PowerShell 都起不来时的兜底通路（极少数精简镜像）
  tasklist: '降级模式：PowerShell 不可用，只有名称 / PID / 内存 —— 没有 CPU 时间，也没法算进程树'
}

function netOf(
  current: RawSnapshot['net'],
  previous: RawSnapshot['net'] | null | undefined,
  seconds: number
): SystemTaskNet | null {
  if (!current) return null
  const deltaRx = previous ? Math.max(0, current.rx - previous.rx) : 0
  const deltaTx = previous ? Math.max(0, current.tx - previous.tx) : 0
  return {
    rxPerSec: seconds > 0 ? Math.round(deltaRx / seconds) : 0,
    txPerSec: seconds > 0 ? Math.round(deltaTx / seconds) : 0,
    rxTotal: current.rx,
    txTotal: current.tx
  }
}

/**
 * 原始状态码 → 归一档。
 *
 * 两个平台的码完全不同，但**首字母**这条规则对 POSIX 够用（`R` / `S` / `D` / `T` / `Z`），
 * Windows 那边是整词的英文（`Running` / `Not Responding` / `Unknown`），中文 Windows 会
 * 本地化（`正在运行` / `未知`）—— 所以两套都认，且 Windows 的词先判（否则 `Not Responding`
 * 会被首字母 `N` 判成 unknown，其实它是**在跑但没响应**）。
 */
export function stateOf(raw: string): SystemTaskState {
  const text = raw.trim()
  if (!text) return 'unknown'

  const lower = text.toLowerCase()
  if (lower === 'running' || text === '正在运行') return 'running'
  // 「未响应」的进程仍然在（只是不处理消息），当 running 处理，原始码放悬停提示
  if (lower === 'not responding' || text === '未响应') return 'running'
  if (lower === 'suspended' || text === '已挂起' || text === '暫止') return 'stopped'
  if (lower === 'unknown' || text === '未知' || lower === 'n/a') return 'unknown'

  const first = text[0]!.toUpperCase()
  if (first === 'R') return 'running'
  if (first === 'S' || first === 'D' || first === 'I') return 'sleeping'
  if (first === 'T') return 'stopped'
  if (first === 'Z') return 'zombie'
  return 'unknown'
}

// ---------------------------------------------------------------------------
// 结束进程
// ---------------------------------------------------------------------------

/**
 * 结束一个进程。
 *
 * **业务失败也返回正常结果**（`ok: false` + 人能读懂的一句话），不抛异常：路由层面
 * 「进程已经自己退出了」和「参数不合法」是两类事，前者不该变成一个 4xx 让前端多写一层。
 */
export async function killSystemTask(input: SystemTaskKillInput): Promise<SystemTaskKillResult> {
  const pid = Math.trunc(Number(input?.pid))
  if (!Number.isFinite(pid) || pid <= 0) {
    return { pid: 0, ok: false, killed: [], error: 'pid 必须是正整数' }
  }

  const reason = protectedReason(pid)
  if (reason) return { pid, ok: false, killed: [], error: reason }

  const mode = input.mode === 'kill' ? 'kill' : 'term'
  const tree = input.tree === true
  return process.platform === 'win32' ? killWindows(pid, mode, tree) : killPosix(pid, mode, tree)
}

/**
 * 不允许从界面结束的进程。
 *
 * 只挡三类**一定会把人坑到**的：fizz 自己（界面立刻失联）、POSIX 的 pid 1（整机）、
 * Windows 的 0 / 4（系统空闲进程与 System）。其余一律放行 —— 权限不足由系统自己拒绝，
 * 那是操作者的选择，不该由我们代判。
 */
function protectedReason(pid: number): string | null {
  if (pid === process.pid) {
    return '这是承载界面的 fizz 进程本身，结束它会让界面立刻失联（要停服务请在命令行里操作）'
  }
  if (process.platform === 'win32') {
    if (pid === 0 || pid === 4) return '这是 Windows 的系统进程（System / System Idle），不能结束'
    return null
  }
  if (pid === 1) return '这是 init / launchd（pid 1），结束它会把整台机器带下去'
  return null
}

function killPosix(
  pid: number,
  mode: 'term' | 'kill',
  tree: boolean
): SystemTaskKillResult {
  const signal: NodeJS.Signals = mode === 'kill' ? 'SIGKILL' : 'SIGTERM'
  const targets = tree ? descendantsFirst(pid) : [pid]
  const killed: number[] = []
  const failures: string[] = []

  for (const target of targets) {
    try {
      process.kill(target, signal)
      killed.push(target)
    } catch (err) {
      // ESRCH = 已经没有这个进程：树里常有「刚退出的子进程」，这不是失败
      if ((err as NodeJS.ErrnoException).code !== 'ESRCH') {
        failures.push(`${target}: ${messageOf(err)}`)
      }
    }
  }

  const ok = killed.includes(pid)
  if (ok && failures.length === 0) return { pid, ok, killed }
  return {
    pid,
    ok,
    killed,
    ...(failures.length
      ? { error: `${ok ? '部分子进程未能结束：' : '结束失败：'}${failures.slice(0, 3).join('；')}` }
      : {})
  }
}

/**
 * 收集一棵子树，**子进程排在父进程前面**（后序遍历）。
 *
 * 顺序有实际意义：先杀父进程的话，它可能在退出前把子进程重新拉起来（守护 / 重启逻辑），
 * 结果就是「点了结束，几秒后又冒出来」。
 *
 * 依据是**上一次采集**的 `ppid` 关系 —— 没有那份数据（刚打开面板就点、或是 Windows 上
 * 压根没有 ppid）就退化成「只结束它自己」。这也是 Windows 走 `taskkill /T` 的原因：
 * 那边的树必须由系统来展开。
 */
function descendantsFirst(pid: number): number[] {
  const procs = getState().prev?.procs
  if (!procs || procs.length === 0) return [pid]

  const children = new Map<number, number[]>()
  for (const proc of procs) {
    const list = children.get(proc.ppid)
    if (list) list.push(proc.pid)
    else children.set(proc.ppid, [proc.pid])
  }

  const order: number[] = []
  const seen = new Set<number>()
  const walk = (current: number): void => {
    if (seen.has(current)) return
    seen.add(current)
    for (const child of children.get(current) ?? []) walk(child)
    order.push(current)
  }
  walk(pid)
  return order
}

/**
 * Windows 上的结束：整件事交给 `taskkill`。
 *
 * - `mode: 'term'` → 不带 `/F`：系统会尝试发 `WM_CLOSE` 给有窗口的程序；
 * - `mode: 'kill'` → 带 `/F`：直接 TerminateProcess；
 * - `tree: true` → 带 `/T`：由系统展开整棵子树（我们这边没有 ppid，展不了）。
 *
 * ⚠️ 控制台程序（node / java / 各种后台服务）通常不理软请求，`taskkill` 会明确回
 * 「只能强制结束」。这句英文/本地化文案会原样透给界面 —— 比我们编一句「失败了」有用。
 */
async function killWindows(
  pid: number,
  mode: 'term' | 'kill',
  tree: boolean
): Promise<SystemTaskKillResult> {
  const args = ['/PID', String(pid)]
  if (tree) args.push('/T')
  if (mode === 'kill') args.push('/F')

  const result = await runCapture('taskkill', args, 10_000)
  if (result.code === 0) {
    // taskkill 不回报展开了哪些子进程，只能报主 pid
    return { pid, ok: true, killed: [pid] }
  }
  const detail =
    (result.stderr || result.stdout)
      .trim()
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .pop() ?? ''
  return {
    pid,
    ok: false,
    killed: [],
    error: detail || `taskkill 退出码 ${result.code}（可能需要管理员权限，或该进程受系统保护）`
  }
}
