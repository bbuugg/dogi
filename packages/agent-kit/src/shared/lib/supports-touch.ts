/**
 * 这台设备有没有触摸输入（手机 / 平板 / 触屏笔记本）。
 *
 * 为什么要单独判：**能力**问题只跟「有没有手指」有关，跟界面是不是手机布局无关。
 * 终端的触摸滚动、待发送队列的 ↑↓ 排序按钮，判的都是这个；`useIsMobile`（768px 视口）
 * 回答的是另一件事 —— 手机横屏也超过 768px，但它一样没有鼠标可用。
 *
 * `typeof window` 那道是给 SSR 兜底的：这函数可能在渲染期被调，真没有 window 时
 * 返回 false，别把页面炸了。
 */
export function supportsTouch(): boolean {
  if (typeof window === 'undefined') return false
  return 'ontouchstart' in window || navigator.maxTouchPoints > 0
}
