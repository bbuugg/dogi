/**
 * 弹出层「点空白关闭」时的焦点守卫（Select / DropdownMenu / Popover / ContextMenu / Menubar 共用）。
 *
 * ## 问题
 *
 * Radix 的弹出层关闭时，`onCloseAutoFocus` 的默认实现会把焦点**还给触发器**。而
 * 「点空白取消」这条路上，`DismissableLayer` 会 `preventDefault()` 掉那次 outside
 * `pointerdown`（免得焦点掉到 `body` 上）—— 浏览器因此认为**这一下没有发生指针交互**，
 * 于是把随后的程序化 `focus()` 判成 `:focus-visible`。
 *
 * 结果：触发器上的 `focus-visible:border-ring` 立刻生效。用户看到的就是「点空白取消后，
 * 触发器边缘凭空多出一圈主色调边框（配合 `shadow-xs` 像一圈阴影）」。
 *
 * ## 做法
 *
 * 记住这次关闭是不是**指针**（鼠标 / 触摸）发起的：
 * - 指针关闭 → **跳过回焦**。谁点的、点在哪，用户看得见，不需要焦点提示；焦点留在被点的
 *   那个元素上（通常是 `body` 或用户刚点的地方），触发器不再亮。
 * - 键盘关闭（Esc / Enter / 方向键）→ 原样回焦，可访问性不变。
 *
 * ## ⚠️ 调用方自己的 `onCloseAutoFocus` **两种关闭都要执行**
 *
 * 这个回调是「菜单彻底关掉之后再去做一件事」的**唯一时机** —— Radix 是在内容节点
 * 卸载之后才在 `setTimeout(0)` 里派发它（`FocusScope` 的 unmount autofocus），那时
 * 退场动画已经结束、焦点陷阱也已经撤掉。以前指针关闭那条路直接 `return`，等于让
 * 调用方永远收不到这个回调（最典型的用法：主区域标签重命名要把焦点交给输入框）。
 *
 * 所以现在只在指针关闭时**额外** `preventDefault()`，调用方 handler 照常执行。
 * 注意：别在那个 handler 里回焦**触发器** —— 那正是本文件要挡掉的 focus-visible 边框。
 *
 * ## 用法
 *
 * ```tsx
 * const dismissFocus = useDismissFocusGuard()
 * <Content
 *   {...props}
 *   onPointerDown={(e) => { dismissFocus.markPointer(); props.onPointerDown?.(e) }}
 *   onPointerDownOutside={(e) => { dismissFocus.markPointer(); props.onPointerDownOutside?.(e) }}
 *   onCloseAutoFocus={(e) => dismissFocus.closeAutoFocus(e, props.onCloseAutoFocus)}
 * />
 * ```
 *
 * ⚠️ 三个回调都要挂上：`onPointerDown` 覆盖「点菜单项选中」，`onPointerDownOutside`
 * 覆盖「点空白 / 点别处」，少一个那边就还会亮。
 */
import * as React from 'react'

export function useDismissFocusGuard(): {
  /** 标记「这次交互是指针发起的」（挂到 `onPointerDown` / `onPointerDownOutside`） */
  markPointer: () => void
  /**
   * 挂到 `onCloseAutoFocus`：指针关闭时先阻止回焦（Radix 的默认行为是把焦点还给触发器），
   * 然后**两种关闭都**执行调用方自己的 handler。
   *
   * 泛型只为让 Radix 那几个各不相同的关闭事件类型（`PointerDownOutsideEvent` 等）
   * 原样传下去 —— 这里只用到 `preventDefault()`。
   */
  closeAutoFocus: <E extends { preventDefault: () => void }>(
    event: E,
    fallback?: (event: E) => void
  ) => void
} {
  const closedByPointer = React.useRef(false)

  const markPointer = React.useCallback((): void => {
    closedByPointer.current = true
  }, [])

  const closeAutoFocus = React.useCallback(
    <E extends { preventDefault: () => void }>(event: E, fallback?: (event: E) => void): void => {
      if (closedByPointer.current) {
        // 这个 ref 在组件实例生命周期内有效；一次性用掉后复位，避免下次键盘关闭被误吞
        closedByPointer.current = false
        event.preventDefault()
      }
      // 指针关闭时调用方的 handler 以前会被整个跳过（等于它永远收不到这个时机），
      // 现在照样执行 —— 见文件头「两种关闭都要执行」
      fallback?.(event)
    },
    []
  )

  return { markPointer, closeAutoFocus }
}
