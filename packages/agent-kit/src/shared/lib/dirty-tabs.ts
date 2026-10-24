/**
 * 「改了还没保存」的标签 —— 应用级的一份计数，给**退出拦截**用。
 *
 * ## 为什么是模块级的
 *
 * 两个消费方隔着好几层：登记方是标签内容里的 `MarkdownEditor`，消费方是桌面端主进程的
 * `before-quit`（要靠 `AgentHost.setDirtyTabCount` 推过去）。中间没有现成的链路能传，
 * 所以这里当**唯一真源**，由 `app-shell` 订阅数量并外推。
 *
 * ## 为什么不用 state / context
 *
 * 标签内容是**全常驻挂载**的（切标签不卸载、流式期间还经常整树重渲染），用 context 会把
 * 「敲一个字」放大成整棵树的渲染。这里只需要一个**数字**，所以走 `useSyncExternalStore`：
 * 快照是原始值，React 用 `Object.is` 比，数字不变就不会重渲染。
 *
 * ## 谁是「脏」的
 *
 * 只有**手动保存**的编辑器才登记（笔记 / 外部文件）。自动保存的东西（主机脚本的编辑器）
 * 没有「未保存」这个态，不该进这里 —— 否则退出时会被拦下来问一句根本不存在的事。
 */
import { useSyncExternalStore } from 'react'

/** 脏标签的 key（与 `panel-tabs` 的标签 key 同一口径） */
const dirty = new Set<string>()
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

/** 标记某个标签有未保存的修改（幂等：已经是脏的就不再通知一遍） */
export function markTabDirty(key: string): void {
  if (dirty.has(key)) return
  dirty.add(key)
  emit()
}

/** 撤销某个标签的脏标记（保存成功、或标签被关掉时调） */
export function markTabClean(key: string): void {
  if (!dirty.delete(key)) return
  emit()
}

export function getDirtyTabCount(): number {
  return dirty.size
}

export function subscribeDirtyTabs(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** 订阅脏标签数量（`useSyncExternalStore` 的 getSnapshot 直接复用 `getDirtyTabCount`） */
export function useDirtyTabCount(): number {
  return useSyncExternalStore(subscribeDirtyTabs, getDirtyTabCount, getDirtyTabCount)
}
