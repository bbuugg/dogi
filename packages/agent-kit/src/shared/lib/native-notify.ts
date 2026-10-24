/**
 * 安卓壳（Capacitor）里的**系统通知**通道 —— `notify()` 的第三条腿。
 *
 * ## 为什么需要它
 *
 * 安卓的 **WebView 不实现 Web Notification API**：`'Notification' in window` 恒为 false，
 * 于是 `notify.ts` 里那条「后台发系统通知」的分支在手机上一辈子走不到 —— 表现就是
 * 「切到别的应用 / 锁屏之后，Agent 跑完了、审批卡住了，手机一声不吭」。
 * 壳里唯一能出系统通知的路是 Capacitor 的原生插件 `@capacitor/local-notifications`。
 *
 * ## 边界（别把这里当推送）
 *
 * 这是**本地通知**，不是推送：发通知的是页面里的 JS，前提是**页面还活着**（App 在后台、
 * WebView 进程没被系统冻结/杀掉）。App 被杀之后什么都收不到 —— 那需要服务端 + FCM，
 * 与这里无关。所以 `notify()` 在没有前台页面时本来就没有事件可发，链路是自洽的：
 * 有事件才发，发了才提醒。
 *
 * ## 为什么不用 `@capacitor/core` 的 `Capacitor.isNativePlatform()` 直接判
 *
 * 那会把 `@capacitor/core` 静态打进 web / desktop 的主包（两端都不需要它）。
 * 原生桥是在页面里**注入**的全局对象 `window.Capacitor`，本身就带
 * `isNativePlatform()` / `getPlatform()`（见 `@capacitor/core/dist/capacitor.js`），
 * 同步读它就够了；真正的插件只在国际上首次发通知时**动态 import**，
 * 桌面端那条分支永远不会触发，产物里只是一个不会被加载的 chunk。
 *
 * ## 偏好与权限
 *
 * 「要不要通知」的总闸门仍在 `notify.ts`（`fizz.web.notify`）；这里只管
 * **系统权限**（安卓 13+ 的 `POST_NOTIFICATIONS`，运行时授权）。权限状态是异步的，
 * 而设置页要同步渲染，所以这里缓存一份：`cachedNativePermission()` 给同步读，
 * `refreshNativePermission()` / `requestNativePermission()` 负责真正问系统。
 */
import type { LocalNotificationsPlugin, LocalNotificationSchema } from '@capacitor/local-notifications'
// `PermissionState` 只在 `@capacitor/core` 里导出（插件只是 import 它，没有再导出）
import type { PermissionState } from '@capacitor/core'

/** 原生桥注入的全局对象：只用到这两个字段，别为它拉进 `@capacitor/core` 的类型 */
interface CapacitorBridge {
  isNativePlatform?: () => boolean
  getPlatform?: () => string
}

declare global {
  interface Window {
    Capacitor?: CapacitorBridge
  }
}

/**
 * 当前页面是不是跑在原生壳里（安卓 App 的 WebView）。
 *
 * 同步、无副作用：桥由原生层在页面加载时注入，桌面 / 浏览器里这个全局根本不存在。
 */
export function isNativeShell(): boolean {
  if (typeof window === 'undefined') return false
  const bridge = window.Capacitor
  return typeof bridge?.isNativePlatform === 'function' && bridge.isNativePlatform() === true
}

/** 通知渠道 id：安卓 8+ 必须挂在一个渠道上，重要性 / 声音都跟着渠道走 */
const CHANNEL_ID = 'fizz-agent-alerts'

/**
 * 插件实例缓存。`import()` 只在**第一次真要发通知**时执行，
 * 之后复用；桌面 / 浏览器里永远是 null（`isNativeShell()` 先挡住了）。
 */
let api: LocalNotificationsPlugin | null = null

/**
 * ⚠️ 返回值**必须包一层对象**，不能直接 `return api`。
 *
 * Capacitor 的插件是 Proxy：**任何**属性（包括 `then`）都返回一个函数。`async` 函数的
 * 返回值会被 `Promise.resolve()` 检查 `then` —— 于是它被当成 thenable，原生侧收到
 * `LocalNotifications.then()`，报「`then()` is not implemented on android」。
 * 包成 `{ plugin }` 后对象自身没有 `then`，Promise 就不会碰它。
 *
 * 同理：调用方也**不能** `await` 插件对象本身，只能 `await` 它的方法。
 */
