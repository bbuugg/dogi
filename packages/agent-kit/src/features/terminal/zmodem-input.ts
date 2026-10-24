/**
 * ZMODEM（rz/sz）收尾相关的纯逻辑：不碰终端、不碰会话，只按时间戳算状态，方便单测。
 */

/**
 * zmodem.js 内部用 `array.push.apply(array, input)` 把入站字节并进内部缓冲
 * （`zsentry.js` 的 `_parse`、`zsession.js` 的 `_strip_and_enqueue_input`）。`Function.apply`
 * 的参数个数有硬上限（V8 上约 12 万），所以**单次喂进去的块一旦够大（实测 ≥ ~128KB）就会抛
 * `RangeError: Maximum call stack size exceeded`** —— 报错栈停在 `zterm.consume` 那一帧。
 *
 * 触发场景：desktop 的 WS 合批（`ws-batch.ts`）允许把二进制帧合并到 4MB 再下发，`sz` 下载
 * 一大文件时就会一次送来一整个大块 → `consume` 当场溢出 → 会话中途死掉（进度条丢失）+ 之后
 * 的冲刷。分片喂即可，**无损**：`Sentry.consume` 明确支持把一条协议流拆成多次调用（`_parse`
 * 的注释就是为分片写的）。取 32KB（远低于阈值，留足余量），实测 4MB 的突发放进分片也不炸。
 */
const ZMODEM_CONSUME_SLICE = 32 * 1024

export function consumeZmodemChunk(
  bytes: Uint8Array,
  consume: (bytes: Uint8Array) => void,
  onError: (error: unknown) => void
): void {
  try {
    if (bytes.length <= ZMODEM_CONSUME_SLICE) {
      consume(bytes)
      return
    }
    for (let off = 0; off < bytes.length; off += ZMODEM_CONSUME_SLICE) {
      consume(bytes.subarray(off, Math.min(off + ZMODEM_CONSUME_SLICE, bytes.length)))
    }
  } catch (error) {
    onError(error)
  }
}

/**
 * 主动中止序列：`5 × CAN(0x18)` + `5 × BS(0x08)`，与 zmodem.js 的 `Session.abort()` 逐字节同款
 * （见 `node_modules/zmodem.js/src/zsession.js` 的 abort 注释：协议只要求 5 个 CAN，尾随的 BS
 * 是用来「擦掉」CAN 被命令解释器接收后留下的痕迹）。
 *
 * 用途：会话**已经**异常结束、`zsessionRef` 被清空时，我们手上没有 Session 对象可调 `abort()`，
 * 但仍要把这串字节直接写回 PTY，让远端那个还在猛发的 `sz` 停手。`0x18` 同时是 ZDLE。
 */
export const ZMODEM_ABORT_SEQUENCE: Uint8Array = new Uint8Array([
  0x18, 0x18, 0x18, 0x18, 0x18, 0x08, 0x08, 0x08, 0x08, 0x08
])

/**
 * 「异常结束后的排水窗口」。
 *
 * 为什么需要它：zmodem.js 的 `Sentry.consume()` 在会话结束后会把**之后每一个入站字节**都
 * 无条件交给 `to_terminal`（`zsentry.js` 的 consume 末尾）。会话一旦**异常**结束，远端可能还在
 * 按 ZMODEM 协议猛发文件字节，这些字节会被当成终端文本刷屏，而且此时 `zsessionRef` 已清空、
 * 中止也发不出去 —— 用户只能关终端。
 *
 * 这个窗口做两件事：异常收尾时 `engage()` 进入排水态，窗口期内到达的字节一律**丢弃**（`absorb`
 * 返回 true），直到链路安静下来（`quietElapsed`，由外部定时器收尾）或撞到硬上限 `capMs`
 * （自动解除，绝不永久吞字节）。正常结束不会 engage，`absorb` 恒为 false，行为与从前一致。
 */
export interface PostAbortDrain {
  /** 进入排水态（异常收尾时调用）；重复调用以最后一次为准 */
  engage(now: number): void
  /** 退出排水态 */
  disengage(): void
  /**
   * 每收到一块字节调用一次。返回 true = 这块要丢弃（不写终端）；返回 false = 正常放行。
   * 排水期内会刷新「最后活动时间」；超过硬上限 `capMs` 自动解除并放行。
   */
  absorb(now: number): boolean
  /** 链路已安静 `quietMs`（可以收尾了）——仅在排水态下为真 */
  quietElapsed(now: number): boolean
  /** 当前是否在排水态 */
  readonly isActive: boolean
}

export function createPostAbortDrain(quietMs: number, capMs: number): PostAbortDrain {
  let active = false
  let engagedAt = 0
  let lastActivity = 0

  return {
    engage(now: number): void {
      active = true
      engagedAt = now
      lastActivity = now
    },
    disengage(): void {
      active = false
    },
    absorb(now: number): boolean {
      if (!active) return false
      // 硬上限：排水太久说明链路压根没安静（对端没听中止序列 / 通道异常），
      // 到点就放手，宁可放行也不能永远吞字节。
      if (now - engagedAt >= capMs) {
        active = false
        return false
      }
      lastActivity = now
      return true
    },
    quietElapsed(now: number): boolean {
      return active && now - lastActivity >= quietMs
    },
    get isActive(): boolean {
      return active
    }
  }
}
