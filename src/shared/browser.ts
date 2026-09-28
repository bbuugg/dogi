/**
 * 浏览器自动化（Agent 的 `browser_*` 工具 + 会话页内嵌面板）：跨端共享的纯逻辑。
 *
 * 会话 id 是主进程与渲染端之间的唯一契约 —— 渲染端用同一个 id 订阅 screencast 帧，
 * 主进程用它路由事件。所以推导规则必须放在共享层，两边各写一份迟早会漂。
 * 视口预设同理：渲染端的切换按钮、主进程的 `setViewportSize`、Agent 工具的默认视口
 * 必须用同一份尺寸表。
 */
import type { BrowserViewportMode } from './types'

/** Agent 浏览器会话的 id 前缀 */
const AGENT_BROWSER_PREFIX = 'agent-browser:'

/**
 * 一个 Agent 会话对应一个浏览器会话。
 *
 * 用 `:` 而不是 `-` 作分隔：conversationId 是 UUID，本身含 `-`，
 * 用 `-` 会让 id 的边界看不出来。
 */
export function agentBrowserSessionId(conversationId: string): string {
  return `${AGENT_BROWSER_PREFIX}${conversationId}`
}

/** 反解出 conversationId（调试用；不是 agent 会话则返回 null） */
export function conversationIdOfBrowserSession(sessionId: string): string | null {
  return sessionId.startsWith(AGENT_BROWSER_PREFIX)
    ? sessionId.slice(AGENT_BROWSER_PREFIX.length)
    : null
}

// ---------------------------------------------------------------------------
// 视口预设
// ---------------------------------------------------------------------------

export interface BrowserViewportPreset {
  mode: BrowserViewportMode
  /** 切换按钮上的文字 */
  label: string
  /** 视口逻辑尺寸（CSS px）—— 决定页面走哪套响应式断点 */
  width: number
  height: number
  /** 浏览器上下文的 deviceScaleFactor（= 页面里的 window.devicePixelRatio） */
  dpr: number
}

/**
 * ⚠️ 视口**不跟随面板尺寸**。
 *
 * 面板宽度取决于用户把窗口拉多宽、分隔条拖到哪，把它当视口会让同一个页面在不同窗口
 * 大小下走不同的响应式断点（窗口窄了页面就变「手机版」），既不可复现也没法跟浏览器
 * 里手动看到的效果对齐。所以固定成两个预设，画面由 `object-contain` 缩放填进面板。
 *
 * `desktop` 用 1280×800@1x（与改动前的默认视口一致，Agent 工具也用它）；
 * `mobile` 用 390×844@2x（iPhone 14 的逻辑尺寸与 DPR），页面里的
 * `devicePixelRatio` 也真的是 2，站点才会按手机给图。
 */
export const BROWSER_VIEWPORT_PRESETS: Record<BrowserViewportMode, BrowserViewportPreset> = {
  desktop: { mode: 'desktop', label: 'PC', width: 1280, height: 800, dpr: 1 },
  mobile: { mode: 'mobile', label: '手机', width: 390, height: 844, dpr: 2 }
}

/** 默认 PC 屏 —— 打开浏览器时不该先看到移动版布局 */
export const DEFAULT_BROWSER_VIEWPORT: BrowserViewportMode = 'desktop'

/** 取预设；传入未知值时回退到默认，别让一个坏值把会话搞崩 */
export function browserViewportPreset(mode?: BrowserViewportMode): BrowserViewportPreset {
  return BROWSER_VIEWPORT_PRESETS[mode ?? DEFAULT_BROWSER_VIEWPORT] ?? BROWSER_VIEWPORT_PRESETS.desktop
}

// ---------------------------------------------------------------------------
// User-Agent
// ---------------------------------------------------------------------------

/**
 * UA 必须跟视口预设一起切。
 *
 * 光切视口只能让**响应式**的那部分跟着变；站点按 UA 分流的那部分（`m.xxx` 跳转、
 * 服务端按 UA 出模板）在下次请求前一直是老样子 —— 「视口是 PC、页面却是手机」最常见
 * 的来源就是这里。所以两个预设各自带一份 UA。
 *
 * 桌面 UA 用宿主浏览器**自己报的那份**（版本号真实、与 Sec-CH-UA 自洽）；
 * 手机 UA 只把平台段换成 Android，**Chrome 版本号沿用桌面 UA 的** —— 写死版本号
 * 迟早会和浏览器真实版本对不上，而那些做指纹一致性校验的站点就吃这一套。
 */
export function browserUserAgent(mode: BrowserViewportMode, actualDesktopUa: string): string {
  const desktop = (actualDesktopUa.trim() || FALLBACK_DESKTOP_USER_AGENT).replace(
    /HeadlessChrome/g,
    'Chrome'
  )
  if (mode !== 'mobile') return desktop
  const version = /Chrome\/([\d.]+)/.exec(desktop)?.[1] ?? '131.0.0.0'
  return `Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Mobile Safari/537.36`
}

/** 手机 UA 对应的 `navigator.platform`（桌面不覆盖，保持宿主原样） */
export const MOBILE_PLATFORM = 'Linux armv8l'

/** 读不到真实 UA 时的兜底；正常情况下走不到这里 */
export const FALLBACK_DESKTOP_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