async function loadApi(): Promise<{ plugin: LocalNotificationsPlugin }> {
  if (api) return { plugin: api }
  const module = await import('@capacitor/local-notifications')
  api = module.LocalNotifications
  return { plugin: api }
}

/** 渠道建好一次就够（插件内部是幂等的，但没必要每次都跨桥调用） */
let channelReady = false

async function ensureChannel(instance: LocalNotificationsPlugin): Promise<void> {
  if (channelReady) return
  await instance.createChannel({
    id: CHANNEL_ID,
    name: 'Fizz 提醒',
    description: '回合结束与等待审批',
    // 4 = IMPORTANCE_HIGH：横幅 + 声音，否则用户不打开 App 就看不到
    importance: 4,
    // 1 = 锁屏上也显示内容（这些通知就是给人看结果的）
    visibility: 1,
    vibration: true
  })
  channelReady = true
}

/**
 * 权限缓存。`null` = 还没问过系统。
 *
 * 设置页同步渲染要用它（`notifyPermission()` 是同步函数），
 * 真实状态由 `refreshNativePermission()` 在挂载时补上。
 */
let permission: PermissionState | null = null

/** 同步读缓存；没问过时按「还没授权」算（`'prompt'`） */
export function cachedNativePermission(): PermissionState {
  return permission ?? 'prompt'
}

/** 把 Capacitor 的四种状态压成网页端那三种（`prompt-with-rationale` 也算还没授权） */
export function toWebPermission(state: PermissionState): 'default' | 'denied' | 'granted' {
  if (state === 'granted') return 'granted'
  if (state === 'denied') return 'denied'
  return 'default'
}

/** 主动问一次系统（不发弹窗），用于设置页挂载时校正显示 */
export async function refreshNativePermission(): Promise<PermissionState> {
  if (!isNativeShell()) return 'prompt'
  try {
    const { plugin } = await loadApi()
    const status = await plugin.checkPermissions()
    permission = status.display
  } catch {
    // 桥还没就绪 / 插件没装：保持原缓存，别把设置页卡住
  }
  return cachedNativePermission()
}

/** 申请权限（会弹系统弹窗，只能由用户操作触发） */
export async function requestNativePermission(): Promise<PermissionState> {
  if (!isNativeShell()) return 'prompt'
  try {
    const { plugin } = await loadApi()
    const status = await plugin.requestPermissions()
    permission = status.display
  } catch {
    // 同上：拿不到就当没授权，`notify()` 会退回应用内提示
  }
  return cachedNativePermission()
}

/**
 * App 启动时补一次授权（只问一次，且只在「还没问过」时问）。
 *
 * 安卓 13+ 的 `POST_NOTIFICATIONS` 是运行时权限：不主动要就永远收不到后台提醒，
 * 而通知的意义恰恰是「用户不在看这个页面」——等他进设置页再点就太晚了。
 */
let askedOnBoot = false

export async function ensureNativeNotifyPermission(): Promise<void> {
  if (!isNativeShell() || askedOnBoot) return
  askedOnBoot = true
  // 前后台判定与「要不要通知」无关：即使通知关着也先把状态跟踪挂上
  await ensureNativeAppStateTracking()
  const state = await refreshNativePermission()
  if (state === 'prompt' || state === 'prompt-with-rationale') await requestNativePermission()
}

// ---------------------------------------------------------------------------
// 点击通知 → 回到应用里的对应会话 / 任务
// ---------------------------------------------------------------------------

/** 通知 id（安卓要求 int32）→ 点击回调。发完点了就删，别让它无限堆 */
const clickHandlers = new Map<number, () => void>()

/** 同名通知要互相替换（与 web 的 `tag`、toast 的 `id` 一个语义），所以 id 由 tag 算出来 */
function idOf(key: string): number {
  let hash = 0
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 31 + key.charCodeAt(i)) | 0
  }
  // 避开 0：插件把 0 当成「没设置 id」
  return hash === 0 ? 1 : Math.abs(hash)
}

