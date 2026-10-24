/**
 * SSH 主机的性能监控采集器：**按主机 id 一条常驻 SSH 连接 + 定时 exec**。
 *
 * ## 与参考实现（上级目录 dogi）最本质的差异：数据方向反过来
 *
 * dogi 是 Electron 主进程里的**推送**模型：监控器挂在一条已经开着的终端会话上
 * （`session.exec()`），采到一帧就 `emit` 给渲染端。fizz 的终端在**服务端**、
 * 渲染端与服务端之间只有 WS / HTTP，而且终端会话可能压根没开（用户没打开那台机器的
 * 标签）。所以这里换成**拉取**模型：
 *
 * - 渲染端轮询 `GET /api/ssh/hosts/:id/metrics`；
 * - 服务端按「最近还有人问」判断要不要继续采（`IDLE_TIMEOUT_MS` 空闲回收）；
 * - 采集**不依赖**终端会话，自己开一条只跑 exec 的 SSH 连接 —— 用户没开终端也能看监控，
 *   而且终端那边断开重连不影响采集。
 *
 * 代价是「没人看就不采」（dogi 是终端开着就一直采）。这是刻意的：服务端可能同时被
 * 好几个浏览器访问，没人看的主机不该白占连接。
 *
 * ## 为什么自己开连接，而不是复用终端那条
 *
 * 终端会话（`ssh/session.ts`）是一条 `client.shell()` 交互流，它没有「顺手跑一条命令」
 * 的出口；要复用就得往协议里加控制帧，还会把监控的生死绑到某个标签页上（标签一关监控
 * 就断）。单开一条连接只需要一次握手，且能跑多个 exec 通道（每帧一条，互不干扰）。
 *
 * ## 挂在 globalThis 的原因
 *
 * 与 `services/system-monitor.ts` 同一条：采集器由路由（Turbopack 加载）创建，
 * `stopAllHostMonitors()` 却从 `shutdown.ts`（tsx 侧）调，两边模块缓存不互通 ——
 * 只有把注册表也放 `globalThis`，收尾时才关得掉 Turbopack 侧建的那些连接。
 */
import type { Client } from 'ssh2'
import type {
  HostMetrics,
  HostMetricsSample,
  HostMetricsSnapshot,
  HostMonitorUnsupportedReason
} from '@fizz/contracts/agent-api'
import { appLog } from '@fizz/workspace'
import { connectWithJumps, type ConnectedChain } from './connect'
import { domain } from '../state'
import {
  COLLECT_CMD,
  DEFAULT_INTERVAL_MS,
  EXEC_TIMEOUT_MS,
  HISTORY_LEN,
  IDLE_TIMEOUT_MS,
  MAX_EXEC_FAILURES,
  MAX_INVALID,
  MAX_OUTPUT_BYTES,
  emptyParseState,
  isSupported,
  normalizeInterval,
  parseHostMetrics,
  toHistorySample,
  unsupportedReasonOf,
  type HostParseState
} from './host-metrics'

/**
 * 一台主机的采集器。
 *
 * 生命周期：**懒创建**（第一次有人来取数时）→ 定时采样 → 空闲超时或判定不支持后
 * `stop()` + `disconnect()`，并从注册表里摘掉（下次来取数会重新建一个，历史随之清空）。
 */
class HostMonitor {
  /** 采集循环的定时器（递归 setTimeout：等上一帧真的采完才排下一帧，避免并发 exec） */
  private timer: NodeJS.Timeout | null = null
  /** 当前连接（含跳板链）；null = 还没连上 / 已断开 */
  private chain: ConnectedChain | null = null
  /** 正在进行的建连（并发请求共用同一次握手，别连两条） */
  private connecting: Promise<ConnectedChain> | null = null
  /** 有一帧正在采：跳过本轮，下个周期再来（远端慢时不会堆积） */
  private busy = false
  /** 最后一次「有人来取数」的时间（空闲回收的唯一判据） */
  private lastRequest = 0
  private intervalMs: number
  private readonly state: HostParseState = emptyParseState()
  private history: HostMetricsSample[] = []
  private snapshot: HostMetricsSnapshot | null = null
  private unsupported: HostMonitorUnsupportedReason | null = null
  private error: string | null = null
  private execFailures = 0
  private invalidResults = 0

