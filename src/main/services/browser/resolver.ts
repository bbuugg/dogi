import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { chromium, type LaunchOptions } from 'playwright'
import type { BrowserCandidate, BrowserChannel } from '@shared/types'

/**
 * 浏览器来源解析。
 *
 * 为什么不用 `chromium.executablePath({ channel })`：实测（Playwright 1.63）
 * 它**忽略 channel 参数**，无论传什么都返回自带 Chromium 的路径，
 * 拿它判断「系统装没装 Edge」会得到错误答案。
 *
 * 所以自带 Chromium 走 executablePath 探测，系统浏览器走常见安装路径探测；
 * auto 模式则按候选顺序**逐个尝试启动**，第一个成功的即采用 —— 比事先猜更可靠
 * （Playwright 内部解析 channel 的细节我们不该复制一份）。
 */

/** Playwright 自带 Chromium 的真实路径；没下载过则 null */
export function bundledChromiumPath(): string | null {
  try {
    const p = chromium.executablePath()
    return p && existsSync(p) ? p : null
  } catch {
    // 未安装 / 版本不匹配时 Playwright 会抛错，视作不可用
    return null
  }
}

/** 系统浏览器的常见安装位置（覆盖 Win / macOS / Linux） */
function systemBrowserPaths(kind: 'msedge' | 'chrome'): string[] {
  const win = process.platform === 'win32'
  const mac = process.platform === 'darwin'
  const local = process.env.LOCALAPPDATA ?? ''

  if (kind === 'msedge') {
    if (win) {
      return [
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
      ]
    }
    if (mac) return ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']
    return ['/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable']
  }

  if (win) {
    return [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      local ? join(local, 'Google', 'Chrome', 'Application', 'chrome.exe') : ''
    ].filter(Boolean)
  }
  if (mac) return ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
  return ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium']
}

function firstExisting(paths: string[]): string | null {
  return paths.find((p) => existsSync(p)) ?? null
}

/** 探测本机可用的浏览器，供设置页展示 */
export function detectBrowsers(): BrowserCandidate[] {
  const bundled = bundledChromiumPath()
  const edge = firstExisting(systemBrowserPaths('msedge'))
  const chrome = firstExisting(systemBrowserPaths('chrome'))
  return [
    {
      channel: 'bundled',
      label: 'Playwright 自带 Chromium',
      path: bundled,
      available: Boolean(bundled)
    },
    { channel: 'msedge', label: 'Microsoft Edge', path: edge, available: Boolean(edge) },
    { channel: 'chrome', label: 'Google Chrome', path: chrome, available: Boolean(chrome) }
  ]
}

/** 一次启动尝试：`label` 用于日志与状态展示 */
export interface LaunchAttempt {
  label: string
  options: LaunchOptions
}

/**
 * 按偏好排出启动尝试顺序。auto = 自带 → Edge → Chrome。
 *
 * 返回的是**有序候选**而不是单个结果：channel 能否解析由 Playwright 内部决定
 * （注册表 / PATH / 安装位置各有各的规则），逐个试比复制它的解析逻辑更稳。
 *
 * ⚠️ 自带 Chromium 用 `channel: 'chromium'` 而不是裸 `headless: true`：
 * Playwright 1.63 下后者默认走 `chromium-headless-shell`（另一个 build），
 * 而 headless shell 并不保证提供 screencast —— 画面会黑。`channel: 'chromium'`
 * 强制用完整 Chromium 的新 headless 模式，screencast 实测正常。
 */
export function launchAttempts(pref: BrowserChannel): LaunchAttempt[] {
  const bundled: LaunchAttempt = { label: 'Chromium', options: { channel: 'chromium' } }
  const edge: LaunchAttempt = { label: 'Edge', options: { channel: 'msedge' } }
  const chrome: LaunchAttempt = { label: 'Chrome', options: { channel: 'chrome' } }

  switch (pref) {
    case 'bundled':
      return [bundled]
    case 'msedge':
      return [edge]
    case 'chrome':
      return [chrome]
    default:
      // 自带 Chromium 没下载过就别放进候选：Playwright 会抛
      // 「Executable doesn't exist」而不是自动跳过，白白多一次失败往返。
      return [bundledChromiumPath() ? bundled : null, edge, chrome].filter(
        (a): a is LaunchAttempt => a !== null
      )
  }
}
