/**
 * 「把 URL 交给系统」的**唯一入口 + 唯一协议白名单**。
 *
 * 两个调用方：
 * - `transport-ipc` 的 `agent:system:openExternal` —— 渲染端**显式**请求开外链
 *   （`@fizz/agent-kit` 的 `openExternal` 最终落到这里）；
 * - 主进程窗口的 `setWindowOpenHandler` / `will-navigate` —— 渲染端**漏调**上面的 IPC、
 *   直接 `window.open` / 改 `location` 时的兜底。
 *
 * ⚠️ 为什么必须有兜底：`window.open` 在**没注册 `setWindowOpenHandler`** 的窗口上，
 * Electron 的默认行为是**新建一个内置 `BrowserWindow`** 加载那个 URL（没有地址栏、
 * 没有前进后退）—— 终端里 Ctrl+左键点 URL 弹出的「内置窗口」就是这么来的。
 *
 * 白名单只有一份，两处共用，免得各写一套协议判断再慢慢漂移。
 */
import { shell } from 'electron'

/** 允许交给系统默认程序处理的协议。`file:` / 自定义协议一律拒 —— 避免渲染端被诱导拉起任意协议处理器 */
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])

/** URL 是否在白名单内（格式不合法也算不允许） */
export function isAllowedExternalUrl(url: string): boolean {
  try {
    return ALLOWED_PROTOCOLS.has(new URL(url).protocol)
  } catch {
    return false
  }
}

/**
 * 用系统默认程序打开 URL（协议白名单）。
 * **永不抛**：失败以 `{ ok: false, error }` 返回，方便 IPC 直接当返回值用。
 */
export function openExternalUrl(url: string): { ok: boolean; error?: string } {
  let protocol: string
  try {
    protocol = new URL(url).protocol
  } catch {
    return { ok: false, error: '链接格式不合法' }
  }
  if (!ALLOWED_PROTOCOLS.has(protocol)) {
    return { ok: false, error: `不允许的协议：${protocol}` }
  }
  void shell.openExternal(url)
  return { ok: true }
}
