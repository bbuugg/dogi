/**
 * 远端（SSH）主机的性能指标：**一条 exec 命令 + 一套纯函数解析**。
 *
 * ## 为什么单开一个纯模块（不直接写进 `monitor.ts`）
 *
 * 这里全是「给一段 `/proc` 文本 → 一份 `HostMetricsSnapshot`」的纯计算，一行网络 /
 * 定时器都没有。拆出来有两个实打实的好处：
 * - 验证脚本能**直接 jiti 加载它**喂真实 `/proc` 样本（`scripts/verify-host-monitor.mjs`），
 *   不必起 SSH、也不必把 `ssh2` 拖进验证进程 —— `monitor.ts` 里那些连接编排没法这么测；
 * - 阈值（无效帧上限 / 空闲回收 / 间隔夹取）与解析规则放在一处，读的人不用在
 *   连接代码里翻找「到底几次才算不支持」。
 *
 * ## 只支持 Linux（这是刻意的）
 *
 * 采集全部依赖 `/proc` 与 `df`，非 Linux 目标读出来是「一片 0」—— 那是**伪数据**，
 * 比不显示更糟（用户会以为这台机器 CPU 0%、内存 0%）。所以 `isSupported()` 会把这类
 * 结果判为无效，连续几轮后上报 `unavailable`（见 `monitor.ts`），前端改成静态提示。
 * 本机那份监控走 Node 内置 API（`node:os`，跨平台），远端这份不追求跨平台 —— 参考实现
 * （上级目录 dogi 的 `terminal/monitor.ts`）也是这个取舍。
 *
 * ## 与本机那份的差异（除了数据来源）
 *
 * - **多算了 load average 与 swap**：都在同一条命令的同一段输出里，白拿；
 * - **少算了每核细分 / 温度 / Top 进程**：远端要么得再跑命令、要么 `/proc` 里没有；
 * - **网络速率过滤了容器 / 网桥虚拟网卡**（见 `VIRTUAL_IFACE_RE` 的说明）。
 */
import type {
  HostDiskUsage,
  HostMetricsSnapshot,
  HostMonitorUnsupportedReason
} from '@fizz/contracts/agent-api'

/** 采集间隔（毫秒）缺省值：与前端缺省轮询节奏对齐 */
export const DEFAULT_INTERVAL_MS = 2_000

/** 允许的采集间隔范围（前端给 200ms~5s 几档，这里只做兜底校验） */
export const MIN_INTERVAL_MS = 100
export const MAX_INTERVAL_MS = 60_000

/**
 * 结果无效（目标系统没有 `/proc`，如 Windows / BSD / macOS）的**连续**次数上限。
 *
 * 这类目标不会自愈，几轮后上报「不支持监控」（`unavailable`）并停采 —— 继续空转只是
 * 每 2 秒白连一次 SSH。取 3 而不是 1：偶尔一帧 `/proc` 读空（刚启动 / 极端负载）不该
 * 直接判死刑。
 */
export const MAX_INVALID = 3

/**
 * 采集命令**执行失败**的连续次数上限。
 *
 * 比 `MAX_INVALID` 宽得多：连接抖动（SSH 会话数受限、网络瞬断）应当能自愈，只有长期
 * 失败才认定「这台采不了」。执行失败与结果无效是两种病，阈值刻意不同。
 */
export const MAX_EXEC_FAILURES = 15

/**
 * 空闲回收：最后一次「有人来取数」之后多久没人再问，就把这条主机的采集器连人带连接收掉。
 *
 * 为什么必须有：每台被看过一眼的主机都会占一条常驻 SSH 连接。用户切走标签页就再也不
 * 问它了，连接却一直挂着 —— 看过 20 台机器就是 20 条闲置连接，还会各自每 2 秒跑一条
 * 命令。30s 是「切个标签再切回来不必重连」与「别养僵尸连接」之间的折中。
 *
 * ⚠️ 回收**不清历史 / 快照**：再切回来时先看到上次的值（前端按新鲜度显示为「陈旧」），
 * 等第一帧新样本到达再刷新 —— 比先显示一片空白好。
 */
export const IDLE_TIMEOUT_MS = 30_000

