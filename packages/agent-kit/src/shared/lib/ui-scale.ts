/**
 * 把「按 16px 根字号设计的 px 值」换算成当前根字号下的 px。
 *
 * 为什么需要它：手机端的整体放大靠**抬 `<html>` 的根字号**（见 `styles.css` 的
 * 「手机端整体放大」），而那个开关只对 **rem** 生效。Monaco / xterm 的字号是它们自己那套
 * px 选项（`fontSize: 13`），rem 管不到 —— 不换算的话，手机端界面长大了、编辑器里的字
 * 却是全场唯一没长的那一份，看着像被缩过。
 *
 * 基准刻意定在 **16px**（浏览器默认根字号），于是：
 * - 桌面端（根字号 16px）返回值与原字面量**逐像素相同**，这个函数等于透明；
 * - 手机端根字号 18px 时自动 ×1.125（13 → 15）；
 * - 用户若在系统 / 浏览器里调大了默认字号，编辑器也跟着变 —— 白捡的正确行为。
 *
 * ⚠️ **在需要时读一次**（组件初始化 / 建实例时），别缓存成模块级常量：根字号会随
 * `<768px` 那条媒体查询当场改变（手机横竖屏、桌面窗口拖宽拖窄），模块级常量会永远停在
 * 首次 import 时的值。与终端那边一致 —— `TerminalPanel` 的 `loadFontSize()` 也是
 * 「挂载时读一次」，编辑器同此待遇，用户想再调有滚轮 / `Ctrl+±`。
 *
 * ⚠️ 只管**字号**。容器上下限（`max-w-*` / `w-[380px]`）、发丝线（`ring-[3px]`）、
 * 装饰光晕（`blur-[110px]`）都是**跟视口走**的，故意不换算 —— 跟着字号膨胀会在 390px
 * 屏上溢出。判据见 `styles.css` 里那段注释。
 */
export function scalePx(basePx: number): number {
  if (typeof window === 'undefined') return basePx
  const root = Number.parseFloat(
    window.getComputedStyle(window.document.documentElement).fontSize
  )
  if (!Number.isFinite(root) || root <= 0) return basePx
  return Math.round((basePx * root) / 16)
}
