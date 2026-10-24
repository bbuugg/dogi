/**
 * WS 下行合批（**纯逻辑，零依赖** —— 刻意不 import electron）。
 *
 * 为什么单独成文件：`transport-ipc.ts` 顶部就 `import { ipcMain } from 'electron'`，
 * 于是那段合批逻辑没法被验证脚本直接跑 —— 只能**抄一份**到测试里，而「测试跑的是副本」
 * 正是本仓库反复吃亏的那类问题（抄的那份会跟真的那份悄悄漂走，然后测试全绿、
 * 真代码是坏的）。拆出来之后 `scripts/verify-ws-batch.mjs` 跑的就是**这份真代码**。
 *
 * ## 为什么需要它
 *
 * 主进程代连 WS 时，`socket.onmessage` 是**一帧一条 IPC 消息**。一次 `ls -la` /
 * `tail -f` / 构建输出能吐几百上千帧，于是几百上千次 `webContents.send`：每次都要过
 * 序列化 + IPC + 渲染端 `onWsData` 回调。对比对话流 —— 它早就有客户端合帧
 * （`@fizz/agent-kit` 的 `shared/lib/frame-batch.ts`），**WS 这条路是唯一的缺口**。
 *
 * ## 只合并**二进制**帧，文本帧照原样单发
 *
 * 两类帧的语义完全不同，合批判据也就不同：
 * - **二进制** = 终端字节流。xterm 收到 `A`、`B`、`AB` 画出来完全一样 → 可**相邻合并**（无损）。
 * - **文本** = 一条完整 JSON（状态推送 / 工作台事件）。两段 JSON 拼起来是**语法错误**
 *   → 一律**不合并**；但仍要先冲掉在攒的二进制，否则顺序就错了（终端会花）。
 *
 * ## 收尾必须 flush
 *
 * 关闭时缓冲区里可能还压着尾巴，不冲就是**丢数据**（现象：终端最后几行不见了）。
 * `flush` 幂等，所以三处收尾都无脑调它。
 */

/** 一次合批最多攒多久（ms）。~16ms ≈ 一帧 */
export const WS_FLUSH_MS = 16

/**
 * 缓冲上限：攒到这么多字节就**立刻**冲掉，不等定时器。
 *
 * 取 4MB 是「宁可勤冲一点也别让内存涨」的量级：PTY 一次吐 64KB、WS 单帧最大 64KB，
 * 正常情况下一轮定时器早就到点了；攒到 4MB 只可能是定时器被排到后面去了。
 */
export const WS_FLUSH_BYTES = 4 * 1024 * 1024

/** 缓冲里的一条待发内容：只有二进制会进缓冲，文本直接发 */
interface WsPending {
  /** 攒着的二进制帧（**相邻**才合并） */
  bytes: Uint8Array | null
  /** 已排队的冲刷定时器（null = 当前没有待冲的缓冲） */
  timer: ReturnType<typeof setTimeout> | null
}

export interface WsBatcherOptions {
  /**
   * 一条下行帧进来。文本帧会被**立刻**发出；二进制进缓冲，到点（或攒满）才发。
   */
  onSend: (streamId: string, data: string | Uint8Array) => void
  /** 排冲刷定时器；默认 `setTimeout(fn, ms)`。测试注入成「永不自己触发」以便手动 flush */
  schedule?: (fn: () => void, ms: number) => unknown
  /** 取消冲刷定时器；默认 `clearTimeout` */
  cancel?: (handle: unknown) => void
}

export interface WsBatcher {
  push: (streamId: string, data: string | Uint8Array) => void
  /** 立刻把缓冲落出去（幂等）。**收尾必须调**，否则丢尾巴 */
  flush: (streamId: string) => void
  /** 当前有几条连接有缓冲（测试与排障用） */
  pendingCount: () => number
}

export function createWsBatcher(opts: WsBatcherOptions): WsBatcher {
  const schedule = opts.schedule ?? ((fn, ms) => setTimeout(fn, ms))
  const cancel = opts.cancel ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>))
  const pending = new Map<string, WsPending>()

  const flush = (streamId: string): void => {
    const p = pending.get(streamId)
    if (!p) return
    pending.delete(streamId)
    if (p.timer !== null) {
      cancel(p.timer)
      p.timer = null
    }
    const bytes = p.bytes
    p.bytes = null
    if (!bytes || bytes.length === 0) return
    opts.onSend(streamId, bytes)
  }

  const push = (streamId: string, data: string | Uint8Array): void => {
    // 文本帧：一条完整消息，不能与任何东西拼。先冲掉在攒的二进制（保序），再原样发。
    if (typeof data === 'string') {
      flush(streamId)
      opts.onSend(streamId, data)
      return
    }

    let p = pending.get(streamId)
    if (!p) {
      p = { bytes: null, timer: null }
      pending.set(streamId, p)
    }

    if (p.bytes) {
      // 相邻二进制合并成一条（字节流拼接无损）
      const merged = new Uint8Array(p.bytes.length + data.length)
      merged.set(p.bytes, 0)
      merged.set(data, p.bytes.length)
      p.bytes = merged
    } else {
      // ⚠️ 必须**复制**：`msg.data` 是 undici 给的 ArrayBuffer，`new Uint8Array(...)`
      //    只是**视图**。攥着它等到下一帧才拼，期间那段内存归 undici 管 —— 它一旦复用
      //    就是脏数据，症状是「终端偶尔冒出乱码」，极难定位。slice() 才真的拷。
      p.bytes = data.slice()
    }

    // 攒够了不等定时器（内存优先于那几毫秒延迟）
    if (p.bytes.length >= WS_FLUSH_BYTES) {
      flush(streamId)
      return
    }
    // 已经有定时器在排队就别再排（每帧一个定时器会把冲刷次数变成帧数，等于没合）
    if (p.timer !== null) return
    p.timer = schedule(() => {
      // 定时器已触发，句柄作废 —— 否则 flush 会去 cancel 一个已经跑过的句柄
      const cur = pending.get(streamId)
      if (cur) cur.timer = null
      flush(streamId)
    }, WS_FLUSH_MS) as ReturnType<typeof setTimeout>
  }

  return { push, flush, pendingCount: () => pending.size }
}