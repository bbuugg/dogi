/**
 * 应用内自动更新的渲染端底座：把宿主桥的状态收成**一份模块级订阅**，
 * 供设置页的「软件更新」分区、状态栏菜单上的徽章、以及应用内提示共用。
 *
 * ## 为什么不让每个组件各自订阅
 *
 * 三个消费点（设置分区 / 徽章 / 提示）都关心同一份状态，各自 `onStatus` 一遍就是
 * 三份 IPC 监听 + 三份初始快照请求（`status()`），而且它们对「下载中」的理解必然
 * 漂移。这里收成单例：**只在第一个订阅者出现时**绑一次宿主桥，之后谁用谁读。
 *
 * ## 惰性绑定
 *
 * 宿主是 `setAgentHost()` 在 render 之前注入的，但本模块可能在更早（导入时）就被
 * 求值 —— 所以不在模块顶层读宿主，而是在**第一个订阅者出现时**才去取。
 * 没实现 `appUpdate` 的宿主（web）就永远不绑，`useAppUpdateStatus()` 恒为 null。
 *
 * ⚠️ 与 dogi 一样，这里**没有「自动下载」**：`available` 只是「有新版本、等你点」。
 * 三个消费点都只负责展示与转发用户的点击，别在这里自动调 `download()`。
 */
import { useSyncExternalStore } from 'react'
import { getAgentHostOrNull, type AppUpdateStatus } from '@fizz/agent-client/host'

/** 最近一次拿到的状态快照；null = 还没拿到（或宿主没这个能力） */
let current: AppUpdateStatus | null = null

const listeners = new Set<() => void>()

/** 宿主桥的退订函数；非 null 表示已经绑过了（只绑一次） */
let unsubscribe: (() => void) | null = null

function emit(): void {
  for (const listener of listeners) listener()
}

function setCurrent(next: AppUpdateStatus): void {
  current = next
  emit()
}

function bind(): void {
  if (unsubscribe) return
  const bridge = getAgentHostOrNull()?.appUpdate
  if (!bridge) return

  unsubscribe = bridge.onStatus(setCurrent)
  /**
   * 首帧补一次快照：状态变化是**广播**给所有窗口的，而这个窗口可能是新开的
   * （设置窗口）—— 它错过了之前那几次广播，不补的话要等下一次状态变化才有内容。
   * 失败（主进程没起来 / 通道异常）就当没有状态，界面退化成不显示。
   */
  void bridge
    .status()
    .then(setCurrent)
    .catch(() => undefined)
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  bind()
  return () => {
    listeners.delete(listener)
  }
}

/**
 * 订阅更新状态（没实现 `appUpdate` 的宿主恒为 null，界面据此整块不渲染）。
 *
 * 注意返回的是**同一份对象引用**直到状态真的变了 —— `useSyncExternalStore` 要求如此。
 */
export function useAppUpdateStatus(): AppUpdateStatus | null {
  return useSyncExternalStore(subscribe, () => current, () => null)
}

/**
 * 宿主有没有「应用内更新」这个能力。**非响应式**（宿主注入后不会变），
 * 用来决定设置页要不要渲染整个分区 —— 渲染了再等 status 回来会让分区闪一下。
 */
export function appUpdateAvailable(): boolean {
  return !!getAgentHostOrNull()?.appUpdate
}

/** 手动检查一次（失败文案会随状态回来，不用在这里 catch） */
export async function checkAppUpdate(): Promise<void> {
  await getAgentHostOrNull()?.appUpdate?.check().catch(() => undefined)
}

/** 开始下载已发现的新版本 —— **只有用户点了才调** */
export async function downloadAppUpdate(): Promise<void> {
  await getAgentHostOrNull()?.appUpdate?.download().catch(() => undefined)
}

/** 取消正在进行的下载（回到「待下载」，可重来） */
export async function cancelAppUpdate(): Promise<void> {
  await getAgentHostOrNull()?.appUpdate?.cancel().catch(() => undefined)
}

/** 退出并安装已下载的更新；返回 false = 当前没有可安装的更新（主进程会拒绝） */
export async function installAppUpdate(): Promise<boolean> {
  const bridge = getAgentHostOrNull()?.appUpdate
  if (!bridge) return false
  return bridge.install().catch(() => false)
}
