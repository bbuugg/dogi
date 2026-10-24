/**
 * 服务器性能监控：一个常驻采样器 + 一个取数入口，**只用 Node 内置 API** 采集。
 *
 * ## 为什么不用 systeminformation（本文件的历史教训）
 *
 * 这里以前依赖 `systeminformation`：它的 `currentLoad()` 要 spawn PowerShell / 读一堆
 * 外部命令，`processes()` 在 Linux 上就是 `ps`，`networkStats()` 每次都要起子进程，
 * 在桌面端主进程里还会同步 `execSync` 冻住事件循环。对「状态栏扫一眼 CPU / 内存」这件事
 * 来说完全不划算 —— 一个常驻监控不该比它监控的程序还忙。现在全部改用 `node:os`：
 * 纯内存读取、零子进程、跨 Windows / Linux 同一套代码。
 *
 * ## 哪些指标保留、哪些砍掉
 *
 * - **CPU 占用 / 每核**：`os.cpus()` 的累计时间片，自己算两次采样的 delta（Node 不直接给
 *   占用率）。型号 / 核数 / 主频也从同一处拿，静态采一次。
 * - **内存**：`os.totalmem()` / `os.freemem()`。
 * - **磁盘**：Node 18.15+ 的 `fs.statfs`（Linux 读 `/`，Windows 枚举盘符），仅在 `detail`
 *   时采，便宜且无子进程。
 * - **fizz 自身进程**：`process.memoryUsage()`，白送。
 * - **砍掉**：网络速率（Node 没有跨平台的字节计数 API、Linux 之外的实现都要子进程）、
 *   Top 进程（要 `ps`，明确不要）、CPU 温度（要 `systeminformation` / 特权）、swap
 *   （Node 不暴露，Windows 只能起子进程）。这些字段已从 `SystemSnapshot` 契约里删除。
 *
 * ## 为什么是「采样器 + 快照」而不是「每次请求现采」
 *
 * CPU 占用是**两次采样的时间差**算出来的，必须有个稳定节奏的基准点。如果 `/api/system`
 * 每次请求都自己采一次，节奏抖动会让占用值忽高忽低。所以约定：**采样器按固定 ~2s 采，
 * 路由只是来取快照**。
 *
 * ## 挂 globalThis 的原因
 *
 * 采样器由 `background.ts`（可能跑在打包后的 server 进程）启动，`stopSystemMonitor()` 却是从
 * `shutdown.ts`（另一处模块加载路径）调的 —— 两边模块缓存不互通（同 `state.ts`）。
 * 只有把定时器引用也放进 `globalThis`，stop 才清得掉启动处创建的那个定时器。
 */
import {
  arch as osArch,
  availableParallelism,
  cpus as osCpus,
  freemem,
  hostname as osHostname,
  platform as osPlatform,
  release as osRelease,
  totalmem
} from 'node:os'
import { statfs } from 'node:fs/promises'
import type {
  SystemDiskUsage,
  SystemMetrics,
  SystemNodeProcess,
  SystemOsInfo,
  SystemSample,
  SystemSnapshot
} from '@fizz/contracts/agent-api'
// 采样器的启停跟随持久化偏好（见下方 startSystemMonitor / syncSystemMonitorEnabled）
import { domain } from '../state'

/** 采样间隔（毫秒）。2s 是「曲线够顺 + 读取开销可忽略」的折中 */
const SAMPLE_INTERVAL_MS = 2_000
/** 环形缓冲长度：180 × 2s ≈ 6 分钟的趋势 */
const HISTORY_LEN = 180
/** 磁盘分区的最大展示数 */
const MAX_DISKS = 16

// ---------------------------------------------------------------------------
// 内部状态：整体挂 globalThis（跨加载器单例，见文件头）
// ---------------------------------------------------------------------------

/** 一次 `os.cpus()` 的快照里我们关心的两个累计量（用来算两次采样的 delta） */
interface CoreTimes {
  idle: number
  total: number
}

