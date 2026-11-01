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
 *
 * ## 「提醒」与「状态」是两件事
 *
 * 文件末尾那个 `useUpdateNotifyEnabled()` 是**要不要打扰用户**的开关：关掉之后
 * 徽章与 toast 都不出现，但设置页里的状态与按钮照旧 —— 更新本身没有被关掉。
 */
import { useSyncExternalStore } from 'react'
import { getAgentHostOrNull, type AppUpdateStatus } from '@fizz/agent-client/host'
import { readPref, subscribePrefs, writePref } from './prefs-sync'

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

// ---------------------------------------------------------------------------
// 「有更新时提醒我」开关
// ---------------------------------------------------------------------------

/**
 * 关掉之后**只有设置页**还显示更新状态：状态栏那条指示与应用内 toast 都不再出现，
 * 但下载 / 安装入口一个不少（它们本来就在设置里）。
 *
 * 为什么是**本地**偏好、不进 `PREF_KEYS`（服务端同步）：更新是**这台机器上这个安装包**
 * 的事 —— 每台机器的版本各不相同，web / 手机压根没有这个能力（`appUpdateAvailable()`
 * 恒 false）。跨窗口（desktop 的设置页是独立渲染进程）由 `prefs-sync` 的本地总线负责，
 * 不需要服务端那一层。
 *
 * 缺省**开**：与加这个开关之前的行为一致（有更新就提醒）；关掉是明确的用户决定，
 * 所以只存「关掉」的标记 —— 没存过 = 开。
 */
const UPDATE_NOTIFY_KEY = 'fizz.web.updateNotify'

function readUpdateNotify(): boolean {
  return readPref(UPDATE_NOTIFY_KEY) !== '0'
}

const notifyListeners = new Set<() => void>()

/** 模块级缓存：`useSyncExternalStore` 要求 `getSnapshot` 返回同一个值 */
let notifyEnabled = readUpdateNotify()

/*
 * 订阅变更：别的窗口（desktop 的设置页）改完写 localStorage 会触发这里。
 * 模块级单例，不需要退订。
 */
subscribePrefs(UPDATE_NOTIFY_KEY, () => {
  const next = readUpdateNotify()
  if (next === notifyEnabled) return
  notifyEnabled = next
  for (const listener of notifyListeners) listener()
})

function getUpdateNotify(): boolean {
  return notifyEnabled
}

function subscribeUpdateNotify(listener: () => void): () => void {
  notifyListeners.add(listener)
  return () => {
    notifyListeners.delete(listener)
  }
}

/** 要不要用状态栏指示条 / 应用内 toast 提醒「有更新」（设置页永远显示，不受它影响） */
export function useUpdateNotifyEnabled(): boolean {
  // SSR 上按默认（开）：与 `useAppUpdateStatus` 的第三参同一口径，避免首帧闪一下
  return useSyncExternalStore(subscribeUpdateNotify, getUpdateNotify, () => true)
}

/**
 * 写开关。同窗口写盘不会触发 `storage`，所以内存态与订阅者得自己更新一次
 * （与 `notify.ts` 的 `saveNotifyEnabled` 同一套路）。
 */
export function saveUpdateNotifyEnabled(next: boolean): void {
  if (next === notifyEnabled) return
  notifyEnabled = next
  writePref(UPDATE_NOTIFY_KEY, next ? '1' : '0')
  for (const listener of notifyListeners) listener()
}
