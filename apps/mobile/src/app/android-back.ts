/**
 * 安卓返回手势 / 返回键（系统边缘左右滑、三键导航的返回）在本壳里的**唯一接管点**。
 *
 * ## 为什么必须自己接管：Capacitor 8 之后没人替我们关 Activity 了
 *
 * `@capacitor/app` 的 `AppPlugin.load()` 会注册一个**默认启用**的
 * `OnBackPressedCallback`，它只有两条分支：
 * - 没有任何 JS 监听器 → WebView 能后退就 `goBack()`，不能就 **return**；
 * - 有监听器 → 把事件发给 JS，同样 **return**。
 *
 * 两条都不会再 `super.onBackPressed()` / `finish()`（Capacitor 5 之前那套「没历史就
 * 关掉 Activity」已经没有了）。本工程是 SPA：没有路由、`canGoBack()` 恒为 false ——
 * 于是返回手势滑完**什么都不发生**，而别的 App 这时已经回桌面了。用户报的
 * 「左右滑屏幕边缘，App 一动不动」就是这条。
 *
 * ⚠️ 别再往 `capacitor.config.ts` 里加 `plugins.App.disableBackButtonHandler: true`
 * 想「交还给系统」：那只是把上面那个 callback 整个禁掉，JS 侧连 `backButton` 事件都
 * 收不到，设置页 / 抽屉的「返回上一层」会一起失效。
 *
 * ## 行为 = App 内的一条「返回栈」，不是见到返回就退出
 *
 * 按顺序问，第一个认领的赢：
 * 1. 有浮层（Dialog / AlertDialog / vaul 抽屉 / 下拉 / 图片预览）→ 关掉最上面那层；
 * 2. 组件注册的处理器，后注册的先问 —— 设置页（先退二级页、再关整页）、侧栏抽屉；
 * 3. 都没有 → `minimizeApp()`：**挪到后台**而不是 `exitApp()` 杀进程 —— 与其它 App
 *    的返回一致，从最近任务回来还是原样。
 *
 * 只在原生壳里生效：web / 桌面调试时 `isNativePlatform()` 为 false，整段空转；
 * 浏览器自己的返回由浏览器管。
 */
import { useEffect, useRef } from 'react'
import { App as CapacitorApp } from '@capacitor/app'
import { Capacitor } from '@capacitor/core'
import { reconnectStateSocket } from '@fizz/agent-kit/shared/lib/state-ws'

/** 返回处理器：返回 true = 这一下由我消费（不再继续往下问） */
type BackHandler = () => boolean

/** 已注册的处理器，按挂载顺序；**后注册的先问**（页面压在壳上） */
const handlers = new Set<BackHandler>()

/**
 * 能「吃掉一次返回」的浮层。
 *
 * - `[role="dialog"][data-state="open"]`：Radix Dialog；vaul 抽屉的底层就是
 *   Radix 的 Content，`data-state` 是它自己的稳定钩子；
 * - `[role="alertdialog"]`：`ConfirmProvider` 那类命令式确认框；
 * - `[role="dialog"][aria-modal="true"]`：`ImageViewer`（自绘浮层，没有 `data-state`）；
 * - `menu` / `listbox`：下拉菜单与选择器 —— 与系统一致，先收浮层再退页面。
 */
const OVERLAY_SELECTOR = [
  '[role="dialog"][data-state="open"]',
  '[role="alertdialog"][data-state="open"]',
  '[data-vaul-drawer][data-state="open"]',
  '[role="dialog"][aria-modal="true"]',
  '[role="menu"][data-state="open"]',
  '[role="listbox"][data-state="open"]'
].join(',')

/**
 * 关掉最上面的浮层。
 *
 * Radix 的 `DismissableLayer`（Dialog / AlertDialog / 下拉 / vaul 都走它）在
 * `ownerDocument` 上以**捕获**监听 `Escape`，且只让**最上层**那一个响应 —— 与真键盘
 * 按 Esc 完全同一条路。安卓返回不会产生键盘事件，这里补一次。
 *
 * `cancelable` 必须为 true：浮层可以在 `onEscapeKeyDown` 里 `preventDefault()`
 * 明确拒绝关闭（不可取消的弹窗），合成的事件也要遵守这个约定。
 */
function dismissTopOverlay(): boolean {
  if (!document.querySelector(OVERLAY_SELECTOR)) return false
  document.dispatchEvent(
    new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true
    })
  )
  return true
}

/** 从后往前问一圈；都没消费就返回 false（调用方负责「挪到后台」） */
function runHandlers(): boolean {
  const list = [...handlers]
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i]()) return true
  }
  return false
}

/**
 * 注册一个「返回上一层」处理器（组件挂载期间有效，卸载自动摘掉）。
 *
 * 用 ref 转发而不是把 `handler` 写进依赖：调用方几乎都闭着会变的 state
 * （设置页二级页、抽屉开合），进依赖就会每次渲染摘挂一次监听 —— 而这里只关心
 * **调用那一刻**的最新闭包。
 */
export function useAndroidBackHandler(handler: BackHandler): void {
  const ref = useRef(handler)
  ref.current = handler

  useEffect(() => {
    const entry: BackHandler = () => ref.current()
    handlers.add(entry)
    return () => {
      handlers.delete(entry)
    }
  }, [])
}

/**
 * 装上原生 `backButton` 监听。**整个 App 只装一次**（`client-root.tsx`）。
 *
 * 注意：一旦注册（哪怕只是这里这一个），原生侧就再也不会回落去 finish Activity，
 * 所以「什么都没有」的那条必须由我们自己 `minimizeApp()` 收尾。
 */
export function useAndroidBackButton(): void {
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return
    let disposed = false
    let handle: { remove: () => Promise<void> } | null = null

    void CapacitorApp.addListener('backButton', () => {
      if (dismissTopOverlay()) return
      if (runHandlers()) return
      // 根层：挪到后台（不 exitApp —— 进程留着，回来还是刚才那屏）
      void CapacitorApp.minimizeApp().catch(() => undefined)
    })
      .then((registered) => {
        // 注册还没回来就卸载了：补一次移除，别把监听漏在全局
        if (disposed) void registered.remove()
        else handle = registered
      })
      .catch(() => undefined)

    return () => {
      disposed = true
      void handle?.remove()
    }
  }, [])
}


/**
 * App 从后台回到前台时，重建状态 WS。
 *
 * 安卓切后台久了 WebView 可能被冻结 / 挂起，原来的状态 socket 会变成「看着还开着、
 * 实际收不到帧」的半死连接 —— 用户看到的就像「App 暂停了」。回到前台立刻重连一次，
 * 服务端会重新下发 `init` 全量快照，界面与运行态自动追上。
 *
 * 通知链路另有一条：`native-notify.ts` 用同一个 `appStateChange` 维护前后台判定
 * （WebView 的 `document.visibilityState` 在切 App 后不可靠）。
 */
export function useAndroidAppResume(): void {
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return
    let disposed = false
    let handle: { remove: () => Promise<void> } | null = null

    void CapacitorApp.addListener('appStateChange', ({ isActive }) => {
      if (isActive) reconnectStateSocket()
    })
      .then((registered) => {
        if (disposed) void registered.remove()
        else handle = registered
      })
      .catch(() => undefined)

    return () => {
      disposed = true
      void handle?.remove()
    }
  }, [])
}
