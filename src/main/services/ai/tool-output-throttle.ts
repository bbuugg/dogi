/**
 * 命令**实时输出增量**的节流器（对齐 fishwork 的 `tool-output-delta`，与
 * `tool-input-throttle.ts` 同一套写法）。
 *
 * 为什么要攒：子进程的 stdout / stderr 是按管道可读块到达的，一行日志可能被切成好几帧，
 * 长命令（构建 / 测试 / `tail -f`）会持续吐出成百上千帧。每帧都走一趟 IPC 广播 + 一次
 * React 更新，不攒一下会把带宽与渲染主线程白白吃掉。所以攒够字符数或攒够时间才下发一帧
 * （60ms 与入参增量同一阈值，是「肉眼仍觉得连续」的下限）。
 *
 * ⚠️ **不是「发不发」的开关，是「什么时候发」的开关**：调用方必须在**任何非增量事件
 * （尤其 `tool-result`）之前先 `flush()`** —— 否则这一条命令的尾部增量会排到它自己的结果
 * 之后，前端那份「运行中的实时输出」就永远停在收口前一刻（而结果已经换上了）。
 * `agent.ts` 里包了一层 `send()` 统一做这件事，别绕过它直接 `emitEvent`。
 *
 * ⚠️ 同时只攒**一条**增量：stdout / stderr 交替到达时按「换了 key 就先结掉上一条」处理。
 * 这两条流在界面上本来就是分开存的，先后顺序不影响最终观感，但**必须保序下发**，
 * 否则前端按到达顺序拼出来的行会错位。
 */

/** 一次「下发」的增量形状（与 `@shared/types` 的 `tool-output-delta` 同名字段一致） */
export interface ToolOutputDelta {
  toolCallId: string
  stream: 'stdout' | 'stderr'
  delta: string
}

/** 攒够这么多字符就下发一帧 */
const FLUSH_CHARS = 240
/** 距上次下发超过这么久就下发一帧（哪怕只攒到一个字符） */
const FLUSH_MS = 60

/** 节流器：`push` 增量、`flush` 立即把攒着的尾巴结掉 */
export interface ToolOutputThrottle {
  push: (delta: ToolOutputDelta) => void
  flush: () => void
}

/**
 * 造一个节流器。`onFlush` 是**真正下发**的那一步（服务层在这里包成 `tool-output-delta`）。
 *
 * 首帧会立刻下发（`lastFlushAt` 从 0 起算，时间差必然超阈值）—— 刻意的：命令一开始
 * 吐东西，界面上就该马上看到第一行，不用等 60ms。
 */
export function createToolOutputThrottle(
  onFlush: (delta: ToolOutputDelta) => void
): ToolOutputThrottle {
  /** 攒着的增量（null = 没有） */
  let pending: ToolOutputDelta | null = null
  /** 上一次下发的时刻（节流的时间基准） */
  let lastFlushAt = 0

  const flush = (): void => {
    if (!pending) return
    const delta = pending
    pending = null
    lastFlushAt = Date.now()
    onFlush(delta)
  }

  const push = (delta: ToolOutputDelta): void => {
    // 换了工具 / 换了流：上一条的尾巴先结掉（不同 key 的增量不能拼在一起）
    if (pending && (pending.toolCallId !== delta.toolCallId || pending.stream !== delta.stream)) {
      flush()
    }
    pending = {
      toolCallId: delta.toolCallId,
      stream: delta.stream,
      delta: (pending?.delta ?? '') + delta.delta
    }
    if (pending.delta.length >= FLUSH_CHARS || Date.now() - lastFlushAt >= FLUSH_MS) {
      flush()
    }
  }

  return { push, flush }
}
