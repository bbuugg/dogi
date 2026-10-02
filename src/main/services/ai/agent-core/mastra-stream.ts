/**
 * Mastra 流 chunk → 应用自己的流事件（工作区 Agent 与终端 AI 助手**共用一份**）。
 *
 * ## 为什么需要这一层，而不是把 Mastra 的 chunk 直接给 UI / store
 *
 * 1. **契约是自家的**：UI / store / 落盘用的是 `@shared/types` 的 `AgentStreamEvent` /
 *    `AiStreamEvent`，那是应用自己的事件形状；Mastra 的 `fullStream` chunk 是它内部
 *    编排层用的形状，两者不是一回事。
 * 2. **抵御版本漂移**：Mastra 的字段名 / 嵌套跨版本变过（v1 把数据放进 `payload`；
 *    不同 AI SDK 版本 `text` / `textDelta` / `delta` 命名不一）。这里做防御式取值 ——
 *    升级只改这一处，不会让 UI 静默丢内容。
 * 3. **多后端归一**：ACP 外部 agent（Claude Code 等）产出的是同一套事件，
 *    渲染层只写一套逻辑的前提，就是每条后端都先适配到这个公共形状。
 *
 * ## ⚠️ error 分支把原始错误「拍平」成一句 message
 *
 * UI 只需要一句话，但 `isRetryable` / `statusCode` / `code` 这些**原始错误上的信息会丢**。
 * 主进程要做重试判定时，请直接从 chunk 的 `payload.error` 取原始对象（见 agent.ts / ai.ts 的
 * `runStreamWithRetry`），不要指望这个返回值。
 */
import { describeError } from '../error-utils'

/**
 * 适配产出的公共事件。
 *
 * 刻意做成 `@shared/types` 两个事件联合的**公共子集**：这样两个后端都能直接 `emitEvent`，
 * 不需要各自再收窄一次。
 */
export type MastraAdaptedEvent =
  | { type: 'text-delta'; delta: string }
  | { type: 'reasoning-delta'; delta: string }
  /**
   * 工具入参的流式增量（形状见 `@shared/types` 的同名事件）。
   *
   * ⚠️ 这里只做**形状转换**，下发节奏由调用方的节流器管（见 `../tool-input-throttle`）——
   * 上游把写文件这类入参拆成成百上千帧，逐帧直发会把 IPC 与渲染主线程吃掉。
   */
  | {
      type: 'tool-call-delta'
      toolCallId: string
      toolName?: string
      inputTextDelta: string
    }
  | { type: 'tool-call'; toolCallId: string; toolName: string; input: unknown }
  | {
      type: 'tool-result'
      toolCallId: string
      toolName: string
      output: unknown
      isError?: boolean
    }
  | { type: 'error'; message: string }

/**
 * 将 Mastra 流事件转换为 Agent/Ai 流事件。
 *
 * Mastra 的 fullStream 块为 `{ type, payload: {...} }` 形态（文本 / 思考在 `payload.text`，
 * 工具在 `payload.{toolCallId,toolName,args/result}`），这里同时兼容 AI SDK 原生形态做兜底。
 */
export function adaptMastraPart(part: {
  type?: string
  payload?: {
    text?: unknown
    toolCallId?: unknown
    toolName?: unknown
    args?: unknown
    input?: unknown
    result?: unknown
    output?: unknown
    error?: unknown
    /** 工具入参增量（`tool-call-delta`）：Mastra 放 argsTextDelta */
    argsTextDelta?: unknown
    inputTextDelta?: unknown
  }
  [k: string]: unknown
}): MastraAdaptedEvent | null {
  const payload = part.payload
  const str = (v: unknown) => (v == null ? '' : String(v))
  switch (part.type) {
    case 'text':
    case 'text-delta':
      return {
        type: 'text-delta',
        delta: str(payload?.text ?? part.text ?? part.textDelta ?? part.delta)
      }
    case 'reasoning':
    case 'reasoning-delta': {
      const delta = str(payload?.text ?? part.reasoning ?? part.text ?? part.textDelta ?? part.delta)
      // 起止标记（reasoning-start / reasoning-end）没有内容，返回 null 让调用方忽略
      return delta ? { type: 'reasoning-delta', delta } : null
    }
    /**
     * 「入参开始流式生成」：只有 id + 工具名，还没有内容（Mastra 1.x 的
     * `tool-call-input-streaming-start`）。转成一条**空增量** —— 卡片据此先建出来，
     * 标题立刻是对的（否则要等完整 tool-call，卡片会先显示一会儿「工具调用」）。
     */
    case 'tool-call-input-streaming-start':
      return {
        type: 'tool-call-delta',
        toolCallId: str(payload?.toolCallId ?? part.toolCallId),
        ...(payload?.toolName ?? part.toolName
          ? { toolName: str(payload?.toolName ?? part.toolName) }
          : {}),
        inputTextDelta: ''
      }
    /**
     * 入参的流式增量（Mastra 1.x：`{ type:'tool-call-delta', payload:{ toolCallId, argsTextDelta } }`）。
     *
     * 字段名同其它分支一样做防御式取值：增量帧**常常不给工具名**（只在完整 tool-call 里给），
     * 所以工具名是「有才带」而不是塞空串 —— 否则会把先到的真名盖掉。
     */
    case 'tool-call-delta':
      return {
        type: 'tool-call-delta',
        toolCallId: str(payload?.toolCallId ?? part.toolCallId),
        ...(payload?.toolName ?? part.toolName
          ? { toolName: str(payload?.toolName ?? part.toolName) }
          : {}),
        inputTextDelta: str(
          payload?.argsTextDelta ?? part.argsTextDelta ?? payload?.inputTextDelta ?? part.inputTextDelta
        )
      }
    case 'tool-call':
      return {
        type: 'tool-call',
        toolCallId: str(payload?.toolCallId ?? part.toolCallId),
        toolName: str(payload?.toolName ?? part.toolName),
        input: (payload?.args ?? payload?.input ?? part.args ?? part.input ?? null) as unknown
      }
    case 'tool-result':
      return {
        type: 'tool-result',
        toolCallId: str(payload?.toolCallId ?? part.toolCallId),
        toolName: str(payload?.toolName ?? part.toolName),
        output: (payload?.result ?? payload?.output ?? part.result ?? part.output ?? null) as unknown,
        // 有的版本把失败也塞在 tool-result 里（带 isError），一并认下来，
        // 否则那行会显示成「已完成」而不是「失败」
        ...((payload as { isError?: unknown } | undefined)?.isError === true ||
        (part as { isError?: unknown }).isError === true
          ? { isError: true }
          : {})
      }
    /**
     * 工具**抛错**时 mastra 发的不是 `tool-result` 而是 `tool-error`。
     *
     * 漏掉这一个分支的代价很直观：块落到 default 被丢掉 → 那条工具行永远停在「调用中」，
     * 后面几步都跑完了它还转圈（读取不存在的文件、路径是目录… 这类报错最容易碰到）。
     */
    case 'tool-error':
      return {
        type: 'tool-result',
        toolCallId: str(payload?.toolCallId ?? part.toolCallId),
        toolName: str(payload?.toolName ?? part.toolName),
        output: `工具执行失败: ${describeError(payload?.error ?? part.error)}`,
        isError: true
      }
    case 'error':
      return { type: 'error', message: describeError(payload?.error ?? part.error) }
    default:
      return null
  }
}