  constructor(
    readonly hostId: string,
    intervalMs: number
  ) {
    this.intervalMs = normalizeInterval(intervalMs)
  }

  // -------------------------------------------------------------------------
  // 对外：取一帧快照（同时充当「我还在看」的心跳）
  // -------------------------------------------------------------------------

  /** 取当前指标。
   *
   * ⚠️ **不 await 首帧**：远端要现连 SSH + 跑一条命令（可能几百毫秒到几秒），
   * 让 HTTP 请求阻塞在那里等着，前端拿到的是一个「卡住」的请求，而不是「正在读取」。
   * 所以这里只把采集踢起来，有多少给多少（首帧 `snapshot: null`），前端下一轮就有了。
   */
  getMetrics(intervalMs?: number): HostMetrics {
    this.lastRequest = Date.now()
    if (typeof intervalMs === 'number') this.setTick(intervalMs)
    // 已判「不支持」的是终态：不再重连重试（重试只会每 2 秒白连一次）
    if (!this.unsupported) this.start()
    return {
      snapshot: this.snapshot,
      history: this.history.slice(),
      sampleIntervalMs: this.intervalMs,
      unsupported: this.unsupported,
      error: this.error
    }
  }

  /**
   * 彻底收摊：停采 + 断开连接。
   *
   * 进程收尾（`stopAllHostMonitors`）与「主机配置变了」（`dropHostMonitor`）都走它 ——
   * 后者的理由：改完主机地址后旧采集器还连着**老地址**，徽标会继续显示老机器的指标，
   * 看起来就是「改了没生效」。
   */
  dispose(): void {
    this.stop()
    this.disconnect()
  }

  // -------------------------------------------------------------------------
  // 采集循环
  // -------------------------------------------------------------------------

  private start(): void {
    if (this.timer) return
    this.schedule()
    void this.tick()
  }

  /**
   * 排下一帧。
   *
   * 递归 `setTimeout` 而不是 `setInterval`：上一帧要等 SSH 往返，`setInterval` 会在远端
   * 慢的时候把多帧叠在一起（并发 exec 把连接占满）。与 `system-monitor.ts` 同一取舍。
   *
   * `unref()` 让这个定时器不挡进程退出（CLI / 测试里跑完就该能退）。
   */
  private schedule(): void {
    const timer = setTimeout(() => {
      void this.tick().then(() => {
        if (this.timer) this.schedule()
      })
    }, this.intervalMs)
    timer.unref?.()
    this.timer = timer
  }