/** 单条 exec 命令的超时（远端卡住 / 命令被挂起时不能让 Promise 永远不落地） */
export const EXEC_TIMEOUT_MS = 10_000

/** 环形缓冲长度：180 × 2s ≈ 6 分钟的趋势（与本机那份取同一个值） */
export const HISTORY_LEN = 180

/**
 * exec 输出的字节上限。正常一帧 `/proc` 全量输出约 10–30KB（`/proc/stat` 在大核数机器上
 * 也不小），给 512KB 已经很宽；超了直接截断 —— 这是**远端可控**的数据，不能让一台被
 * 攻破的机器用一条命令把服务端内存打爆。
 */
export const MAX_OUTPUT_BYTES = 512 * 1024

/**
 * 两次采样间隔超过 `intervalMs × 这个倍数` 就认为「中间断过」，CPU / 网络速率重新起基准。
 *
 * 为什么必须有（参考实现里没有这一步）：dogi 的采集器挂在一条**长活**的终端会话上，
 * 采样几乎不会断档；我们的采集器会被空闲回收（`IDLE_TIMEOUT_MS`）掐掉，再切回标签时
 * 中间可能隔了几分钟。若不重起基准，`(本次 - 上次) / 几分钟` 会算出一个被稀释到几乎为 0
 * 的「速率」，看着像网卡停了。同理 CPU 占用会被平均到几分钟，完全失真。
 *
 * 取 4 倍而不是 2 倍：偶发一帧变慢（远端负载高）不该被误判成断档。
 */
export const GAP_FACTOR = 4

/**
 * 采集命令：依次输出各段，段间用 `===XXX===` 独占一行做标记，便于在 Node 端切段。
 *
 * ## 为什么要一次跑完（而不是一条字段一条命令）
 *
 * 每多一次 `exec` 就多一次 SSH 往返（远端还要 fork 一个 shell）。这里把 9 条 `cat` /
 * `grep` 串成**一条**命令，只付一次往返；输出再在服务端切段解析。
 *
 * ## 逐条的必要性
 *
 * - `hostname` 输出**没有标记**（在最前面）—— 它要排在第一个 `echo` 之前，切段时正好
 *   落在「第一个标记之前」那一段；
 * - `2>/dev/null` 是必需的：远端缺 `/proc/xxx`（容器里被裁过）时 `cat` 会往 stderr 写
 *   一行报错，虽然我们只读 stdout，但报错混进 `===XXX===` 之间会让切段偏移；
 * - `grep -m1 'model name'` 取 CPU 型号：`/proc/cpuinfo` 在多核机器上有几十行重复的
 *   型号行，`-m1` 让输出只有一行；
 * - `uname -s` 排在第一行：**只为判定「不支持监控」的原因**（`unsupportedReasonOf`）——
 *   `MINGW*` / `CYGWIN*` = Windows 上的 Git Bash / Cygwin，`Darwin` / `FreeBSD` = 别的
 *   Unix，`uname` 本身不存在（Windows 原生 OpenSSH 的 cmd）则连这一段都是空的；
 * - `df -P -B1`：`-P` 保证一行一个文件系统（长设备名不会折行，折行会打乱列数）、
 *   `-B1` 让容量是**字节**（省得在 Node 端猜 1024-blocks 的块大小）。
 */
export const COLLECT_CMD = [
  'hostname 2>/dev/null',
  "echo '===OS==='; cat /etc/os-release 2>/dev/null",
  "echo '===UNAME==='; uname -s 2>/dev/null; uname -r 2>/dev/null; uname -m 2>/dev/null",
  "echo '===CPUINFO==='; grep -m1 'model name' /proc/cpuinfo 2>/dev/null",
  "echo '===LOAD==='; cat /proc/loadavg 2>/dev/null",
  "echo '===MEM==='; cat /proc/meminfo 2>/dev/null",
  "echo '===CPU==='; cat /proc/stat 2>/dev/null",
  "echo '===NET==='; cat /proc/net/dev 2>/dev/null",
  "echo '===UP==='; cat /proc/uptime 2>/dev/null",
  "echo '===DISK==='; df -P -B1 2>/dev/null"
].join('; ')

