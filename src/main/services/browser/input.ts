import type { BrowserInputEvent, BrowserMouseButton } from '@shared/types'

/**
 * 渲染端的合成输入 → CDP 命令的翻译（纯函数，便于单独验证）。
 *
 * 坐标由渲染端换算成页面视口坐标后再送进来，这里不做任何缩放计算。
 */

export interface CdpCommand {
  method: string
  params: Record<string, unknown>
}

/** CDP 的 buttons 位掩码：左=1 / 右=2 / 中=4 / 后退=8 / 前进=16 */
export function buttonBit(button: BrowserMouseButton): number {
  switch (button) {
    case 'left':
      return 1
    case 'right':
      return 2
    case 'middle':
      return 4
    case 'back':
      return 8
    case 'forward':
      return 16
    default:
      return 0
  }
}

/**
 * 按事件更新「当前按下的鼠标键」掩码。
 *
 * CDP 的 mousePressed / mouseReleased 需要 `buttons` 表示**此刻所有按下的键**，
 * 拖动类交互（拖拽、框选、canvas 画笔）全靠它 —— 只给 button 不给 buttons 时
 * 页面收到的是「没有按键按下」的移动，拖拽会断。
 */
export function nextButtonsMask(
  prev: number,
  type: 'mouseMoved' | 'mousePressed' | 'mouseReleased',
  button: BrowserMouseButton
): number {
  const bit = buttonBit(button)
  if (type === 'mousePressed') return prev | bit
  if (type === 'mouseReleased') return prev & ~bit
  return prev
}

/** 单个输入事件 → 一条 CDP 命令；无法翻译时返回 null */
export function toCdpCommand(input: BrowserInputEvent, buttonsMask: number): CdpCommand | null {
  switch (input.kind) {
    case 'mouse': {
      // CDP 要求 mouseMoved 在「没有按键按下」时 button 必须是 none，
      // 否则会把移动当成某个键的拖拽，页面拿到错误的事件序列。
      const button =
        input.type === 'mouseMoved' && buttonsMask === 0 ? 'none' : input.button
      return {
        method: 'Input.dispatchMouseEvent',
        params: {
          type: input.type,
          x: input.x,
          y: input.y,
          button,
          buttons: buttonsMask,
          clickCount: input.type === 'mouseMoved' ? 0 : input.clickCount,
          modifiers: input.modifiers
        }
      }
    }

    case 'wheel':
      return {
        method: 'Input.dispatchMouseEvent',
        params: {
          type: 'mouseWheel',
          x: input.x,
          y: input.y,
          deltaX: input.deltaX,
          deltaY: input.deltaY,
          modifiers: input.modifiers
        }
      }

    case 'key': {
      // 有可打印文本走 keyDown（会插入字符），否则走 rawKeyDown（只触发快捷键），
      // 与 Playwright 内部的做法一致 —— 用 keyDown 发不可打印键会插入空字符。
      const type = input.type === 'keyDown' ? (input.text ? 'keyDown' : 'rawKeyDown') : 'keyUp'
      const params: Record<string, unknown> = {
        type,
        key: input.key,
        code: input.code,
        windowsVirtualKeyCode: input.windowsVirtualKeyCode,
        nativeVirtualKeyCode: input.windowsVirtualKeyCode,
        modifiers: input.modifiers
      }
      if (input.text) {
        params.text = input.text
        params.unmodifiedText = input.text
      }
      return { method: 'Input.dispatchKeyEvent', params }
    }

    case 'text':
      // 输入法 / 粘贴：不经过按键，直接插入
      return { method: 'Input.insertText', params: { text: input.text } }

    default:
      return null
  }
}
