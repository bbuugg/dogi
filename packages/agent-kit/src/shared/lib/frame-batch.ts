/**
 * 流式帧合批（客户端侧）。
 *
 * ⚠️ **为什么需要它**：一条流式回复是「一 token 一帧」来的（实测 200 tok/s = 200 帧/秒），
 * 而每一帧都会走 `handleFrame` → `writeSlice` → `useAgentApp` 的整店订阅 → **整棵应用树重渲**。
 *
 * web 端之所以看着不卡，是**网络栈帮它合批了**：服务端逐帧写 socket，TCP / 浏览器读缓冲
 * 把好几帧并进一次 `for await`，多帧因此落在**同一个微任务**里，React 18 自动合批成一次渲染。
 * 桌面端走的是**进程内 IPC 直通**（`packages/agent-host/src/transport-ipc.ts` 的 `pump`：
 * 一个 chunk 一条 IPC 消息），每帧各占一个独立任务，**没有可合批的余地** —— 于是 200 帧/秒
 * 就是 200 次整树渲染/秒，主线程被占满，连折叠动画（`use-stick-to-bottom` 的 spring 是
 * JS 逐帧写 scrollTop 的）都跟着卡。
 *
 * 这里补上客户端自己的合批：把帧攒到下一个动画帧，**在同一个同步块里**一次性落进 store，
 * 渲染上限因此从「帧率」变成「刷新率」（≤60 次/秒），两端同受益。
 *
 * 合并是**等价**的：delta 是纯字符串拼接，合并后 `applyEvent` 出来的 parts 完全一致
 * —— 服务端的 `compactFrames`（`apps/server/src/server/chat-run.ts`）用的是同一套判据，
 * 两处必须保持等价（否则「直播合并」与「重连回放合并」会产出不同的 parts）。只合并
 * **相邻且同类型同目标**的 delta，帧的顺序与语义都不变。
 */
import type { ChatStreamFrame } from '@fizz/contracts/agent-api'

/** 一次合批最多攒多久（ms）。~16ms ≈ 一帧，把渲染压到 ≤60 次/秒 */
const FLUSH_MS = 16

/**
 * 缓冲上限：隐藏窗口 / 后台标签页里 `requestAnimationFrame` 会被冻结，靠它兜底保证缓冲
 * 不会无限增长。delta 会被**就地合并**，所以正常情况根本到不了这个数 —— 只有「很多种
 * 帧交替到达」才可能攒起来。
 */
const MAX_BUFFERED = 256

/**
 * 两个帧能不能合并成一帧（相邻、同类型、同目标）。不能合并返回 `null`。
 *
 * 判据与服务端 `compactFrames` 逐条对齐：`text-delta` / `reasoning-delta` 无条件相邻合并，
 * 两个工具增量还要 `toolCallId`（输出增量再加 `stream`）相同。
 */
export function mergeDeltaFrames(
  prev: ChatStreamFrame,
  next: ChatStreamFrame
): ChatStreamFrame | null {
  const a = prev.event
  const b = next.event
  if (!a || !b) return null

  if (a.type === 'text-delta' && b.type === 'text-delta') {
    return { ...prev, event: { type: 'text-delta', delta: a.delta + b.delta } }
  }
  if (a.type === 'reasoning-delta' && b.type === 'reasoning-delta') {
    return { ...prev, event: { type: 'reasoning-delta', delta: a.delta + b.delta } }
  }
  if (
    a.type === 'tool-call-delta' &&
    b.type === 'tool-call-delta' &&
    a.toolCallId === b.toolCallId
  ) {
    const toolName = a.toolName ?? b.toolName
    return {
      ...prev,
      event: {
        type: 'tool-call-delta',
        toolCallId: b.toolCallId,
        ...(toolName ? { toolName } : {}),
        inputTextDelta: a.inputTextDelta + b.inputTextDelta
      }
    }
  }
  if (
    a.type === 'tool-output-delta' &&
    b.type === 'tool-output-delta' &&
    a.toolCallId === b.toolCallId &&
    a.stream === b.stream
  ) {
    return {
      ...prev,
      event: {
        type: 'tool-output-delta',
        toolCallId: b.toolCallId,
        stream: b.stream,
        delta: a.delta + b.delta
      }
    }
  }
  return null
}

export interface FrameBatcher {
  /** 收一帧。delta 就地合并、其余按序排队；到点（或攒满）统一冲给 sink */
  push(frame: ChatStreamFrame): void
  /**
   * 立刻把缓冲落给 sink（幂等）。
   *
   * ⚠️ 流结束 / 收场之前**必须**调一次：不调的话尾巴要等 16ms 的定时器才落，而收场逻辑
   * （`settleRound` 等）可能紧接着就读消息列表 —— 会看到「少一截」的现场。
   */
  flush(): void
}

/**
 * 建一个合批器。`sink` 会在**同一个同步块**里收到这一批全部帧 —— React 18 因此把它们
 * 合批成一次渲染，这正是本模块存在的理由。
 */
export function createFrameBatcher(sink: (frame: ChatStreamFrame) => void): FrameBatcher {
  let buffer: ChatStreamFrame[] = []
  let rafId: number | null = null
  let timerId: ReturnType<typeof setTimeout> | null = null

  const cancelScheduled = (): void => {
    if (rafId !== null) {
      cancelAnimationFrame(rafId)
      rafId = null
    }
    if (timerId !== null) {
      clearTimeout(timerId)
      timerId = null
    }
  }

  const flush = (): void => {
    cancelScheduled()
    if (buffer.length === 0) return
    const pending = buffer
    buffer = []
    for (const frame of pending) sink(frame)
  }

  const schedule = (): void => {
    if (rafId !== null || timerId !== null) return
    // 优先对齐动画帧：一次刷新最多落一次，观感最顺
    if (typeof requestAnimationFrame === 'function') {
      rafId = requestAnimationFrame(() => {
        rafId = null
        flush()
      })
    }
    /*
     * 兜底定时器：rAF 在隐藏窗口 / 后台标签页里会被冻结，而帧还在继续来 —— 没有它缓冲
     * 就只会增长，用户切回来才会一次性看到全部内容（中间那段时间界面是静止的）。
     * 两个 handle 谁先到谁 flush，另一个被 `cancelScheduled` 清掉。
     */
    timerId = setTimeout(() => {
      timerId = null
      flush()
    }, FLUSH_MS)
  }

  return {
    push(frame) {
      const last = buffer[buffer.length - 1]
      const merged = last === undefined ? null : mergeDeltaFrames(last, frame)
      if (merged) buffer[buffer.length - 1] = merged
      else buffer.push(frame)
      if (buffer.length >= MAX_BUFFERED) {
        flush()
        return
      }
      schedule()
    },
    flush
  }
}