/**
 * 容器 / 网桥类虚拟网卡：汇总速率时**跳过**它们。
 *
 * 为什么不能只跳 `lo`（参考实现的做法）：宿主机上 `docker0` / `br-*` / `veth*` 承载的是
 * **同一份**容器流量 —— 容器经 `veth` 出去、再经物理网卡出去，两块网卡各记一次，直接
 * 相加就是双倍。跑着几个容器的机器上，徽标会稳定显示成真实流量的 2 倍。
 *
 * 刻意**只**跳这些明确会重复计的：`wg0` / `tun0` 这类 VPN 虽然也会被封装进物理网卡的
 * 计数，但从使用者的角度「VPN 上跑了多少」本身就是想看的信息，藏掉更让人困惑。
 */
const VIRTUAL_IFACE_RE = /^(lo|veth|docker|br-|virbr)/

/**
 * `df` 里要跳过的伪文件系统（`mount === '/'` 时除外）。
 *
 * `overlay` / `squashfs` 挂在 `/` 上时**就是**容器的真实根文件系统，跳过它等于这台机器
 * 一个磁盘都不显示 —— 所以留了「根分区永远保留」这个例外（与参考实现同一条规则）。
 */
const PSEUDO_FS_RE = /tmpfs|devtmpfs|squashfs|overlay|^\/dev\/loop/

/**
 * 段标记：独占一行的 `===XXX===`。
 *
 * `\r?` 不能省：远端若在某些环境下输出 CRLF（`socat` / 串口转发链路上出现过），
 * 行尾会多一个 `\r`，`$` 就匹配不上，整段标记都认不出来 —— 表现是「所有指标全 0」。
 */
const SECTION_RE = /^===([A-Z]+)===\r?$/gm

/** 解析一帧时要跨帧携带的基准（CPU 累计时间片 / 网络累计字节 / 上次时间戳） */
export interface HostParseState {
  /** 上次成功解析的时间戳（0 = 还没有基准） */
  prevTs: number
  /** 上次 `/proc/stat` 聚合行的累计 jiffies（全部字段之和） */
  prevCpuTotal: number
  /** 上次的 idle + iowait 累计 */
  prevCpuIdle: number
  /** 上次各网卡的累计字节（自算速率用） */
  prevNet: Record<string, { rx: number; tx: number }>
  /**
   * 静态信息：第一次解析出来的 hostname / 发行版 / 内核 / 架构 / CPU 型号。
   *
   * 跨帧保留是为了**抗单帧读取失败**：`/etc/os-release` 偶尔读不到时不该把已经拿到的
   * 发行版名抹成空串（那样弹窗标题会一闪一闪地少一行）。
   */
  static: StaticInfo | null
}

/** 远端静态信息（采集命令里随帧一起取，正常情况下一帧就齐了） */
export interface StaticInfo {
  hostname: string
  distro: string
  release: string
  arch: string
  cpuBrand: string
}

/** 一份全新的解析基准（首帧用） */
export function emptyParseState(): HostParseState {
  return {
    prevTs: 0,
    prevCpuTotal: 0,
    prevCpuIdle: 0,
    prevNet: {},
    static: null
  }
}

/** 归一化采集间隔：非法值回落缺省，越界值收敛到边界 */
export function normalizeInterval(ms: number | null | undefined): number {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return DEFAULT_INTERVAL_MS
  return Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, Math.round(ms)))
}

/**
 * 把 exec 输出切成 `标记 → 该段内容` 的表。
 *
 * 第一个标记**之前**的内容放在 `''` 这个键下（就是 `hostname` 那一行的输出）。
 * 没有标记时（命令整体失败）整段都落在 `''` 里，调用方拿到的是「静态信息全空 + 指标全 0」
 * 的一份快照，随后由 `isSupported()` 判为无效。
 */
export function parseSections(raw: string): Record<string, string> {
  const out: Record<string, string> = {}
  const marks: Array<{ key: string; start: number; end: number }> = []
  SECTION_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = SECTION_RE.exec(raw)) !== null) {
    marks.push({ key: m[1]!, start: m.index, end: m.index + m[0].length })
  }
  for (let i = 0; i < marks.length; i++) {
    const from = marks[i]!.end
    const to = i + 1 < marks.length ? marks[i + 1]!.start : raw.length
    out[marks[i]!.key] = raw.slice(from, to)
  }
  out[''] = marks.length ? raw.slice(0, marks[0]!.start) : raw
  return out
}