/** 每一次「常采」得到的易变小节（CPU / 内存的当前值） */
interface LiveValues {
  at: number
  cpuLoad: number
  cpuLoadPerCore: number[]
  memTotal: number
  memUsed: number
  memAvailable: number
  memUsedPercent: number
}

/** 静态信息（启动采一次，之后不变） */
interface StaticInfo {
  os: SystemOsInfo
  cpuBrand: string
  cpuCores: number
  cpuSpeedGHz: number | null
}

interface MonitorState {
  /** 采样定时器（递归 setTimeout；挂这里的引用才能被别处 stop 掉） */
  timer: NodeJS.Timeout | null
  started: boolean
  intervalMs: number
  staticInfo: StaticInfo | null
  /** 最近一次常采；初值给一份全零，保证首个 GET 之前也不为 null */
  live: LiveValues
  history: SystemSample[]
  /** 上一帧的每核累计时间；null = 还没采过（第一帧占用记 0，没有基准） */
  cpuPrev: CoreTimes[] | null
}

const GLOBAL_KEY = '__FIZZ_SYSTEM_MONITOR__'

function zeroLive(): LiveValues {
  return {
    at: 0,
    cpuLoad: 0,
    cpuLoadPerCore: [],
    memTotal: 0,
    memUsed: 0,
    memAvailable: 0,
    memUsedPercent: 0
  }
}

function getState(): MonitorState {
  const g = globalThis as Record<string, unknown>
  let s = g[GLOBAL_KEY] as MonitorState | undefined
  if (!s) {
    s = {
      timer: null,
      started: false,
      intervalMs: SAMPLE_INTERVAL_MS,
      staticInfo: null,
      live: zeroLive(),
      history: [],
      cpuPrev: null
    }
    g[GLOBAL_KEY] = s
  }
  return s
}

/** 静态信息缺省值：连 `os.cpus()` 都失败时的地板 */
function fallbackStatic(): StaticInfo {
  return {
    os: {
      platform: process.platform,
      distro: '',
      release: '',
      arch: process.arch,
      hostname: safeHostname()
    },
    cpuBrand: 'CPU',
    cpuCores: availableParallelism(),
    cpuSpeedGHz: null
  }
}

function safeHostname(): string {
  try {
    return osHostname()
  } catch {
    return ''
  }
}

function clampPercent(v: number | null | undefined): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 0
  return Math.max(0, Math.min(100, v))
}

/** 把 `os.cpus()` 收成每核的 `{ idle, total }` 累计量（delta 用） */
function readCoreTimes(): { times: CoreTimes[]; brand: string; speedGHz: number | null } {
  const list = osCpus()
  const times: CoreTimes[] = list.map((c) => {
    const t = c.times
    return {
      idle: t.idle,
      total: t.user + t.nice + t.sys + t.idle + t.irq
    }
  })
  const first = list[0]
  const speed = first && typeof first.speed === 'number' && first.speed > 0 ? first.speed / 1000 : null
  return { times, brand: first?.model || 'CPU', speedGHz: speed }
}

// ---------------------------------------------------------------------------
// 启动 / 停止 / 采样
// ---------------------------------------------------------------------------

/**
 * 启动采样器（幂等）：先采静态信息 + 第一帧数据，再递归排后续定时器。
 *
 * 由 `background.ts` 的 `startBackgroundServices()` 调（「服务开着就该跑」—— 没人打开
 * 监控页也在采）；路由取数时若发现没启动（极端情况：路由先于后台启动到达）也会兜底调一次。
 *
 * ⚠️ **偏好的总闸门在这里**：`systemMonitorSettings.enabled === false` 时**直接不启动** ——
 * 用户关掉监控的语义就是「后台不统计数据」，所以光在前端藏徽标不够，必须连采样一起停。
 * 想「关掉后再打开也能生效」则走下面的 `syncSystemMonitorEnabled()`。
 */
