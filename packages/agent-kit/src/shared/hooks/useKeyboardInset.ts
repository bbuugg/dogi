/**
 * 只量**键盘**，量到的值写进 `<html>` 上的 `--kb-inset`（DOM 胶水层，纯计算在
 * `lib/keyboard-inset.ts`）。
 *
 * ⚠️ **不再写 `--app-height`、也不再由 JS 定应用高度**（曾经这么做，已撤）。原因：
 *
 * - 高度链一旦是「JS 算出来的 px」，键盘事件与 `visualViewport` 更新就不一定是同一拍 ——
 *   聚焦那一刻先写一个偏小的值，150ms 后再补正，整页高度**当着用户的面抖一下**
 *   （用户报的就是「focus 输入框页面高度变一下」，web 手机模式与手机壳都有）。
 * - 而且这层补偿本来就是给「键盘只缩视觉视口、布局视口不动」（iOS / 桌面浏览器）
 *   准备的；Android WebView / Chrome 开了 `interactive-widget=resizes-content`
 *   （`apps/web/index.html` / `apps/mobile/index.html`），布局视口自己缩，
 *   `html, body { height: 100% }` 已经贴着键盘上沿，JS 再算一次纯属二次计算。
 *
 * 所以现在**高度链全走 CSS**（`html, body { height: 100% }`，见各端 `index.css` /
 * `styles.css`）；这里只剩「键盘盖住了多少」这一个信息量，给需要自己抬一下的浮层与
 * JS 判断（`keyboardInsetNow()`）用。`--kb-inset` 现在**没有任何消费方**，保留是因为
 * 它是唯一「键盘开没开」的全局信号，将来要用不必重新听一遍视口事件。
 *
 * 为什么整个仓库只需要装一次：变量是全局的，多个组件各自挂 `visualViewport` 监听只会重复
 * 计算同一个数。所以这里是**模块级单例**（`installed`），`useKeyboardInset()` 可以被任意
 * 组件随便调，幂等。
 *
 * 消费方读 CSS 变量而不是 React state：键盘进出时 resize / scroll 成串地来，走 state 会
 * 重渲染整棵树，而绝大多数消费方只需要一句 CSS。
 */
import { useEffect } from 'react'
import {
  KEYBOARD_INSET_VAR,
  KEYBOARD_MIN_PX,
  keyboardInsetFrom,
  type ViewportMetrics
} from '@fizz/agent-kit/shared/lib/keyboard-inset'

/** 模块级单例标记（见文件头） */
let installed = false

/**
 * 是否有可编辑元素正被聚焦 —— 「键盘真的弹着」的可靠信号（见文件头）。
 * 只认输入类：`<select>` 弹的是选择器不是键盘，故不计。
 */
function editableFocused(): boolean {
  const el = document.activeElement
  if (!el) return false
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return true
  return el instanceof HTMLElement && el.isContentEditable
}

/** 当前被键盘盖住的高度（需要 JS 判断的场景用，比如「键盘弹着时自动收起某个浮层」） */
export function keyboardInsetNow(): number {
  if (!editableFocused()) return 0
  const vv = window.visualViewport
  return keyboardInsetFrom(vv as ViewportMetrics | undefined, window.innerHeight)
}

function install(): void {
  if (installed) return
  installed = true
  const vv = window.visualViewport

  /**
   * 最近一次「键盘没弹」时的布局高度。用来分辨键盘是哪种模式：
   * - `innerHeight` 明显比它小 → 键盘**缩了布局视口**（resizes-content）→ 不用再算；
   * - 几乎没变 → 键盘只缩了视觉视口（resizes-visual / iOS）→ 用 `keyboardInsetFrom` 量。
   * 只在「没聚焦」时刷新它，这样键盘开着的期间基准一直是「无键盘高度」。
   */
  let layoutBaseline = window.innerHeight

  const write = (): void => {
    const innerHeight = window.innerHeight
    const focused = editableFocused()

    let inset = 0
    if (!focused || !vv) {
      // 没键盘（或没有 visualViewport 口径）：遮挡归零，并把基准刷新到当前高度
      layoutBaseline = innerHeight
    } else if (layoutBaseline - innerHeight <= KEYBOARD_MIN_PX) {
      // 布局视口没随键盘缩 → 键盘只缩了 visual，得自己量出键盘那份
      inset = keyboardInsetFrom(vv as ViewportMetrics, innerHeight)
    }
    // else：布局视口已随键盘缩（resizes-content），innerHeight 就是键盘上沿，inset 保持 0

    document.documentElement.style.setProperty(KEYBOARD_INSET_VAR, `${inset}px`)
  }

  /*
   * 同一帧里的连串事件只算一次（键盘动画会成串地来），事件之后**再补算一记尾随**：
   * 部分机型（尤其键盘收起）的事件比真实布局早一拍，只算当次会留着旧值。
   * ⚠️ 这里写的是信息量，抖一下没人看得见；**别再让它驱动高度**（见文件头）。
   */
  let raf = 0
  let settle = 0
  const apply = (): void => {
    if (raf) cancelAnimationFrame(raf)
    raf = requestAnimationFrame(() => {
      raf = 0
      write()
    })
    if (settle) clearTimeout(settle)
    settle = window.setTimeout(write, 150)
  }

  if (vv) {
    vv.addEventListener('resize', apply)
    // scroll 也要听：iOS 把聚焦元素滚进可视区时 offsetTop 变了，遮挡得跟着重算
    vv.addEventListener('scroll', apply)
  }
  // 兜底：个别平台键盘收起 / 弹出时只发这些事件，不发 vv 事件；`focusin` / `focusout`
  // 用于及时切换「有没有可编辑元素聚焦」那道闸（见文件头）。桌面窗口缩放也会走到，幂等无害。
  window.addEventListener('resize', apply)
  window.addEventListener('orientationchange', apply)
  window.addEventListener('focusin', apply)
  window.addEventListener('focusout', apply)
  window.addEventListener('pageshow', apply)
  document.addEventListener('visibilitychange', apply)
  apply()
}

/** 装一次就够（幂等）。返回 void —— 消费方读 CSS 变量，不读它。 */
export function useKeyboardInset(): void {
  useEffect(() => {
    install()
  }, [])
}
