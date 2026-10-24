/**
 * 安卓端「服务端地址」的本地保存。
 *
 * 壳里页面是**本地 `www`**（origin `https://localhost`），API / SSE / WS 必须打绝对地址。
 * 这个地址不再在构建期烘进产物（同一个 APK 可以连不同服务器），而是登录页填写后存在
 * `localStorage`：
 *
 * - `main.tsx` 在 render / `hydrateConnection()` 之前读出来交给 `setServerBase()`，
 *   所以已登录用户下次启动仍然直接连上次那台服务器；
 * - `ConnectGate` 用同一个值预填输入框，改地址后重新登录即可（旧地址的 token 不再可用，
 *   服务端会回 401）。
 *
 * 与 `fizz.mobile.connection` 分开存：登录失败 / 还没登录时也要记住用户填过的地址，
 * 否则每次重试都得重新敲一遍 IP。
 */
import { normalizeServerBase } from '@fizz/agent-client/api'

const SERVER_URL_KEY = 'fizz.mobile.serverUrl'

/** 读保存的服务地址；没存过 / 存坏了返回 `undefined`（= 未配置） */
export function loadServerUrl(): string | undefined {
  try {
    return normalizeServerBase(localStorage.getItem(SERVER_URL_KEY))
  } catch {
    return undefined
  }
}

/** 保存服务地址；传空 = 清掉（hosted 版回到同源） */
export function saveServerUrl(serverBase: string | null | undefined): void {
  try {
    const normalized = normalizeServerBase(serverBase)
    if (normalized) localStorage.setItem(SERVER_URL_KEY, normalized)
    else localStorage.removeItem(SERVER_URL_KEY)
  } catch {
    // 隐私模式 / 超额：本次仍可用（main / 登录流程已把地址交给 setServerBase），只是下次要重填
  }
}