/** `/proc/meminfo` 取一个 kB 字段 → 字节（读不到给 0） */
function memGet(memRaw: string, key: string): number {
  // ⚠️ 必须 `^` 锚行首：`Cached:` 与 `SwapCached:` 都在这个文件里，不锚行首的话
  // `/Cached:\s+(\d+)/` 会先命中 `SwapCached`（它在 `Cached` 之后，但一旦顺序变化
  // 或用了不带锚的正则就会错），拿到的值会莫名其妙地小。
  const m = new RegExp(`^${key}:\\s+(\\d+)`, 'm').exec(memRaw)
  return m ? Number(m[1]) * 1024 : 0
}

/** `Number(x) || 0` 的可读别名（`NaN` / `Infinity` 都归 0） */
function num(v: string | undefined): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

const clampPercent = (v: number): number => Math.max(0, Math.min(100, v))

/**
 * 解析一帧采集输出。
 *
 * `state` 会被**就地推进**（上一帧的基准换成这一帧的），并同时返回，方便调用方按需
 * 只保留一份引用。纯计算，没有副作用 —— 唯一被改的就是传进来的这个对象。
 */
export function parseHostMetrics(
  raw: string,
  state: HostParseState,
  now: number,
  intervalMs: number = DEFAULT_INTERVAL_MS
): HostMetricsSnapshot {
  const sec = parseSections(raw)

  // ---- 静态信息 ----
  const hostnameNow = (sec[''] ?? '').trim().split(/\s+/)[0] ?? ''
  const osRaw = sec['OS'] ?? ''
  const pretty = /^PRETTY_NAME="?([^"\n]*?)"?\s*$/m.exec(osRaw)?.[1]?.trim() ?? ''
  const uname = (sec['UNAME'] ?? '').trim().split('\n')
  const release = (uname[1] ?? '').trim()
  const arch = (uname[2] ?? '').trim()
  const cpuBrandNow =
    /^model name\s*:\s*(.+?)\s*$/m.exec(sec['CPUINFO'] ?? '')?.[1]?.trim() ?? ''
  const prevStatic = state.static
  const staticInfo: StaticInfo = {
    hostname: hostnameNow || prevStatic?.hostname || '',
    distro: pretty || prevStatic?.distro || '',
    release: release || prevStatic?.release || '',
    arch: arch || prevStatic?.arch || '',
    cpuBrand: cpuBrandNow || prevStatic?.cpuBrand || ''
  }
  state.static = staticInfo

  // ---- 负载（loadavg 三段之外还有「运行/总进程数」与「最近 pid」，不用）----
  const loadParts = (sec['LOAD'] ?? '').trim().split(/\s+/)
  const load1 = num(loadParts[0])
  const load5 = num(loadParts[1])
  const load15 = num(loadParts[2])

  // ---- 内存 + swap ----
  const memRaw = sec['MEM'] ?? ''
  const memTotal = memGet(memRaw, 'MemTotal')
  const memFree = memGet(memRaw, 'MemFree')
  const buffers = memGet(memRaw, 'Buffers')
  const cached = memGet(memRaw, 'Cached')
  // `MemAvailable` 是内核给的「可用估计」，比 free+buffers+cached 更准；老内核（<3.14）
  // 没有这一行，那时退回三者之和（与参考实现同一条规则）。
  const memAvailable = memGet(memRaw, 'MemAvailable') || memFree + buffers + cached
  const memUsed = Math.max(0, memTotal - memAvailable)
  const memPercent = memTotal ? clampPercent((memUsed / memTotal) * 100) : 0
  const swapTotal = memGet(memRaw, 'SwapTotal')
  const swapFree = memGet(memRaw, 'SwapFree')
  const swapUsed = Math.max(0, swapTotal - swapFree)
  const swapPercent = swapTotal ? clampPercent((swapUsed / swapTotal) * 100) : 0

  // ---- CPU ----
  const cpuLines = (sec['CPU'] ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  const agg = cpuLines.find((l) => l.startsWith('cpu ')) ?? ''
  const cpuParts = agg
    .split(/\s+/)
    .slice(1)
    .map((n) => num(n))
  // 核数优先数 `cpuN` 行；`/proc/stat` 被裁得只剩聚合行时退回「有聚合行就算 1 核」
  const cores = cpuLines.filter((l) => /^cpu\d/.test(l)).length || (cpuParts.length ? 1 : 0)
  const cpuTotal = cpuParts.reduce((a, b) => a + b, 0)
  const cpuIdle = (cpuParts[3] ?? 0) + (cpuParts[4] ?? 0)

  /**
   * 中间断过档（空闲回收后重连 / 远端重启）就丢弃基准：见 `GAP_FACTOR` 的说明。
   *
   * 远端重启也会走到这里 —— `dTotal` 会变成负数（累计时间片归零），下面 `dTotal > 0`
   * 那一关同样把 `cpuPercent` 留成 null。
   */
  const gap = state.prevTs > 0 && now - state.prevTs > intervalMs * GAP_FACTOR
  const elapsed = state.prevTs > 0 && !gap ? (now - state.prevTs) / 1000 : 0
  let cpuPercent: number | null = null
  if (elapsed > 0) {
    const dTotal = cpuTotal - state.prevCpuTotal
    const dIdle = cpuIdle - state.prevCpuIdle
    if (dTotal > 0) cpuPercent = clampPercent((1 - dIdle / dTotal) * 100)
  }
  state.prevCpuTotal = cpuTotal
  state.prevCpuIdle = cpuIdle

  // ---- 网络（汇总非回环、非容器虚拟网卡，按速率算）----
  /**
   * `/proc/net/dev` 前两行是表头，但它们**不含 `:`**，下面 `idx < 0` 那一关就滤掉了；
   * 不再用「`.slice(2)` 跳过两行」那种写法 —— 切段后的正文以一个换行开头，`slice(2)`
   * 实际只吃掉了那个空行、把**第二行表头留在了数据里**（能跑对纯属表头恰好没有冒号）。
   * 多一道「接口名里不许有空白」的判据，即使某天表头带了冒号也不会被当成网卡。
   */
  const netLines = (sec['NET'] ?? '').split('\n')
  let netRxPerSec = 0
  let netTxPerSec = 0
  const curNet: Record<string, { rx: number; tx: number }> = {}
  for (const line of netLines) {
    const idx = line.indexOf(':')
    if (idx < 0) continue
    const iface = line.slice(0, idx).trim()
    if (!iface || /\s/.test(iface)) continue
    if (VIRTUAL_IFACE_RE.test(iface)) continue
    // 列序：rx_bytes packets errs drop fifo frame compressed multicast | tx_bytes …
    const f = line.slice(idx + 1).trim().split(/\s+/)
    const rx = num(f[0])
    const tx = num(f[8])
    curNet[iface] = { rx, tx }
    const prevOne = state.prevNet[iface]
    if (prevOne && elapsed > 0) {
      // 计数器被重置 / 网卡重启时差值可能为负，按 0 算，别出现负速率
      netRxPerSec += Math.max(0, (rx - prevOne.rx) / elapsed)
      netTxPerSec += Math.max(0, (tx - prevOne.tx) / elapsed)
    }
  }
  state.prevNet = curNet

  // ---- 运行时长（uptime 第一列是秒，第二列是空闲秒数，不用）----
  const uptime = num((sec['UP'] ?? '').trim().split(/\s+/)[0])

  // ---- 磁盘（`df -P -B1`：Filesystem 1B-blocks Used Available Capacity Mounted-on）----
  /**
   * ⚠️ 表头行必须显式跳过。`df -P` 的表头是
   * `Filesystem 1B-blocks Used Available Capacity Mounted on` —— **7 个字段**，
   * 光靠「列数 ≥ 6」这一关是拦不住的，它会被当成一个挂载点叫 `Mounted on`、
   * 容量 0/0 的磁盘行混进列表（参考实现里就有这个洞）。
   *
   * 用 `f[0] === 'Filesystem'` 判表头而不是「靠正文第一个换行」：后者依赖
   * `parseSections` 切出来的片段是否带前导换行，改一次切段实现就会静默失效。
   */
  const disk: HostDiskUsage[] = []
  for (const raw of (sec['DISK'] ?? '').split('\n')) {
    const l = raw.trim()
    if (!l) continue
    const f = l.split(/\s+/)
    // 列数不足的行直接丢：`df` 在某些系统上会补一行说明性文字
    if (f.length < 6) continue
    const fs = f[0] ?? ''
    if (fs === 'Filesystem') continue
    // Used / Available 必须是纯数字：容量列一旦不是数字，这行就不是数据行
    if (!/^\d+$/.test(f[2] ?? '') || !/^\d+$/.test(f[3] ?? '')) continue
    const used = num(f[2])
    const available = num(f[3])
    const percent = parseInt(f[4] ?? '', 10) || 0
    // ⚠️ 挂载点里可能有空格（`df -P` 不转义），那种情况列数必然 > 6，这里取第 6 列起的
    // 全部并回去，免得把 `/mnt/my disk` 截成 `/mnt/my`
    const mount = f.slice(5).join(' ')
    if (PSEUDO_FS_RE.test(fs) && mount !== '/') continue
    disk.push({ mount, used, total: used + available, percent })
  }

  state.prevTs = now

  return {
    at: now,
    cpuPercent,
    cores,
    cpuBrand: staticInfo.cpuBrand,
    memTotal,
    memUsed,
    memPercent,
    swapTotal,
    swapUsed,
    swapPercent,
    load1,
    load5,
    load15,
    netRxPerSec,
    netTxPerSec,
    disk,
    uptime,
    hostname: staticInfo.hostname,
    distro: staticInfo.distro,
    release: staticInfo.release,
    arch: staticInfo.arch
  }
}

