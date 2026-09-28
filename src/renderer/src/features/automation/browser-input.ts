import type { BrowserInputEvent, BrowserMouseButton } from '@shared/types'

/**
 * 面板里的 DOM 事件 → 合成输入事件（纯函数，便于单独验证）。
 *
 * 坐标一律换算成**页面视口坐标**后再交给主进程：面板显示尺寸和页面视口
 * 尺寸不是一个东西（screencast 的帧还会按 dpr 放大），映射错了点击就全歪。
 */

/** CDP 的修饰键位掩码：Alt=1 / Ctrl=2 / Meta=4 / Shift=8 */
export function cdpModifiers(e: {
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
}): number {
  return (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0)
}

/** DOM 的 `MouseEvent.button` 编号 → CDP 的 button 名 */
export function mouseButton(button: number): BrowserMouseButton {
  switch (button) {
    case 0:
      return 'left'
    case 1:
      return 'middle'
    case 2:
      return 'right'
    case 3:
      return 'back'
    case 4:
      return 'forward'
    default:
      return 'none'
  }
}

export interface RectLike {
  left: number
  top: number
  width: number
  height: number
}

/**
 * `object-contain` 之后**画面真正占的那块**矩形。
 *
 * 图片是 `size-full`（铺满面板），但画面等比缩放后**居中**，四周会留白
 * （信箱 / 柱状黑边）。所以**元素 rect ≠ 画面 rect**，直接拿元素 rect 映射坐标
 * 点击就会整体偏移，偏移量随离画面中心的距离**线性增长**。
 *
 * ⚠️ 这个偏移在「视口 = 面板尺寸」的时代看不出来（宽高比基本一致，黑边接近 0），
 * 视口改成固定预设之后才暴露：1280×800 塞进 731×560 的面板，上下各有约 50px 黑边，
 * 点画面底部的东西会打到上面约 55px 的地方。
 */
export function containedRect(
  el: RectLike,
  content: { width: number; height: number }
): RectLike {
  if (!el.width || !el.height || !content.width || !content.height) return el
  const scale = Math.min(el.width / content.width, el.height / content.height)
  const width = content.width * scale
  const height = content.height * scale
  return {
    left: el.left + (el.width - width) / 2,
    top: el.top + (el.height - height) / 2,
    width,
    height
  }
}

/**
 * 面板像素坐标 → 页面视口坐标。
 *
 * `rect` 必须是**画面矩形**（`containedRect` 算出来的），不是 img 的元素矩形 ——
 * 两者在 object-contain 留白时不相等，用错就偏移（见 `containedRect` 的注释）。
 */
export function toPageCoords(
  clientX: number,
  clientY: number,
  rect: RectLike,
  viewport: { width: number; height: number }
): { x: number; y: number } | null {
  if (!rect.width || !rect.height) return null
  const x = ((clientX - rect.left) / rect.width) * viewport.width
  const y = ((clientY - rect.top) / rect.height) * viewport.height
  // 落在黑边里（留白区）的点不转发 —— 那块不是页面内容，转过去会点到页面边缘。
  // 留 EPS 容差：画面右下角算出来可能是 800.0000000000002，直接判 `> 800` 会把
  // 最边缘那一像素的点也丢掉（实测踩过）。容差之后再钳回范围内。
  const EPS = 0.5
  if (x < -EPS || y < -EPS || x > viewport.width + EPS || y > viewport.height + EPS) return null
  return {
    x: Math.min(viewport.width, Math.max(0, x)),
    y: Math.min(viewport.height, Math.max(0, y))
  }
}

/**
 * KeyboardEvent → 合成按键事件。
 *
 * 两种要挡掉的情况：
 * - 输入法组合期间（`isComposing` / `key === 'Process'`）：这一串按键不产生字符，
 *   交给 `compositionend` 走 insertText，否则中文会被拆成一堆无意义的按键。
 * - 带 Ctrl / Cmd 的组合键：不能带 `text`，否则 CDP 会插入字符而不是触发快捷键
 *   （Ctrl+A 变成输入一个 a）。
 */
export function keyEvent(
  e: KeyboardEvent,
  type: 'keyDown' | 'keyUp'
): BrowserInputEvent | null {
  if (e.isComposing || e.key === 'Process') return null
  const withCommand = e.ctrlKey || e.metaKey || e.altKey
  const text = type === 'keyDown' && e.key.length === 1 && !withCommand ? e.key : undefined
  return {
    kind: 'key',
    type,
    key: e.key,
    code: e.code,
    text,
    // Chromium 仍然提供 keyCode，它就是 Windows 虚拟键码，省掉一张映射表
    windowsVirtualKeyCode: e.keyCode,
    modifiers: cdpModifiers(e)
  }
}

/** 滚轮：面板的 deltaY 与页面滚动量不同量级，乘一个系数更跟手 */
const WHEEL_SCALE = 1

export function wheelEvent(
  e: { clientX: number; clientY: number; deltaX: number; deltaY: number },
  rect: RectLike,
  viewport: { width: number; height: number },
  modifiers: number
): BrowserInputEvent | null {
  const point = toPageCoords(e.clientX, e.clientY, rect, viewport)
  if (!point) return null
  return {
    kind: 'wheel',
    x: point.x,
    y: point.y,
    deltaX: e.deltaX * WHEEL_SCALE,
    deltaY: e.deltaY * WHEEL_SCALE,
    modifiers
  }
}