  private stop(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  /** 改采集间隔：立即按新节奏重建定时器（前端换挡后不用等旧周期走完） */
  private setTick(ms: number): void {
    const next = normalizeInterval(ms)
    if (next === this.intervalMs) return
    this.intervalMs = next
    if (this.timer) {
      this.stop()
      this.schedule()
    }
  }

  private async tick(): Promise<void> {
    if (this.unsupported) {
      this.stop()
      return
    }
    // 空闲回收：没人看就收摊（连连接一起关，见 IDLE_TIMEOUT_MS 的说明）
    if (this.lastRequest && Date.now() - this.lastRequest > IDLE_TIMEOUT_MS) {
      this.stop()
      this.disconnect()
      return
    }
    if (this.busy) return
    this.busy = true
    try {
      const raw = await this.collect()
      const now = Date.now()
      const snapshot = parseHostMetrics(raw, this.state, now, this.intervalMs)
      if (!isSupported(snapshot)) {
        // 命令跑通了但一个字段都没读到 = 对面没有 /proc（或 /proc 被裁过）。
        // 连续几轮如此就判定「不支持监控」并收摊 —— 这类目标不会自愈。
        this.invalidResults++
        if (this.invalidResults >= MAX_INVALID) {
          this.reportUnsupported(unsupportedReasonOf(raw))
        }
        return
      }
      this.execFailures = 0
      this.invalidResults = 0
      this.error = null
      this.snapshot = snapshot
      this.history.push(toHistorySample(snapshot))
      if (this.history.length > HISTORY_LEN) {
        this.history.splice(0, this.history.length - HISTORY_LEN)
      }
    } catch (err) {
      // 单帧失败不该打断采样：连接抖动（SSH 会话数受限 / 网络瞬断）应当能自愈，
      // 只有长期失败才收摊。连接已死的判断交给 onClose，这里只记账 + 把原因带给前端。
      this.execFailures++
      this.error = err instanceof Error ? err.message : String(err)
      if (this.execFailures >= MAX_EXEC_FAILURES) {
        // 只在**收摊那一刻**记一次：逐帧失败的日志等于每 2 秒刷一条，日志面板会被它淹掉。
        // 前面那些零星抖动由前端 `error` 字段自己展示，不需要落档。
        appLog.error(
          'ssh',
          `主机监控已停止（连续 ${this.execFailures} 次采集失败）`,
          `主机 id: ${this.hostId}\n${this.error}`
        )
        this.stop()
        this.disconnect()
      }
    } finally {
      this.busy = false
    }
  }

  /** 上报「这台主机不支持监控」：停采 + 断开（终态） */
  private reportUnsupported(reason: HostMonitorUnsupportedReason): void {
    this.unsupported = reason
    this.error = null
    // 一次性的终态事件，值得记一条：用户只会看到徽标灰掉，日志里能查到是因为什么
    appLog.info('ssh', `主机监控不可用（${reason}）`, `主机 id: ${this.hostId}`)
    this.stop()
    this.disconnect()
  }

  // -------------------------------------------------------------------------
  // 连接
  // -------------------------------------------------------------------------

  /** 确保有一条可用连接；并发调用共用同一次握手 */
  private async ensureConnected(): Promise<ConnectedChain> {
    if (this.chain) return this.chain
    if (this.connecting) return this.connecting
    const pending = (async () => {
      // 主机被删掉时 `resolveSshHost` 会抛（错误信息直接给用户看）
      const host = domain.resolveSshHost(this.hostId)
      const chain = await connectWithJumps(host)
      /**
       * 连接断了要立刻把引用清掉，否则下一帧会往一条死连接上 exec，错误信息还是
       * 「通道已关闭」这种看不出根因的话。
       *
       * 比对 `this.chain === chain` 再清：换主机 / 空闲回收后可能已经有新连接了，
       * 旧连接的 close 事件晚一拍回来时不能把新连接误清掉（`TerminalPanel` 里那个
       * 「旧进程 onExit 盖掉新终端」的坑是同一类问题）。
       */
      const drop = (): void => {
        if (this.chain !== chain) return
        this.chain = null
        // 连接自己断了不算「采集命令失败」—— 重新连上就该重新计数
        this.execFailures = 0
      }
      chain.client.on('close', drop)
      chain.client.on('error', drop)
      this.chain = chain
      return chain
    })()
    this.connecting = pending
    try {
      return await pending
    } finally {
      this.connecting = null
    }
  }

  /** 关掉连接（不影响已经采到的快照 / 历史 —— 切回来还能先看到上次的值） */
  private disconnect(): void {
    const chain = this.chain
    this.chain = null
    this.connecting = null
    if (!chain) return
    try {
      chain.dispose()
    } catch {
      // 可能已经在关闭流程里
    }
  }

  /**
   * 跑一次采集命令，返回 stdout 全文。
   *
   * 三层护栏，缺一不可：
   * - **超时**：远端卡住（命令被挂起 / 磁盘 hang 住）时 `close` 可能永远不来，
   *   没有超时这一帧就永远 `busy`，整个采集器静默停摆；
   * - **字节上限**：输出是**远端可控**的，不能让一台被攻破的机器用一条命令把服务端
   *   内存打爆（`MAX_OUTPUT_BYTES`）；
   * - **stderr 丢弃**：`2>/dev/null` 已经拦了一层，但远端 shell 包装（如某些
   *   ForceCommand）仍可能往 stderr 写东西，混进 stdout 会污染段标记。
   */
  private execCollect(): Promise<string> {
    const client = this.chain?.client
    if (!client) return Promise.reject(new Error('SSH 连接尚未就绪'))
    return new Promise<string>((resolve, reject) => {
      let settled = false
      const finish = (err: Error | null, out = ''): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (err) reject(err)
        else resolve(out)
      }
      const timer = setTimeout(
        () => finish(new Error('采集命令超时（远端未在限时内返回）')),
        EXEC_TIMEOUT_MS
      )
      timer.unref?.()
      client.exec(COLLECT_CMD, (err: Error | undefined, stream) => {
        if (err || !stream) {
          finish(err ?? new Error('无法在远端执行采集命令'))
          return
        }
        let out = ''
        let truncated = false
        stream.on('data', (data: Buffer) => {
          if (truncated) return
          out += data.toString('utf8')
          if (out.length > MAX_OUTPUT_BYTES) {
            truncated = true
            out = out.slice(0, MAX_OUTPUT_BYTES)
          }
        })
        stream.stderr?.on('data', () => undefined)
        stream.on('close', () => finish(null, out))
        stream.on('error', (e: Error) => finish(e))
      })
    })
  }

