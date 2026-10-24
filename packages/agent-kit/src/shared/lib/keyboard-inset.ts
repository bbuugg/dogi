/**
 * 软键盘把视口底部盖掉了多高 —— 纯计算部分（零依赖、零 DOM 副作用）。
 *
 * ## 只量键盘，不定应用高度
 *
 * 应用高度**由 CSS 定**（各端 `index.css` / `styles.css` 的 `html, body { height: 100% }`）。
 * 曾经是 JS 写 `--app-height`（= `max(MIN, innerHeight − 键盘遮挡)`），**已撤**：
 * 聚焦那一刻 `visualViewport` 与布局视口不是同一拍更新，先写偏小的值、150ms 后再补正，
 * 整页高度当着用户的面抖一下（用户报「focus 输入框页面高度变一下」）。
 * 而且 Android WebView / Chrome 开了 `interactive-widget=resizes-content` 时布局视口自己缩，
 * `100%` 已经贴着键盘上沿，再算一次就是二次计算。
 *
 * 所以这里只剩 `keyboardInsetFrom`（量键盘）与两个常量，给 `useKeyboardInset` 写
 * `--kb-inset`（信息量 + 需要自己抬一下的浮层）和 `keyboardInsetNow()` 用。
 *
 * ## 为什么用 visualViewport 量键盘
 *
 * `window.visualViewport` 是两个平台唯一都准的键盘口径：键盘一弹出，`vv.height` 就缩掉键盘那份。于是
 *
 *   inset = innerHeight − vv.height
 *
 * 就是「被盖住的高度」。这里把入参拆开（而不是直接读 window）就是为了能单测：
 * 各平台差别**全在这两个数的关系上**，见 `keyboardInsetFrom` 的注释。
 *
 * ⚠️ 公式**不含 `vv.offsetTop`**：Android 在 IME 弹出时会把 `offsetTop` 报成负值，带上它就
 * 会多减、底部露出空白（见 `keyboardInsetFrom`）。DOM 侧另用「有没有可编辑元素被聚焦」
 * 兜一道（`useKeyboardInset`），避免没键盘时误判。
 *
 * ## 「别被盖住」的正确解法是改**高度链**，不是在底栏上加 margin-bottom
 *
 * 曾经的做法是给终端底栏加 `margin-bottom: var(--kb-inset)`，**不成立**：那条是
 * `flex h-full flex-col` 里 `shrink-0` 的最后一项，它的 margin 属于**外尺寸**，要参与
 * flex 的剩余空间计算（容器高 − Σ 各项外尺寸）。于是 `flex-1` 的终端区等量收缩、
 * 底栏被放到距容器底 `inset` px 的位置，**下面留出一条 `inset` px 的空白**，终端还平白
 * 少了一块。所以键盘让位必须落在**高度链本身**（现在是 `height: 100%` 跟着缩），
 * 不能落到某个子元素的 margin 上。
 *
 * 桌面无键盘：`innerHeight` 就是窗口高度、遮挡为 0。
 */

/**
 * 挂在 `<html>` 上的 CSS 变量名：被键盘盖住的高度。**纯信息量** —— 高度链由 CSS 自己缩，
 * 不消费它；留给「需要自己抬一下」的浮层与 JS 判断（`keyboardInsetNow()`）。桌面恒为 `0px`。
 */
export const KEYBOARD_INSET_VAR = '--kb-inset'

/**
 * inset 小于这个数就不当键盘：软键盘再矮也有一百多 px，而地址栏伸缩只有几十 px。
 * 阈值定在这儿，后者才不会把底部工具条颠得一开一合地跳。
 */
export const KEYBOARD_MIN_PX = 120

/**
 * `--app-height` 的下限：比这还矮就不是「键盘遮住了一部分」，而是脏数据
 * （视口正在动画中、`visualViewport` 报了瞬时值）。这时候宁可给个下限，
 * 也不能把应用压成一条。
 */
export const APP_HEIGHT_MIN_PX = 120

/** `visualViewport` 上本模块用得到的三个字段（留一个窄接口，好让单测直接塞假数据） */
export type ViewportMetrics = {
  /** 视觉视口高度（键盘弹出时会缩掉键盘那份，**两个平台都是**） */
  height: number
  /** 视觉视口相对布局视口的纵向偏移（保留仅作参考；**不参与遮挡计算**，见下） */
  offsetTop: number
  /** 捏合缩放比例（≠1 时 height 的变化是缩放造成的，不是键盘） */
  scale: number
}

/**
 * 算「被键盘盖住的高度（px）」= `layoutHeight − vv.height`（`layoutHeight` 传 `window.innerHeight`）。
 *
 * 逐场景对齐：
 *
 * | 场景 | innerHeight | vv.height | 期望 inset |
 * |---|---|---|---|
 * | iOS：键盘弹出（布局视口不缩） | 730 | 430 | 300 |
 * | Android `resizes-content`：键盘弹出（布局视口跟着缩） | 430 | 430 | 0 |
 * | Android `resizes-visual`：键盘弹出（只缩 visual，布局不缩） | 730 | 430 | 300 |
 * | 地址栏收起 / 弹出 | 730 ↔ 690 | 730 ↔ 690 | 0（差几十 px < 阈值） |
 * | 双指捏合缩放 | 730 | 365 | 0（scale ≠ 1 直接判 0） |
 *
 * 判据就是「`innerHeight` 有没有随键盘缩」：缩了（resizes-content）= 0，没缩（iOS /
 * resizes-visual）= 键盘高度。两种模式同一个式子自然覆盖，不必分辨用的是哪种。
 *
 * ⚠️ **刻意不用 `vv.offsetTop`**：Android（Edge / Chrome）在 IME 弹出、输入框被滚进可视区
 * 时会把 `offsetTop` 报成 **负值**，`layoutHeight − (vv.height + offsetTop)` 于是**多减**一截，
 * 应用比可视区矮 —— **底部就露出一条空白，且只在弹键盘时出现**。本应用外壳 `overflow: hidden`、
 * 自身不滚动，不需要 offsetTop 那层兜底，去掉它反而稳。
 */
export function keyboardInsetFrom(vv: ViewportMetrics | undefined, layoutHeight: number): number {
  // scale 非有限数（NaN / Infinity / undefined）：当无效数据，不当键盘也不抛
  if (!vv || !Number.isFinite(vv.scale) || vv.scale <= 0) return 0
  // 捏合缩放中：height 的变化来自 scale，不是键盘（终端双指缩放字号正是这个场景）
  if (Math.abs(vv.scale - 1) > 0.01) return 0
  // height / layoutHeight 是脏数据：不写非法值（`NaNpx` 会让 `calc()` 整条作废 → 高度退回 auto）
  if (!Number.isFinite(vv.height) || !Number.isFinite(layoutHeight)) return 0
  const raw = layoutHeight - vv.height
  if (raw <= KEYBOARD_MIN_PX) return 0
  return Math.round(raw)
}
