/**
 * 屏幕常亮（Screen Wake Lock API）的底座：偏好 + 能力探测 + **持有锁的生命周期**。
 *
 * ## 为什么需要
 *
 * 手机上等一轮 Agent 跑完、盯一个流程节点跑起来，屏幕一息屏就得重新点亮解锁 ——
 * 而 Agent 恰恰是「放着跑一会儿、你去做别的事」的东西。锁屏期间**页面在后台、
 * 事件还在收**，回来时看到的是已经跑完的结果，而不是一个黑屏。
 *
 * ## 三档偏好
 *
 * - `off`：不锁（**默认**：能亮屏到多久由系统说了算，不默认替用户改）；
 * - `running`：**只有会话还在跑时**才锁（省电：跑完就释放，不会整晚亮着）；
 * - `always`：页面在前台就一直锁（与旧版布尔开关的 `true` 等价）。
 *
 * 「会话在跑」由外壳把 `conversation-activity` 的全局运行态喂进来
 * （`setWakeLockSessionRunning`），本模块不自己去订阅 store / WS —— 它只负责
 * 「当前该不该持锁」这一件事。
 *
 * ## 与通知（`lib/notify.ts`）的分界
 *
 * 那边是「要不要打扰用户」，这边是「别让屏幕灭掉」：方向相反，所以不合并。
 * 但**偏好与能力探测是同一套形状**（模块级 + 订阅 + 字符串存 localStorage），
 * 照着它抄的。
 *
 * ## 锁的生命周期由浏览器管，页面只能「申请 + 补救」
 *
 * `navigator.wakeLock.request('screen')` 拿到的 `WakeLockSentinel` 会在这些时刻
 * **被浏览器自动释放**（规范如此，页面无能为力）：页面切到后台 / 锁屏、系统判定省电、
 * 用户手动关屏。所以本模块的重点不是「一直拿着」，而是：
 *
 * 1. **页面回到前台时重新申请** —— 否则用户切出去接个电话回来，锁已经没了，
 *    而且不会有任何提示（这是这个 API 最容易踩的坑）；
 * 2. **每次申请都串行去重** —— `visibilitychange` 在手机上是高频事件（解锁、切换应用、
 *    下拉通知栏都触发），不加锁会并发申请出一堆 sentinel，只保留最后一个；
 * 3. **申请失败只记状态、不抛** —— 用户没交互、页面不可见、系统省电策略都可能拒，
 *    这些都不该变成一个报错弹窗（`NotAllowedError` 在「页面当前不可见」时是必然的）。
 *
 * ⚠️ 这是**屏幕**锁，不是「不许系统睡眠」：它只防息屏，防不了手机进省电待机
 * （那是 `navigator.wakeLock` 之外的系统能力，网页没有接口）。
 *
 * ⚠️ 偏好存 `localStorage`（`fizz.web.*` 约定，见 AGENTS.md），只跟着这个浏览器走。
 */
import { useSyncExternalStore } from 'react'

const STORAGE_KEY = 'fizz.web.keepScreenAwake'

/** 屏幕常亮的三档：关 / 只在会话进行中 / 始终 */
export type WakeLockMode = 'off' | 'running' | 'always'

// ---------------------------------------------------------------------------
// 偏好
// ---------------------------------------------------------------------------

const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

/**
 * 默认**关**：亮不亮屏是用户自己的事，不该由一个聊天工具默认替他决定。
 * 想要的自己开（旧版布尔时代的 `'1'` 仍然按 `always` 读，别让老用户的选择丢掉）。
 *
 * ⚠️ 默认值改过一次（`always` → `off`）：改这里等于改所有**没存过值**的用户的
 * 行为，别顺手调回去。
 */
let mode = readInitial()
/** 当前有没有会话在跑（由外壳喂进来；只有 `running` 档读它） */
let sessionRunning = false

function readInitial(): WakeLockMode {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw === 'running') return 'running'
    // 旧版是布尔开关，`'1'` = 用户**主动打开过**，继续按 `always` 认
    if (raw === 'always' || raw === '1') return 'always'
    return 'off'
  } catch {
    return 'off'
  }
}

/**
 * 当前该不该持锁。
 *
 * ⚠️ 设置页的「实际状态」与这里必须同源：只读偏好会把「会话进行中但当前空闲」
 * 显示成已开启，用户会以为锁丢了。
 */