/**
 * 这一帧是不是「有效数据」。
 *
 * 命令执行成功但目标系统没有 `/proc`（Windows / BSD / macOS）时所有字段都会解析成 0 ——
 * 这种伪数据不推送、也进不了历史曲线。判据与参考实现一致：内存总量 / 核数 / 磁盘
 * 三者任一有值就算有效（三者都为 0 说明确实什么都没读到）。
 */
export function isSupported(snapshot: HostMetricsSnapshot): boolean {
  return snapshot.memTotal > 0 || snapshot.cores > 0 || snapshot.disk.length > 0
}

/**
 * 采不到有效数据时，判断「这台主机为什么不支持监控」。
 *
 * 只在连续多轮无效、要收摊上报时调一次（不是每帧），所以这里重新切一遍段是划算的 ——
 * 换来的是 `parseHostMetrics` 不必为了一个诊断字段把 `uname -s` 带进契约快照里。
 *
 * 判据只看 `uname -s` 那一段（见 `COLLECT_CMD` 的说明）：
 * - `MINGW*` / `CYGWIN*` / `MSYS*` → Windows 上的 Git Bash / Cygwin / MSYS；
 * - 有 `uname` 输出但不是 Linux（`Darwin` / `FreeBSD`…）→ 别的 Unix；
 * - 连 `uname` 都没有（Windows 原生 OpenSSH 的 cmd.exe 会这样）→ 归到 `unavailable`，
 *   因为我们**确实不知道**对面是什么，硬说是 Windows 属于编数据。
 */
export function unsupportedReasonOf(raw: string): HostMonitorUnsupportedReason {
  const sysName = (parseSections(raw)['UNAME'] ?? '').trim().split('\n')[0]?.trim() ?? ''
  if (!sysName) return 'unavailable'
  if (/^(MINGW|CYGWIN|MSYS)/i.test(sysName)) return 'windows'
  return /^Linux/i.test(sysName) ? 'unavailable' : 'other'
}

/** 把一个有效快照压成历史曲线上的一个点 */
export function toHistorySample(snapshot: HostMetricsSnapshot): {
  at: number
  cpuPercent: number
  memPercent: number
  netRxPerSec: number
  netTxPerSec: number
} {
  return {
    at: snapshot.at,
    // 首帧算不出占用（null）—— 曲线上的点必须是数字，记 0；下一帧起就是真值
    cpuPercent: snapshot.cpuPercent ?? 0,
    memPercent: snapshot.memPercent,
    netRxPerSec: snapshot.netRxPerSec,
    netTxPerSec: snapshot.netTxPerSec
  }
}
