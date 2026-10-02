/**
 * 工具**入参增量**的节流器（工作区 Agent 与终端 AI 助手共用一份）。
 *
 * 上游（Mastra 的 `tool-call-delta` / `argsTextDelta`）一边生成工具入参一边发增量，
 * 写文件这类调用入参数 KB 起、会被拆成成百上千帧，**比正文的 text-delta 还密**
 * （provider 至少会对正文做一次聚合）。每帧都走一趟 IPC 广播 + 一次 React 更新，
 * 不攒一下会把带宽和渲染主线程白白吃掉，所以攒够字符数或攒够时间才下发一帧
 * （60ms 是「肉眼仍觉得是连续的」下限）。
 *
 * ⚠️ **不是「发不发」的开关，是「什么时候发」的开关**：调用方必须保证
 * **任何非增量事件之前先 `flush()`** —— 同一个 toolCallId 的增量必须全部排在它自己的
 * 完整 `tool-call` / `tool-result` 之前，否则前端会把「已经收口的 input」又用旧增量盖回去。
 * 两个服务里都包了一层 `send()` 统一做这件事，别绕过它直接 `emitEvent`。
 */

/** 一次「下发」的增量形状（与 `@shared/types` 两个流事件里的同名字段一致） */
export interface ToolInputDelta {
  toolCallId: string
  /** 增量帧常常不带工具名：带了才往下传，别塞空串把先到的真名盖掉 */
  toolName?: string
  inputTextDelta: string
}

/** 攒够这么多字符就下发一帧 */
const FLUSH_CHARS = 240
/** 距上次下发超过这么久就下发一帧（哪怕只攒到一个字符） */
const FLUSH_MS = 60

/** 节流器：`push` 增量、`flush` 立即把攒着的尾巴结掉 */
export interface ToolInputThrottle {
  push: (delta: ToolInputDelta) => void
  flush: () => void
}

/**
 * 造一个节流器。`onFlush` 是**真正下发**的那一步（各服务在这里包成自己的流事件）。
 *
 * 首帧会立刻下发（`lastFlushAt` 从 0 起算，时间差必然超阈值）—— 刻意的：
 * 「入参开始流式生成」那一帧（空增量）先把卡片建出来，标题马就是对的；
 * 也让用户点完发送不用等 60ms 才看到第一张卡。
 */
export function createToolInputThrottle(
  onFlush: (delta: ToolInputDelta) => void
): ToolInputThrottle {
  /** 攒着的增量（null = 没有） */
  let pending: ToolInputDelta | null = null
  /** 上一次下发的时刻（节流的时间基准） */
  let lastFlushAt = 0

  const flush = (): void => {
    if (!pending) return
    const delta = pending
    pending = null
    lastFlushAt = Date.now()
    onFlush(delta)
  }

  const push = (delta: ToolInputDelta): void => {
    // 换了工具：上一个的尾巴先结掉（不同 id 的增量不能拼在一起）
    if (pending && pending.toolCallId !== delta.toolCallId) flush()
    const toolName = pending?.toolName ?? delta.toolName
    pending = {
      toolCallId: delta.toolCallId,
      ...(toolName ? { toolName } : {}),
      inputTextDelta: (pending?.inputTextDelta ?? '') + delta.inputTextDelta
    }
    if (
      pending.inputTextDelta.length >= FLUSH_CHARS ||
      Date.now() - lastFlushAt >= FLUSH_MS
    ) {
      flush()
    }
  }

  return { push, flush }
}
