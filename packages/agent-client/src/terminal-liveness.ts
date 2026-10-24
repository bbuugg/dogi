/**
 * 终端 WS 的应用层保活：定时发 `ping`，用服务端回的任何一帧探活。
 *
 * 为什么要应用层心跳：终端是**静默**通道（不敲键、程序没输出时链路上一个字节都没有），
 * 走域名时前面通常是 nginx，其 `proxy_read_timeout` 默认 60s —— 空闲连接会被代理掐掉，
 * 用户看到的就是「终端莫名其妙断了」。`ping` / `pong` 是**数据帧**，会被代理算作活跃流量。
 *
 * ⚠️ 判死的前提是**这一轮 tick 准点**（见 `tick` 里的说明）：只看「距上次回帧多久」的
 * 写法在页面被浏览器节流时必然误杀活着的连接，用户看到的就是「终端心跳超时」。
 *
 * 为什么单独成模块：这段逻辑的成败取决于**它自己的定时器有没有被准点叫醒**，而
 * 「后台标签页被浏览器节流」这件事只有在浏览器里才自然发生。抽出来 + 注入时钟 / 定时器，
 * 就能在 Node 里用假时钟把它复现出来（`scripts/verify-terminal-liveness.mts`）。
 */

/** 发 ping 的节奏 */
export const PING_INTERVAL_MS = 10_000
/** 探活窗口：定时器准点的前提下，超过这么久没收到服务端任何一帧才判死 */
export const DEAD_AFTER_MS = 35_000

export interface LivenessOptions {
  /** 发一帧应用层 `ping`（对端会回 `pong`） */
  ping(): void
  /** 判定对端已死：断掉连接 */
  declareDead(): void
  /** 当前时刻（毫秒）。测试注入假时钟 */
  now?: () => number
  /** 装定时器。测试注入假定时器 */
  setTimer?: (fn: () => void, ms: number) => unknown
  /** 拆定时器 */
  clearTimer?: (handle: unknown) => void
}

export interface Liveness {
  /** 连接就绪后开一次 */
  start(): void
  /** 断开 / 主动收工时停掉（不留定时器） */
  stop(): void
  /** 收到服务端的**任何一帧**时叫一下：能收到字节就说明链路是活的 */
  noteFrame(): void
}

export function createLiveness(options: LivenessOptions): Liveness {
  const now = options.now ?? ((): number => Date.now())
  const setTimer =
    options.setTimer ?? ((fn: () => void, ms: number): unknown => setInterval(fn, ms))
  const clearTimer =
    options.clearTimer ??
    ((handle: unknown): void => {
      clearInterval(handle as ReturnType<typeof setInterval>)
    })

  let handle: unknown = null
  /** 最后一次收到服务端帧的时刻 */
  let lastFrame = 0
  /** 上一次 tick 的时刻：用来分辨「对端死了」与「我们自己被节流了」 */
  let lastTick = 0

  const stop = (): void => {
    if (handle === null) return
    clearTimer(handle)
    handle = null
  }

  const tick = (): void => {
    const at = now()
    const gap = at - lastTick
    lastTick = at
    /**
     * 区分两件长得一模一样的事：「对端死了」和「**我们自己的定时器被拖了**」。
     *
     * 后台标签页会被浏览器节流（Chrome 隐藏 ≥5 分钟后的强化节流：定时器最多一分钟
     * 才被检查一次）、手机息屏后 JS 直接被冻结、笔记本睡眠后再唤醒、主线程被一屏
     * 大输出卡住 —— 这些情况下「距上次回帧 > 35s」照样成立，但链路是好的。
     * 所以判死的前提是**这一轮 tick 本身是准点的**（gap 也在探活窗口内）：
     * 钟都不准了，就没资格判对端死活。
     */
    if (gap > DEAD_AFTER_MS) {
      // 只补发一次 ping 重新探活：链路真死了，下一轮准点的 tick 就会判死（迟一轮，仅一次 ping 的时间）
      options.ping()
      return
    }
    if (at - lastFrame > DEAD_AFTER_MS) {
      // 判死只做一次：定时器先摘掉，别每轮都去 close 一遍
      stop()
      options.declareDead()
      return
    }
    options.ping()
  }

  return {
    start: () => {
      if (handle !== null) return
      lastFrame = now()
      lastTick = lastFrame
      handle = setTimer(tick, PING_INTERVAL_MS)
    },
    stop,
    noteFrame: () => {
      lastFrame = now()
    }
  }
}
