/**
 * 浏览器来源解析。
 *
 * 为什么不用 `chromium.executablePath({ channel })`：实测（Playwright 1.63）
 * 它**忽略 channel 参数**，无论传什么都返回自带 Chromium 的路径，
 * 拿它判断「系统装没装 Edge」会得到错误答案。
 *
 * 所以自带 headless shell 走目录探测，`launchAttempts` 的历史分支保留 channel 候选；
 * auto 模式则按候选顺序**逐个尝试启动**，第一个成功的即采用 —— 比事先猜更可靠
 * （Playwright 内部解析 channel 的细节我们不该复制一份）。
 *
 * ⚠️ 界面上的**来源选择已经撤掉**（统一走 Playwright 自带的 headless shell，见
 * contracts/browser.ts）：`msedge` / `chrome` 只剩历史数据与保底分支在用，
 * 新代码不要再往这里加来源，也不要再让界面依赖它。
 */
import type { LaunchOptions } from 'playwright'
import { browserRuntimeInfo } from '../playwright-browsers'
import type { BrowserChannel } from '@fizz/contracts'

/**
 * Playwright **自带 headless shell** 的目录；没下载过则 null。
 *
 * 判据取 headless shell（不是 `chromium.executablePath()` 指向的完整 chromium）：
 * 内置浏览器与 web_fetch / screenshot 共用同一份 headless shell（见 `launchAttempts`
 * 说明），完整 chromium 我们从不下载 —— 拿它当判据会永远得到「没装」。
 */
export function bundledChromiumPath(): string | null {
  try {
    const info = browserRuntimeInfo()
    return info.installed ? info.path : null
  } catch {
    return null
  }
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
 * ⚠️ 自带浏览器**不写 channel**（裸 `headless: true`）：这样走的是
 * `chromium-headless-shell`，与 web_fetch / screenshot 共用同一份。早先这里写
 * `channel: 'chromium'` 是想避开「headless shell 不带 screencast」的旧结论 ——
 * Playwright 1.64 实测 headless shell 的 screencast 正常出帧，而那条路要**完整
 * chromium**（433MB），我们从不下载它，于是内置浏览器在「只装了 shell」的机器上永远
 * 起不来（`Executable doesn't exist at …/chromium-<rev>/…`）。**别再切回去。**
 *
 * `auto` / `msedge` / `chrome` 只剩历史数据（`normalizeBrowserSettings` 会把它们
 * 收敛成 `bundled`），这条 switch 留着只为兜底时仍能跑，不要给它加新入口。
 */
export function launchAttempts(pref: BrowserChannel): LaunchAttempt[] {
  const bundled: LaunchAttempt = { label: 'Chromium', options: {} }
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
