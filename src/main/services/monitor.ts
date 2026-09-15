import { EventEmitter } from 'node:events'
import { sessionManager } from './sessions'
import type { ServerMetrics } from '@shared/types'

/** 采集间隔（毫秒） */
const TICK_MS = 2000

/**
 * 结果无效（目标系统没有 /proc，如 Windows / BSD / macOS）的连续次数上限：
 * 这类目标不会自愈，几轮后即停止采集，避免持续空转。
 */
const MAX_INVALID = 3

/**
 * 采集命令执行失败的连续次数上限：连接抖动（如 SSH 会话数受限）应能自愈，
 * 因此阈值放宽；仅长期失败才判定该会话不可采集。
 */
const MAX_EXEC_FAILURES = 15

/**
 * 一次性采集命令：依次输出各段，段间用固定分隔标记，便于在 Node 端解析。
 * 仅依赖 Linux 的 /proc 与 df，覆盖绝大多数服务器场景。
 */
const COLLECT_CMD = [
  'cat /proc/loadavg 2>/dev/null',
  "echo '===MEM==='; cat /proc/meminfo 2>/dev/null",
  "echo '===CPU==='; cat /proc/stat 2>/dev/null",
  "echo '===NET==='; cat /proc/net/dev 2>/dev/null",
  "echo '===UP==='; cat /proc/uptime 2>/dev/null",
  "echo '===DISK==='; df -P -B1 2>/dev/null"
].join('; ')

/** 取出 raw 中 start 与 end 标记之间的内容（不含标记） */
function section(raw: string, start: string, end: string | null): string {
  const s = raw.indexOf(start)
  if (s === -1) return ''
  const from = s + start.length
  if (!end) return raw.slice(from)
  const e = raw.indexOf(end, from)
  return e === -1 ? raw.slice(from) : raw.slice(from, e)
}

interface NetSample {
  rx: number
  tx: number
}

/**
 * 判断采集结果是否有效：命令执行成功但目标系统不含 /proc（如 Windows / BSD / macOS）
 * 时各字段会解析为 0，这类「伪数据」不推送，前端也就不显示指标图标。
 */
function isSupported(m: ServerMetrics): boolean {
  return m.memTotal > 0 || m.cores > 0 || m.disk.length > 0
}

/** 单个会话的监控器：定时采集、解析、计算速率并对外 emit 最新指标 */
class SessionMonitor extends EventEmitter {
  private timer: NodeJS.Timeout | null = null
  /** 连续执行失败 / 结果无效次数，达各自上限后停止采集 */
  private execFailures = 0
  private invalidResults = 0
  private prevTs = 0
  private prevCpuTotal = 0
  private prevCpuIdle = 0
  private prevNet: Record<string, NetSample> = {}

  constructor(private readonly sessionId: string) {
    super()
  }

