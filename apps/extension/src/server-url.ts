/**
 * 「服务端地址」的本地保存（扩展版）。
 *
 * 与手机版的 `apps/mobile/src/server-url.ts` 是**同一份逻辑、不同的键**：那边存
 * `fizz.mobile.serverUrl`，这里存 `fizz.ext.serverUrl`。
 *
 * ## 为什么要单独一份（而不是直接复用手机版那个模块）
 *
 * 登录页 `ConnectGate` 里写死了 `import { saveServerUrl } from '@/server-url'`，而本工程
 * 的 `@` 别名指向手机版 —— 不换掉的话，扩展会把地址存进 `fizz.mobile.serverUrl`。
 * 虽然两边 origin 不同（`chrome-extension://<id>` vs `https://localhost`）本来就不会串，
 * 但「这个壳存的东西全在 `fizz.ext.*` 下」是一条更容易守住的规矩，比「大部分是，除了
 * 那一个」好记。所以 `vite.config.ts` / `tsconfig.json` 里给这一个文件单开了别名。
 *
 * 地址为什么不烘进产物：同一个扩展可以连不同服务器（本机 7801、局域网、远端的都有），
 * 填一次记一辈子，换服务器就在登录页改。
 */
import { normalizeServerBase } from '@fizz/agent-client/api'

const SERVER_URL_KEY = 'fizz.ext.serverUrl'

/** 读保存的服务地址；没存过 / 存坏了返回 `undefined`（= 未配置） */
export function loadServerUrl(): string | undefined {
  try {
    return normalizeServerBase(localStorage.getItem(SERVER_URL_KEY))
  } catch {
    return undefined
  }
}

/** 保存服务地址；传空 = 清掉 */
export function saveServerUrl(serverBase: string | null | undefined): void {
  try {
    const normalized = normalizeServerBase(serverBase)
    if (normalized) localStorage.setItem(SERVER_URL_KEY, normalized)
    else localStorage.removeItem(SERVER_URL_KEY)
  } catch {
    // 隐私模式 / 超额：本次仍可用（登录流程已把地址交给 setServerBase），只是下次要重填
  }
}