export function startSystemMonitor(): void {
  const s = getState()
  if (s.started) return
  if (!domain.getSystemMonitorSettings().enabled) return
  s.started = true
  collectStatic(s)
  tick(s)
  schedule(s)
}

/** 停止采样（幂等）：清掉定时器，后续不再采。由 `shutdown.ts` 收尾时调 */
export function stopSystemMonitor(): void {
  const s = getState()
  s.started = false
  if (s.timer) {
    clearTimeout(s.timer)
    s.timer = null
  }
}

/**
 * 让采样器跟随**最新的持久化偏好**启停（保存设置后调用）。
 *
 * 关闭时停掉定时器、连历史一起留在内存里不再推进（下次打开会重新采），
 * 打开时走 `startSystemMonitor()` 重新起采样 —— 两条都幂等，重复调用安全。
 */
export function syncSystemMonitorEnabled(): void {
  if (domain.getSystemMonitorSettings().enabled) startSystemMonitor()
  else stopSystemMonitor()
}

/** 递归 setTimeout：等上一帧真的采完才排下一帧 —— 避免某帧变慢时并发 */
function schedule(s: MonitorState): void {
  const timer = setTimeout(() => {
    tick(s)
    // 采这段时间里被 stop 了就不再续排
    if (s.started) schedule(s)
    else s.timer = null
  }, s.intervalMs)
  // 别让这个定时器把进程钉住（CLI / 测试里跑完就该能退出）
  timer.unref?.()
  s.timer = timer
}

function collectStatic(s: MonitorState): void {
  try {
    const { brand, speedGHz } = readCoreTimes()
    s.staticInfo = {
      os: {
        platform: osPlatform(),
        distro: '',
        release: osRelease(),
        arch: osArch(),
        hostname: safeHostname()
      },
      cpuBrand: brand,
      cpuCores: osCpus().length || availableParallelism(),
      cpuSpeedGHz: speedGHz
    }
  } catch (err) {
    console.error('[system-monitor] 读取静态信息失败（用缺省值续跑）：', err)
    s.staticInfo = fallbackStatic()
  }
}

/** 采一帧：CPU 占用（两次采样 delta）+ 内存，写进 live 并推一条历史点 */
function tick(s: MonitorState): void {
  const now = Date.now()
  try {
    const { times } = readCoreTimes()
    const prev = s.cpuPrev
    let cpuLoadPerCore: number[] = []
    if (prev && prev.length === times.length) {
      let busySum = 0
      let totalSum = 0
      cpuLoadPerCore = times.map((cur, i) => {
        const p = prev[i]!
        const totalDelta = cur.total - p.total
        const idleDelta = cur.idle - p.idle
        if (totalDelta <= 0) return 0
        const busy = Math.max(0, totalDelta - idleDelta)
        busySum += busy
        totalSum += totalDelta
        return clampPercent((busy / totalDelta) * 100)
      })
      s.live = { ...s.live, at: now, cpuLoad: totalSum > 0 ? clampPercent((busySum / totalSum) * 100) : 0, cpuLoadPerCore }
    } else {
      // 第一帧（或核数变了）：没有基准，占用记 0，先把基准立起来
      s.live = { ...s.live, at: now, cpuLoad: 0, cpuLoadPerCore: [] }
    }
    s.cpuPrev = times

    const memTotal = totalmem()
    const memAvailable = Math.max(0, freemem())
    const memUsed = Math.max(0, memTotal - memAvailable)
    s.live = {
      ...s.live,
      memTotal,
      memUsed,
      memAvailable,
      memUsedPercent: memTotal ? (memUsed / memTotal) * 100 : 0
    }

    s.history.push({ at: now, cpuLoad: s.live.cpuLoad, memUsedPercent: s.live.memUsedPercent })
    if (s.history.length > HISTORY_LEN) {
      s.history.splice(0, s.history.length - HISTORY_LEN)
    }
  } catch (err) {
    // 一帧失败不该打断采样：保留上一帧的 live，下帧再来
    console.error('[system-monitor] 采样失败（沿用上一帧）：', err)
  }
}

