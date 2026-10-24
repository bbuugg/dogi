/**
 * 「新建请求草稿」的初始种子（内存态，不落盘）。
 *
 * 用途只有一个：把**历史记录**里的一条请求载入成一个未保存的新草稿 —— 侧栏点历史行时
 * 先 `setApiDraftSeed(entry)`、再开草稿标签，`ApiPage` 挂载时 `takeApiDraftSeed()` 取走它
 * 作为初始值。
 *
 * 为什么用模块级变量而不是 store 字段：它是**转瞬即逝**的（读一次即弃），且草稿标签
 * 同一时刻只有一个（哨兵 id 复用），不需要跨窗口同步 —— 塞进 store 只会多一份
 * 「什么时候清」的记账。
 *
 * ## 为什么还要一套订阅（版本号）
 *
 * 草稿标签是**复用同一个 key** 的：用户点历史 A（开出草稿标签）、再点历史 B 时，
 * `openApiDraftTab()` 只是把已有标签切到前台，**组件不重挂**，靠 `requestId` 变化的
 * effect 不会重跑 —— 那样第二条历史就载不进去了。所以这里带一个自增版本号 +
 * 订阅：`ApiPage` 用 `useSyncExternalStore` 盯它，每次 `setApiDraftSeed` 自增即触发
 * 「取种子并载入」。版本号只增不减（`takeApiDraftSeed` 清空的是种子，不是版本）。
 */
import type { ApiHistoryEntry } from '@fizz/contracts/types'

let seed: ApiHistoryEntry | null = null
let version = 0
const listeners = new Set<() => void>()

/** 记下一条待载入的历史（开草稿标签前调用）；同时通知已挂载的草稿页 */
export function setApiDraftSeed(entry: ApiHistoryEntry): void {
  seed = entry
  version++
  for (const listener of listeners) listener()
}

/** 订阅种子变化（`useSyncExternalStore` 用） */
export function subscribeApiDraftSeed(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** 当前版本号（`useSyncExternalStore` 的 getSnapshot；服务端渲染兜底返回 0） */
export function apiDraftSeedVersion(): number {
  return version
}

/**
 * 取走待载入的历史（读一次即清空，避免下次开草稿又被旧种子覆盖）。
 * 没有种子时返回 null。
 */
export function takeApiDraftSeed(): ApiHistoryEntry | null {
  const s = seed
  seed = null
  return s
}