  start(): void {
    if (this.timer) return
    void this.tick()
    this.timer = setInterval(() => void this.tick(), TICK_MS)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private async tick(): Promise<void> {
    const session = sessionManager.get(this.sessionId)
    if (!session) {
      this.stop()
      return
    }
    // 连接尚未就绪（SSH 握手中 / 本地 shell 未启动），跳过本轮，下个周期再试
    if (!session.isReady()) return
    let raw = ''
    try {
      raw = await session.exec(COLLECT_CMD)
    } catch {
      // 连接异常或目标无法执行采集命令：多为瞬时故障，连续多次失败才停止
      this.execFailures++
      if (this.execFailures >= MAX_EXEC_FAILURES) this.stop()
      return
    }
    const now = Date.now()
    const elapsed = this.prevTs ? (now - this.prevTs) / 1000 : 0
    const metrics = this.parse(raw, elapsed, now)
    // 采集不到有效数据时不推送（前端据此不显示指标）
    if (!isSupported(metrics)) {
      this.invalidResults++
      if (this.invalidResults >= MAX_INVALID) this.stop()
      return
    }
    this.execFailures = 0
    this.invalidResults = 0
    this.prevTs = now
    this.emit('data', metrics)
  }

  private parse(raw: string, elapsed: number, now: number): ServerMetrics {
    const loadRaw = raw.split('===MEM===')[0].trim()
    const memRaw = section(raw, '===MEM===', '===CPU===')
    const cpuRaw = section(raw, '===CPU===', '===NET===')
    const netRaw = section(raw, '===NET===', '===UP===')
    const upRaw = section(raw, '===UP===', '===DISK===')
    const diskRaw = section(raw, '===DISK===', null)

    // ---- 负载 ----
    const loadParts = loadRaw.split(/\s+/)
    const load1 = parseFloat(loadParts[0]) || 0
    const load5 = parseFloat(loadParts[1]) || 0
    const load15 = parseFloat(loadParts[2]) || 0

    // ---- 内存 ----
    const memGet = (key: string): number => {
      const m = memRaw.match(new RegExp(`${key}:\\s+(\\d+)`))
      return m ? Number(m[1]) * 1024 : 0
    }
    const memTotal = memGet('MemTotal')
    const memFree = memGet('MemFree')
    const buffers = memGet('Buffers')
    const cached = memGet('Cached')
    const memAvailable = memGet('MemAvailable') || memFree + buffers + cached
    const memUsed = Math.max(0, memTotal - memAvailable)
    const memPercent = memTotal ? (memUsed / memTotal) * 100 : 0

    // ---- CPU（聚合行 cpu + 各核 cpuN）----
    const cpuLines = cpuRaw.split('\n').map((l) => l.trim()).filter(Boolean)
    const agg = cpuLines.find((l) => l.startsWith('cpu ')) ?? cpuLines[0] ?? ''
    const cpuParts = agg
      .split(/\s+/)
      .slice(1)
      .map((n) => Number(n) || 0)
    const cores =
      cpuLines.filter((l) => /^cpu\d/.test(l)).length || (cpuParts.length ? 1 : 0)
    const cpuTotal = cpuParts.reduce((a, b) => a + b, 0)
    const cpuIdle = (cpuParts[3] || 0) + (cpuParts[4] || 0)
    let cpuPercent: number | null = null
    if (this.prevTs && elapsed > 0) {
      const dTotal = cpuTotal - this.prevCpuTotal
      const dIdle = cpuIdle - this.prevCpuIdle
      if (dTotal > 0) {
        cpuPercent = Math.max(0, Math.min(100, (1 - dIdle / dTotal) * 100))
      }
    }
    this.prevCpuTotal = cpuTotal
    this.prevCpuIdle = cpuIdle

    // ---- 网络（汇总非回环网卡，按速率计算）----
    const netLines = netRaw.split('\n').slice(2) // 跳过两行表头
    let netRxRate = 0
    let netTxRate = 0
    const curNet: Record<string, NetSample> = {}
    for (const line of netLines) {
      const idx = line.indexOf(':')
      if (idx < 0) continue
      const iface = line.slice(0, idx).trim()
      if (iface === 'lo') continue
      const f = line
        .slice(idx + 1)
        .trim()
        .split(/\s+/)
        .map(Number)
      const rx = f[0] || 0
      const tx = f[8] || 0
      curNet[iface] = { rx, tx }
      const prev = this.prevNet[iface]
      if (prev && elapsed > 0) {
        netRxRate += Math.max(0, (rx - prev.rx) / elapsed)
        netTxRate += Math.max(0, (tx - prev.tx) / elapsed)
      }
    }
    this.prevNet = curNet

    // ---- 运行时长 ----
    const upSec = parseFloat(upRaw.trim().split(/\s+/)[0]) || 0

    // ---- 磁盘（df -P -B1）----
    const diskLines = diskRaw.split('\n').slice(1) // 跳过表头
    const disk: ServerMetrics['disk'] = []
    for (const l of diskLines) {
      const f = l.trim().split(/\s+/)
      // df -P 列：Filesystem 1024-blocks Used Available Capacity Mounted-on
      if (f.length < 6) continue
      const fs = f[0]
      const used = Number(f[2]) || 0
      const available = Number(f[3]) || 0
      const percent = parseInt(f[4], 10) || 0
      const mount = f[5]
      // 跳过内存盘/只读层等伪文件系统（保留根分区与真实挂载点）
      if (/tmpfs|devtmpfs|squashfs|overlay|snap/.test(fs) && mount !== '/') continue
      disk.push({ mount, used, total: used + available, percent })
    }

    return {
      cpuPercent,
      cores,
      memTotal,
      memUsed,
      memPercent,
      load1,
      load5,
      load15,
      netRxRate,
      netTxRate,
      disk,
      uptime: upSec,
      timestamp: now
    }
  }
}

/** 监控服务：按会话管理各自的 SessionMonitor，并对外广播最新指标 */
class MonitorService extends EventEmitter {
  private monitors = new Map<string, SessionMonitor>()

  start(sessionId: string): void {
    if (this.monitors.has(sessionId)) return
    // 采集依赖 Linux 的 /proc 与 df：非 Linux 的本地终端不可能取到数据，直接跳过
    const info = sessionManager.get(sessionId)?.info
    if (info && info.type === 'local' && process.platform !== 'linux') return
    const sm = new SessionMonitor(sessionId)
    sm.on('data', (metrics: ServerMetrics) => {
      this.emit('data', { sessionId, metrics })
    })
    this.monitors.set(sessionId, sm)
    sm.start()
  }

  stop(sessionId: string): void {
    const sm = this.monitors.get(sessionId)
    if (!sm) return
    sm.stop()
    this.monitors.delete(sessionId)
  }

  stopAll(): void {
    for (const id of [...this.monitors.keys()]) this.stop(id)
  }
}

export const monitorService = new MonitorService()