// ---------------------------------------------------------------------------
// 取数（供 /api/system 用）
// ---------------------------------------------------------------------------

/**
 * 取一份性能指标：当前快照 + 近期历史。
 *
 * `detail = true` 时额外现采磁盘（`fs.statfs`，便宜），合进返回的快照。
 * 未启动会兜底拉起再取 —— background 正常情况下已经启动，这里是双保险。
 */
export async function getSystemMetrics(detail: boolean): Promise<SystemMetrics> {
  const s = getState()
  if (!s.started) startSystemMonitor()
  const snapshot = buildSnapshot(s)
  if (detail) await attachDetail(snapshot)
  return {
    snapshot,
    history: s.history.map((x) => ({ ...x })),
    sampleIntervalMs: s.intervalMs
  }
}

/** 用 live + staticInfo 组一份**全新的**快照对象（拷贝数组，别把内部引用交出去） */
function buildSnapshot(s: MonitorState): SystemSnapshot {
  const staticInfo = s.staticInfo ?? fallbackStatic()
  const live = s.live
  return {
    at: live.at,
    cpuLoad: live.cpuLoad,
    cpuLoadPerCore: live.cpuLoadPerCore.slice(),
    cpuSpeedGHz: staticInfo.cpuSpeedGHz,
    cpuCores: staticInfo.cpuCores,
    cpuBrand: staticInfo.cpuBrand,
    memTotal: live.memTotal,
    memUsed: live.memUsed,
    memAvailable: live.memAvailable,
    memUsedPercent: live.memUsedPercent,
    disks: [],
    os: staticInfo.os,
    process: nodeProcessInfo()
  }
}

/** 现采磁盘占用（`fs.statfs`，零子进程），读不到就留空数组 */
async function attachDetail(snapshot: SystemSnapshot): Promise<void> {
  snapshot.disks = await readDisks()
}

/**
 * 磁盘占用：`fs.statfs` 只给单个挂载点，所以这里挑「能代表这台机器」的几个根。
 *
 * - Windows：枚举 `C:`–`Z:`，存在且 statfs 得出来的就是盘符；
 * - 其它平台：读 `/`（大多数部署只关心根分区）。
 *
 * `fsType` 一律留空 —— `statfs` 给的是数字 magic，映射成 `ext4` / `ntfs` 要维护一张表，
 * 不值得（这个字段前端只是小字副标题）。
 */
async function readDisks(): Promise<SystemDiskUsage[]> {
  const targets =
    process.platform === 'win32'
      ? 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((letter) => `${letter}:\\`)
      : ['/']
  const out: SystemDiskUsage[] = []
  for (const target of targets) {
    try {
      const st = await statfs(target)
      const size = st.blocks * st.bsize
      if (!size) continue
      const avail = st.bavail * st.bsize
      const used = Math.max(0, size - avail)
      out.push({
        mount: process.platform === 'win32' ? target.slice(0, 2) : target,
        fsType: '',
        size,
        used,
        usedPercent: size ? (used / size) * 100 : 0
      })
    } catch {
      // 盘符不存在 / 权限不足：跳过这个挂载点
    }
    if (out.length >= MAX_DISKS) break
  }
  return out
}

/** fizz 这个 Node 进程自身占用（随时现算，极廉价） */
function nodeProcessInfo(): SystemNodeProcess {
  const mu = process.memoryUsage()
  return {
    nodeVersion: process.version,
    rss: mu.rss,
    heapUsed: mu.heapUsed,
    heapTotal: mu.heapTotal,
    uptimeSeconds: Math.floor(process.uptime())
  }
}
