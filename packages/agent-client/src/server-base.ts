/**
 * 服务端地址（`serverBase`）的**唯一真源**。
 *
 * 为什么单开一个模块：`api.ts`（请求层）和 `host.ts`（宿主单例）都要读它，而 `host.ts`
 * 反过来又被 `api.ts` 依赖（`getAgentHostOrNull`）—— 把状态放这两个里必然形成循环依赖。
 * 这里零依赖，谁都能引。
 *
 * 两种形态：
 * - **同源**（`serverBase` 为空）：页面由 server 托管，`/api`、SSE、WS 都按页面 origin 解析。
 *   线上 web、`npm run dev` 的 web、desktop（进程内 IPC）都是这个形态，行为逐字不变；
 * - **跨源**（`serverBase` 是绝对地址）：页面由别处托管（独立 vite 工程 / Capacitor 本地
 *   `www` 的 `https://localhost`），所有出口必须先接成绝对地址，否则一律打到页面自己的 origin。
 *
 * 地址来源（`setServerBase`，由各端 `main.tsx` 在 render 之前注入）：
 * web `?server=` / `VITE_FIZZ_SERVER_URL`，mobile 登录页填写并保存到本机的地址。
 */

/**
 * 显式覆盖的服务端地址（`http://host:port`）。`null` = 没覆盖、按同源走。
 *
 * 模块级一份而不是塞进 `AgentHost`：同一份覆盖要同时喂给 `host.loadConnection()`
 * （把地址补进 `Connection`）、`createApi` 的请求层、以及不经 `createApi` 的媒体加载
 * （`media-url.ts`），经宿主持有会漏掉其中一条。
 */
let serverBaseOverride: string | null = null

/**
 * 规整服务端地址：去空白、补协议、去结尾斜杠。
 *
 * - 空 / 只有空白 → `undefined`（同源）；
 * - 没写协议（`192.168.1.5:7801`）→ 补 `http://`：Capacitor / 手输地址最常见的写法；
 * - 去结尾斜杠，否则拼出来会是 `//api/...`（部分反向代理会把它当成协议相对地址）。
 *
 * 只看形状不看可达性 —— 连不连得上由 `health()` 说话。
 */
export function normalizeServerBase(raw: string | null | undefined): string | undefined {
  const trimmed = (raw ?? '').trim()
  if (!trimmed) return undefined
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
  return withScheme.replace(/\/+$/, '')
}

/**
 * 把 `/api/...` 这样的**服务端相对路径**接到 `serverBase` 上。
 *
 * - `serverBase` 空（同源）→ 原样返回，`fetch` / `WebSocket` 按当前 origin 解析；
 * - 已经是绝对地址（`http(s)://…` / `ws(s)://…`）→ 原样返回（幂等，调用方不必先判断）。
 */
export function resolveServerUrl(serverBase: string | undefined, path: string): string {
  if (!serverBase) return path
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) return path
  return `${serverBase}${path.startsWith('/') ? path : `/${path}`}`
}

/**
 * 指定服务端地址（在**任何请求之前**、通常在 `main.tsx` 里调）。
 *
 * - 传 `null` / 空 = 清掉覆盖，回到同源；
 * - 地址会被 `normalizeServerBase` 规整（补协议、去结尾斜杠）；
 * - 之后 `host.loadConnection()` 返回的连接信息都会带上它，于是 API / SSE / WS 全部打到这个地址。
 *
 * ⚠️ 已经建好的 `createApi` 实例不会跟着变（`serverBase` 在创建时定格）—— 所以必须在
 * render 之前调，否则会先按同源缓存一个 api（见 `agent-kit` 的 `apiForConnection`）。
 */
export function setServerBase(serverBase: string | null | undefined): void {
  serverBaseOverride = normalizeServerBase(serverBase) ?? null
}

/** 取当前的服务端地址覆盖；`null` = 同源 */
export function getServerBaseOverride(): string | null {
  return serverBaseOverride
}

/** 便捷组合：把相对路径接到**当前覆盖**上（没覆盖 = 原样返回，同源） */
export function resolveCurrentServerUrl(path: string): string {
  return resolveServerUrl(serverBaseOverride ?? undefined, path)
}
