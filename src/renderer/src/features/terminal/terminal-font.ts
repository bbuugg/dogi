/** 终端字号（Ctrl+滚轮 / Ctrl +/- 缩放）相关的共享常量与工具 */

/** 默认字号 */
export const TERMINAL_FONT_SIZE_DEFAULT = 13
/** 缩放下限 */
export const MIN_TERMINAL_FONT_SIZE = 8
/** 缩放上限 */
export const MAX_TERMINAL_FONT_SIZE = 32
/** 每次缩放步进 */
export const TERMINAL_FONT_SIZE_STEP = 1

/** 将字号限制在允许范围内并取整 */
export function clampTerminalFontSize(size: number): number {
  return Math.min(MAX_TERMINAL_FONT_SIZE, Math.max(MIN_TERMINAL_FONT_SIZE, Math.round(size)))
}