let actionListenerReady = false

/** 点通知的监听只挂一次：原生层把点击结果回传成 `localNotificationActionPerformed` */
async function ensureActionListener(instance: LocalNotificationsPlugin): Promise<void> {
  if (actionListenerReady) return
  actionListenerReady = true
  await instance.addListener('localNotificationActionPerformed', (action) => {
    const handler = clickHandlers.get(action.notification.id)
    if (!handler) return
    clickHandlers.delete(action.notification.id)
    handler()
  })
}

export interface NativeNotificationInput {
  title: string
  body?: string
  /** 同 tag 的通知互相替换（任务 / 会话维度） */
  tag?: string
  /** 点通知后干什么（通常是跳回那个会话）；不传 = 只把 App 拉回前台 */
  onClick?: () => void
}

// ---------------------------------------------------------------------------
// App 前后台状态（安卓 WebView 的 document.visibilityState 不可靠）
// ---------------------------------------------------------------------------

/**
 * 当前 App 是否在前台。
 *
 * ⚠️ 为什么不用 `document.visibilityState`：安卓 WebView **不实现 Page Visibility
 * 的应用切换语义** —— 按 Home / 切到别的 App 之后它仍常常报 `'visible'`。于是
 * `notify()` 会误判成「用户正看着」，只弹一条应用内的 toast（而页面已经不可见了，
 * 用户什么也收不到），系统通知那条路永远走不到。用户报的「切到后台就收不到提醒」
 * 就是这条。
 *
 * 真源改用 Capacitor `@capacitor/app` 的 `appStateChange`：原生侧知道 Activity 的
 * onResume / onPause，比 WebView 的 visibility 准。默认 `true`（冷启动那一刻就在
 * 前台，异步桥接还没回来）。
 */
let nativeAppActive = true

/** 同步读「App 在前台吗」（非原生壳恒为 true，调用方只在原生分支用它） */
export function isNativeAppForeground(): boolean {
  return nativeAppActive
}

/** App 状态监听只挂一次 */
let appStateTracking = false

/**
 * 开始跟踪 App 前后台。由 `ensureNativeNotifyReady()` 在启动时调（**不受通知偏好
 * 影响** —— 前台判定本身与要不要通知无关）。
 */
export async function ensureNativeAppStateTracking(): Promise<void> {
  if (!isNativeShell() || appStateTracking) return
  appStateTracking = true
  try {
    const { App } = await import('@capacitor/app')
    // 先取一次当前状态：监听器只报「变化」，启动时若已经是后台就漏了
    const state = await App.getState()
    nativeAppActive = state.isActive
    await App.addListener('appStateChange', ({ isActive }) => {
      nativeAppActive = isActive
    })
  } catch {
    // 桥还没就绪 / 插件没装：保持 true（按前台处理，退化成原来的行为）
  }
}

/**
 * 发一条**系统通知**。返回 `false` = 没发出去（不是原生壳 / 没授权 / 桥报错），
 * 调用方据此退回应用内提示。
 */
export async function sendNativeNotification(input: NativeNotificationInput): Promise<boolean> {
  if (!isNativeShell()) return false
  try {
    const { plugin } = await loadApi()
    // 缓存里不是「已授权」就现问一次（`checkPermissions` 不弹框）：
    // 用户可能刚在系统设置里打开通知，而我们没重启过 App，缓存还停在 denied
    let state = permission
    if (state !== 'granted') state = await refreshNativePermission()
    if (state !== 'granted') return false
    await ensureChannel(plugin)
    await ensureActionListener(plugin)

    const id = idOf(input.tag ?? input.title)
    if (input.onClick) clickHandlers.set(id, input.onClick)
    const notification: LocalNotificationSchema = {
      id,
      title: input.title,
      body: input.body ?? '',
      channelId: CHANNEL_ID,
      // 点掉之后从通知中心移除
      autoCancel: true
    }
    await plugin.schedule({ notifications: [notification] })
    return true
  } catch {
    // 桥不可用（远程页面没注入 / 插件没注册 / 系统限制）：当作没发，让上层退回 toast
    return false
  }
}