function shouldHold(): boolean {
  return mode === 'always' || (mode === 'running' && sessionRunning)
}

function getMode(): WakeLockMode {
  return mode
}

function subscribePreference(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** 读偏好（存坏了当没存过 = 默认关） */
export function loadWakeLockMode(): WakeLockMode {
  return mode
}

/** 写偏好并通知订阅者；存不进去也不致命（本次会话内仍生效，与 notify 一个待遇） */
export function saveWakeLockMode(next: WakeLockMode): void {
  if (next === mode) return
  mode = next
  try {
    localStorage.setItem(STORAGE_KEY, next === 'off' ? '0' : next)
  } catch {
    // 隐私模式 / 超额：只保留本次会话
  }
  emit()
}

/** React 版的偏好读取：设置开关与外壳共享同一个值（SSR 快照同默认：关） */
export function useWakeLockMode(): WakeLockMode {
  return useSyncExternalStore(subscribePreference, getMode, () => 'off')
}

/** React 版：当前档位 + 运行态下是否**应该**锁着（设置页据此显示「等待会话」） */
export function useWakeLockDesired(): boolean {
  return useSyncExternalStore(subscribePreference, shouldHold, () => false)
}

/**
 * 外壳喂进来的全局运行态：只要有会话在跑（含后台会话）就为真。
 *
 * 只在 `running` 档影响持锁；`always` / `off` 档下这个值不改变行为。
 * 幂等：同一个值重复喂不会触发一次多余的申请 / 释放。
 */
export function setWakeLockSessionRunning(next: boolean): void {
  if (next === sessionRunning) return
  sessionRunning = next
  emit()
}

// ---------------------------------------------------------------------------
// 能力探测
// ---------------------------------------------------------------------------

/**
 * 浏览器支不支持屏幕唤醒锁（SSR 一律当不支持）。
 *
 * ⚠️ **iOS Safari 不支持**，Safari 一直只给 video / WebRTC 那些场景开这个口；
 * Firefox 桌面版也还没实现。所以在设置里必须显式说「不可用」，
 * 让人知道自己该去改系统设置，而不是以为开关坏了。
 */
export function wakeLockSupported(): boolean {
  return typeof navigator !== 'undefined' && 'wakeLock' in navigator
}

// ---------------------------------------------------------------------------
// 锁的生命周期
// ---------------------------------------------------------------------------

/** 持锁的状态：设置页据此显示「已开启 / 没锁上（原因）」 */
export type WakeLockState = 'off' | 'on' | 'unavailable' | 'error'

/** 当前实际状态（SSR 一律当没开） */
let state: WakeLockState = 'off'

const stateListeners = new Set<() => void>()

function setState(next: WakeLockState): void {
  if (next === state) return
  state = next
  for (const listener of stateListeners) listener()
}

function getState(): WakeLockState {
  return state
}

function subscribeState(listener: () => void): () => void {
  stateListeners.add(listener)
  return () => {
    stateListeners.delete(listener)
  }
}

/** React 版的锁状态（设置页订阅） */
export function useWakeLockState(): WakeLockState {
  return useSyncExternalStore(subscribeState, getState, () => 'off')
}

/** 非 SSR 环境下的状态读取（给设置页首屏判断用） */
export function currentWakeLockState(): WakeLockState {
  return state
}

/** 当前持有的 sentinel；模块级持有，页面卸载时统一 release */
let sentinel: WakeLockSentinel | null = null

/**
 * 正在申请中的 promise：`visibilitychange` 高频触发时用来去重，
 * 否则会并发申请出一串 sentinel，只有最后一个被记住、其余全泄漏。
 */
let pending: Promise<WakeLockSentinel | null> | null = null

/**
 * 申请一次锁。
 *
 * 三个前置条件：不支持 / 当前不该持锁 / 页面不可见 —— 任一不满足都不申请。
 * 最后一条尤其重要：**页面不可见时申请必然被拒**（`NotAllowedError`），
 * 而「切后台 → 切回来」本来就要求先申请，所以这里把不可见当「跳过」而不是「失败」。
 */
async function acquire(): Promise<WakeLockSentinel | null> {
  if (!shouldHold()) return null
  if (!wakeLockSupported()) {
    setState('unavailable')
    return null
  }
  if (document.visibilityState !== 'visible') return null
  if (pending) return pending
  // 已经持着锁：重复 sync（比如流式期间每次 store 变化）不该反复申请
  if (sentinel) return sentinel

  pending = navigator.wakeLock
    .request('screen')
    .then((next) => {
      pending = null
      // 申请期间偏好被关了 / 会话已经跑完 / 已经拿到过一个了：立刻还回去，别攥着没人要的锁
      if (!shouldHold() || sentinel) {
        void next.release().catch(() => undefined)
        return null
      }
      sentinel = next
      setState('on')
      // 浏览器随时可能自己把锁收了（系统省电、用户锁屏…）。收了就记成 off，
      // 等 `visibilitychange` 再申请 —— 不去猜为什么被收，猜不准也没必要。
      next.addEventListener('release', () => {
        if (sentinel === next) {
          sentinel = null
          setState('off')
        }
      })
      return next
    })
    .catch((err: unknown) => {
      pending = null
      // 「页面当前不可见」是被上面的可见性检查挡在前面那条路径，这里兜底网络 / 系统拒绝
      if (err instanceof DOMException && err.name === 'NotAllowedError' && !shouldHold()) return null
      setState('error')
      return null
    })

  return pending
}

/** 释放当前持有的锁（偏好关掉 / 会话跑完 / 组件卸载时） */
async function release(): Promise<void> {
  const current = sentinel
  sentinel = null
  if (current && !current.released) {
    await current.release().catch(() => undefined)
  }
  setState('off')
}

/**
 * 挂上常亮逻辑。返回一个清理函数。
 *
 * 挂在应用外壳（`AppShell`）上跑一次即可 —— 常亮是**整屏**的事，不该由每个页面
 * 各自申请；对话 / 任务 / 流程三个页面都是「放着跑一会儿」的场景。
 *
 * 偏好 / 运行态变化由 `startWakeLock` 自己订阅（见下面的 `listeners.add(sync)`），
 * 所以设置里换档位、或一轮开始 / 结束，都会**立即**申请 / 释放，不依赖调用方重渲染。
 *
 * 返回的清理函数只解绑监听与订阅：组件卸载时**不主动放锁** —— 卸载往往只是视图切换，
 * 而锁本来就是「整屏开着才算有效」，交给下一次 `sync()` 判定更合适。
 */
export function startWakeLock(): () => void {
  /** 上一次 sync 算出来的结论：运行态每次 token 都会变，不能每次都去申请 */
  let lastWanted: boolean | null = null

  const sync = (force = false): void => {
    const want = shouldHold()
    if (!force && want === lastWanted) return
    lastWanted = want
    if (want) void acquire()
    else void release()
  }

  // 从后台回来：锁多半已经被浏览器收了，重新申请。
  // ⚠️ 这条是整个功能的关键 —— 少了它，用户切出去一次就永久失去常亮且毫无提示。
  const onVisibility = (): void => {
    if (document.visibilityState === 'visible') sync(true)
  }
  // 从 bfcache 回来（iOS Safari 的后退缓存）：页面被冻结过，锁必然没了
  const onPageShow = (event: PageTransitionEvent): void => {
    if (event.persisted) sync(true)
  }
  // 系统唤醒（笔记本开盖、手机亮屏）也走 visibilitychange，这里再兜一层 focus
  const onFocus = (): void => {
    if (document.visibilityState === 'visible') sync(true)
  }

  sync(true)

  document.addEventListener('visibilitychange', onVisibility)
  window.addEventListener('pageshow', onPageShow)
  window.addEventListener('focus', onFocus)
  // 偏好 / 运行态变化立刻生效：设置里换档位 → 申请 / 释放；会话开始 / 结束 → 只在
  // `running` 档下申请 / 释放。不依赖 React 重渲染（常亮不挂在任何组件的渲染结果上）
  listeners.add(sync)

  return () => {
    document.removeEventListener('visibilitychange', onVisibility)
    window.removeEventListener('pageshow', onPageShow)
    window.removeEventListener('focus', onFocus)
    listeners.delete(sync)
  }
}

/**
 * 供设置页在「想立刻试一次」时调用：强制重新申请一轮（用户刚换完档位、
 * 或刚从后台回来想确认到底锁上没有）。
 */
export async function retryWakeLock(): Promise<WakeLockState> {
  if (!shouldHold()) {
    await release()
    return state
  }
  await release()
  await acquire()
  return state
}
