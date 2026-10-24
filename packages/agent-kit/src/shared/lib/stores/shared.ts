/**
 * store 各 slice 共用的小工具。刻意不 import 任何 store 模块 ——
 * slice 会运行时引它，引 store 会造成环。
 */

/** 统一错误文案（ApiError 的 message 就是服务端给的 `{ error }` 原话） */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

let localId = 0
/** 本地临时 id（占位消息 / 队列项用；服务端落盘的是另一套时间戳 id） */
export function nextLocalId(prefix: string): string {
  localId += 1
  return `${prefix}-local-${Date.now()}-${localId}`
}
