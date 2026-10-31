/**
 * 客户端偏好的统一入口：`GET / POST /api/prefs`（全局一份）。
 *
 * ## 为什么是一个「通用 patch」而不是按 key 开接口
 *
 * 这批偏好有近 20 项（`@fizz/contracts` 的 `PREF_KEYS`），一项一个接口会长出 20 条
 * 形状雷同的路由，加一项就得再动一遍 `API_ROUTES` + 前端 api + 路由文件。这里收成一个：
 *
 * - POST body `{ prefs: { [key]: value } }` —— **提交几个 key 就改几个**，缺的保留；
 * - 白名单与归一化都在 `@fizz/contracts` 的 `normalizePrefsPatch` 里，认不出的 key /
 *   非法值**直接丢弃**（不会把用户原来的值冲成默认）；
 * - 应答永远是归一化后的**全量**一份，前端拿它对账。
 *
 * ## 为什么不用 WS 上行
 *
 * 写操作在本仓一律走 HTTP（JWT 鉴权、错误码、并发处理都现成），`state-ws` 只负责**下行**
 * 推送。要改成 WS 上行，得在快照协议之外再设计一套双向帧 + 请求-应答配对，收益只是省一次
 * HTTP —— 而客户端本来就会合并（`prefs-sync` 的 debounce：连续改 10 项只发一次）。
 *
 * ## 落盘之后
 *
 * `domain.savePrefs` 走 `store.mutate`，`makeLiveStore` 会自动 `markDirty(STORE_KEYS)`；
 * `STORE_KEYS` 里加了 `'prefs'`，于是 `state-ws` 把新快照推给**所有**连接 ——
 * 桌面主窗口、设置窗口、手机、另一个浏览器标签，看到的都是同一份。
 */
import type { PrefsPatch } from '@fizz/contracts'
import { domain } from '@/lib/server/state'
import { parseJsonBody } from '@/app/api/_lib/auth'

export async function GET(): Promise<Response> {
  return Response.json({ prefs: domain.getPrefs() })
}

export async function POST(request: Request): Promise<Response> {
  const body = await parseJsonBody<{ prefs?: PrefsPatch }>(request)
  // 归一化 + 白名单在领域层：认不出的 key / 非法值丢弃，缺的 key 保留原值
  return Response.json({ prefs: domain.savePrefs(body?.prefs) })
}