  /** 采集一帧：确保连上再跑命令 */
  private async collect(): Promise<string> {
    await this.ensureConnected()
    return this.execCollect()
  }
}

// ---------------------------------------------------------------------------
// 注册表
// ---------------------------------------------------------------------------

interface MonitorRegistry {
  monitors: Map<string, HostMonitor>
}

const GLOBAL_KEY = '__FIZZ_HOST_MONITORS__'

function registry(): MonitorRegistry {
  const g = globalThis as Record<string, unknown>
  let r = g[GLOBAL_KEY] as MonitorRegistry | undefined
  if (!r) {
    r = { monitors: new Map() }
    g[GLOBAL_KEY] = r
  }
  return r
}

/**
 * 取某台主机的监控数据（不存在就现建一个并开始采）。
 *
 * `intervalMs` 是前端希望用的采集间隔（换挡时传），不传沿用该主机当前的间隔。
 */
export function getHostMetrics(hostId: string, intervalMs?: number): HostMetrics {
  const reg = registry()
  let monitor = reg.monitors.get(hostId)
  if (!monitor) {
    monitor = new HostMonitor(hostId, intervalMs ?? DEFAULT_INTERVAL_MS)
    reg.monitors.set(hostId, monitor)
  }
  return monitor.getMetrics(intervalMs)
}

/**
 * 收掉全部主机监控（进程退出时调）。
 *
 * 空闲回收是常态路径（30s 没人看就自己关），这里只是收尾：连接是真实的 socket，
 * 不显式关掉会拖着进程不退出。
 */
export function stopAllHostMonitors(): void {
  const reg = registry()
  for (const monitor of reg.monitors.values()) monitor.dispose()
  reg.monitors.clear()
}

/**
 * 某台主机被删除 / 改了连接参数时，把它那条采集连接收掉（理由见 `HostMonitor.dispose`）。
 */
export function dropHostMonitor(hostId: string): void {
  const reg = registry()
  const monitor = reg.monitors.get(hostId)
  if (!monitor) return
  reg.monitors.delete(hostId)
  monitor.dispose()
}
