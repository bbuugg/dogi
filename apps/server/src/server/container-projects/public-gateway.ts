/**
 * 公网入口：把 `<slug>.<域名>` 的请求反代到**容器内预览服务**在宿主上映射的端口。
 *
 * ## ⚠️ 它是一份**独立的 HTTP 监听器**（第二个端口）
 *
 * 监听 `FIZZ_PUBLIC_HTTP_PORT`（默认 `0` = 不启用），与工作台端口各占一个。这个端口上
 * **只有预览**：请求进来 → 认出 Host 是「配置域名下正好一层子域」且 slug 真有容器项目 →
 * 反代到该项目的预览宿主端口；认不出的一律 **404，绝不回落**到工作台（独立端口上没有
 * 工作台，回落等于把管理界面挂在公网域名上）。
 *
 * ⚠️ 恢复「独立端口」而不是挂在主服务上按 Host 分派，是明确取舍：主服务的 Host 分派
 * 会把预览与工作台挤在同一个端口（用户要开第二个端口才安全地单独暴露预览时做不到）。
 * 代价是部署方要多开一个端口 + 一层反代（TLS、泛解析证书）。
 *
 * ## 为什么是裸 `node:http` 处理函数，不是 Hono 中间件
 *
 * 反代要**流式**转发请求体与响应体（预览服务可能是 SSE / 大文件下载 / 上传），还可能要走
 * **WS 升级**（前端 dev server 的 HMR）。Hono 的中间件模型是「拿 Request、还 Response」，
 * 两者都要把整条流物化出来，恰好丢掉这两件事。这里只做一件事：字节搬运。
 *
 * ## 域名的唯一出处
 *
 * `publicDomainNames()`（**只读设置页填的清单，可多个**）。改设置
 * **立刻生效** —— host 判定是每个请求现读的、逐个域名匹配，不需要重启、也不需要重挂监听。
 *
 * ## 「现在跑没跑」不缓存成第二种真相
 *
 * 端口每次都从 docker 现读（见 `lifecycle.ts` 的说明）。这里只缓存**最近一次解析到的
 * 端口**，且**每次使用前先探一下 TCP 还能不能连上** —— 缓存命中且能连 = 直接转发，
 * 否则重新走一遍「起容器 + 等端口」。没有这一层的话，预览页里几十个静态资源请求
 * 会各 spawn 两次 docker 进程（`docker version` + `docker ps`），代价明显。
 *
 * ## 监听状态登记
 *
 * `listen` 成功才 `notePublicGateway(port)`，失败 / 关闭置 `null` ——
 * `publicGatewayEnabled()` 读它决定「界面给不给公网地址」（端口被占用时不能给假地址）。
 */
import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { connect as netConnect, isIP } from 'node:net'
import { networkInterfaces } from 'node:os'
import type { Duplex } from 'node:stream'
import { PREVIEW_KEY_QUERY } from '@fizz/contracts/types'
import { appLog } from '@fizz/workspace'
import { matchPublicDomain } from './public-host'
import {
  canConnect,
  ensureContainerPreviewReady,
  notePublicGateway,
  previewProjectBySlug,
  publicDomainNames,
  publicPort
} from './lifecycle'

/** 预览 key 的 cookie 名：首次从 `?fizz_key=` 进来时种下，页面里的子资源请求靠它 */
const PREVIEW_KEY_COOKIE = 'fizz_preview_key'

/** 逐跳头：只在「这一段连接」里有意义，不该被转发到下一跳（与所有反代同一清单） */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'upgrade'
])

/** slug → 最近一次解析到的**预览宿主端口**；探测失败即丢弃（不落盘、不跨进程） */
const portCache = new Map<string, number>()

/** 一次请求的解析结果：要么给出能连的端口，要么给出该回的状态码 */
type Target =
  | {
      ok: true
      port: number
      slug: string
      /** 未发布项目首次带 key 进来时要种下的 cookie（后续子资源请求靠它） */
      setCookie?: string
    }
  | {
      ok: false
      status: 401 | 404 | 503
      reason?: string
      /** 401 且不是文档请求：只回一行字，不给输入页（图片 / 脚本不该看到 HTML） */
      silent?: boolean
    }

function hostOf(req: IncomingMessage): string {
  return req.headers.host ?? ''
}

/** query 里取一个参数（不走 `new URL`：`req.url` 是相对路径，没必要拼一个假 origin） */
function queryParamOf(req: IncomingMessage, name: string): string | undefined {
  const raw = req.url ?? '/'
  const q = raw.indexOf('?')
  if (q < 0) return undefined
  return new URLSearchParams(raw.slice(q + 1)).get(name) ?? undefined
}

function cookieOf(req: IncomingMessage, name: string): string | undefined {
  const header = req.headers.cookie
  if (!header) return undefined
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    if (part.slice(0, eq).trim() !== name) continue
    return decodeURIComponent(part.slice(eq + 1).trim())
  }
  return undefined
}

/** 浏览器侧是不是 https（反代后面靠 `x-forwarded-proto` 判，直连看 socket） */
function isHttps(req: IncomingMessage): boolean {
  const proto = req.headers['x-forwarded-proto']
  if (typeof proto === 'string') return proto.split(',')[0]!.trim() === 'https'
  return (req.socket as { encrypted?: boolean }).encrypted === true
}

/**
 * 种 key 的 cookie。
 *
 * `SameSite` 只能按浏览器侧协议二选一：https 用 `None; Secure` —— 应用内 iframe 是
 * **跨站**嵌入（web 端 `localhost:5173` 里套 `https://<slug>.<域名>`），`Lax` 在跨站
 * 子资源请求里根本不会带上，页面会白屏；http 下浏览器不接受 `None`，退回 `Lax`
 * （此时基本只有直接打开这一种访问方式）。
 */
function keyCookie(req: IncomingMessage, key: string): string {
  const attrs = [
    `${PREVIEW_KEY_COOKIE}=${encodeURIComponent(key)}`,
    'Path=/',
    'HttpOnly',
    'Max-Age=604800'
  ]
  attrs.push(...(isHttps(req) ? ['SameSite=None', 'Secure'] : ['SameSite=Lax']))
  return attrs.join('; ')
}

/** 文档请求才值得给一张「输入 key」的页面；脚本 / 图片 / XHR 一律只回状态码 */
function isDocumentRequest(req: IncomingMessage): boolean {
  const dest = req.headers['sec-fetch-dest']
  if (typeof dest === 'string') return dest === 'document' || dest === 'iframe' || dest === 'frame'
  const accept = req.headers.accept
  return typeof accept === 'string' && accept.includes('text/html')
}

/**
 * Host → 目标端口。
 *
 * 顺序：Host 不命中任何配置域名 / 不存在的 slug / 没有预览端口 → **一律 404**
 * （不区分原因 —— 区分就等于给了一个可枚举的探子）；**未发布 → 校验预览 key**；
 * 容器停着 → 先唤醒（`docker start` + 轮询预览端口），超时 → 503。
 *
 * key 校验放在端口缓存**之前**：否则「缓存里还留着端口」就等于把鉴权绕过去了。
 */
async function resolveTarget(host: string, req: IncomingMessage): Promise<Target> {
  const hit = matchPublicDomain(host, publicDomainNames())
  if (!hit) return { ok: false, status: 404 }
  // 每次请求现算项目索引（项目增删是低频动作，维护一份缓存只会多出「盘上删了、缓存还在」）
  const project = previewProjectBySlug(hit.slug)
  if (!project) return { ok: false, status: 404 }

  // 已发布 = 公开；未发布 = 必须带对 key（query 首次进入 / cookie 后续子资源）
  let setCookie: string | undefined
  if (!project.exposed) {
    const fromQuery = queryParamOf(req, PREVIEW_KEY_QUERY)
    const provided = fromQuery ?? cookieOf(req, PREVIEW_KEY_COOKIE)
    if (!project.previewKey || provided !== project.previewKey) {
      return { ok: false, status: 401, ...(isDocumentRequest(req) ? {} : { silent: true }) }
    }
    // 只有「从 query 带进来的」才种 cookie：cookie 已有效的请求不必反复下发
    if (fromQuery) setCookie = keyCookie(req, project.previewKey)
  }

  // 快路：上一次解析到的端口还能连上就用它（不 spawn docker）
  const cached = portCache.get(hit.slug)
  if (cached !== undefined && (await canConnect(cached))) {
    return { ok: true, port: cached, slug: hit.slug, ...(setCookie ? { setCookie } : {}) }
  }
  portCache.delete(hit.slug)

  const ready = await ensureContainerPreviewReady(project.workspaceId)
  if ('port' in ready) {
    portCache.set(hit.slug, ready.port)
    return { ok: true, port: ready.port, slug: hit.slug, ...(setCookie ? { setCookie } : {}) }
  }
  appLog.error('system', `公网入口：容器型项目 ${hit.slug} 的预览服务没就绪`, ready.reason)
  return { ok: false, status: 503, reason: ready.reason }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function sendText(res: ServerResponse, status: number, body: string): void {
  res.statusCode = status
  res.setHeader('content-type', 'text/plain; charset=utf-8')
  res.end(body)
}

/**
 * 503：容器还在冷启动。
 *
 * 自写一个**会自动重试**的页面（`meta refresh`），而不是甩一句错给用户 ——
 * 用户是从浏览器点进来的，等 30 秒再刷新是这里唯一合理的行为。
 */
function sendStartingPage(res: ServerResponse, reason: string): void {
  res.statusCode = 503
  res.setHeader('content-type', 'text/html; charset=utf-8')
  res.setHeader('retry-after', '3')
  res.end(
    [
      '<!doctype html><html lang="zh"><head><meta charset="utf-8">',
      '<meta http-equiv="refresh" content="3">',
      '<title>容器正在启动</title></head>',
      '<body style="font-family:system-ui;margin:3rem auto;max-width:36rem;line-height:1.6">',
      '<h1 style="font-size:1.1rem">容器正在启动…</h1>',
      `<p style="color:#666">${escapeHtml(reason)}</p>`,
      '<p style="color:#666">页面会每 3 秒自动重试。</p>',
      '</body></html>'
    ].join('')
  )
}

/**
 * 401：未发布项目的「输入预览 key」页。
 *
 * 只给**文档请求**看（脚本 / 图片拿到一张 HTML 只会更糟）。表单 `method=get` 不带 action，
 * 提交后就落在当前地址上（`?fizz_key=...`），服务端校验通过顺势种 cookie。
 */
function sendKeyPage(res: ServerResponse): void {
  res.statusCode = 401
  res.setHeader('content-type', 'text/html; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(
    [
      '<!doctype html><html lang="zh"><head><meta charset="utf-8">',
      '<meta name="viewport" content="width=device-width,initial-scale=1">',
      '<title>需要预览 key</title></head>',
      '<body style="font-family:system-ui;margin:3rem auto;max-width:24rem;line-height:1.6;padding:0 1rem">',
      '<h1 style="font-size:1.1rem">这个预览还没有对外发布</h1>',
      '<p style="color:#666">输入预览 key 继续。key 在项目的「容器设置」里，',
      '复制那条带 key 的完整链接也可以直接进来。</p>',
      '<form method="get">',
      `<input name="${PREVIEW_KEY_QUERY}" autofocus autocomplete="off" spellcheck="false" `,
      'style="width:100%;padding:.55rem .65rem;border:1px solid #ccc;border-radius:6px;font-size:1rem;box-sizing:border-box">',
      '<button type="submit" style="margin-top:.75rem;padding:.55rem 1.1rem;border:0;border-radius:6px;background:#111;color:#fff;font-size:.95rem;cursor:pointer">打开</button>',
      '</form></body></html>'
    ].join('')
  )
}

/** 普通请求：头部改写后整条流对拷（不物化 body，SSE / 大文件都走这一条） */
function forwardHttp(
  req: IncomingMessage,
  res: ServerResponse,
  port: number,
  /** 上游在**还没回响应头**时就断了（容器里那个服务没在讲 HTTP）—— 让调用方得以清掉端口缓存 */
  onUpstreamDown?: () => void,
  /** 未发布项目首次带 key 进来时种下的 cookie */
  setCookie?: string
): void {
  const headers: Record<string, string | string[]> = {}
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue
    if (HOP_BY_HOP.has(key.toLowerCase()) || key.toLowerCase() === 'host') continue
    headers[key] = value
  }
  // 目标是个回环地址：容器内的服务不该看到一个它不认识的外部 Host
  headers.host = `127.0.0.1:${port}`

  const upstream = request(
    { host: '127.0.0.1', port, method: req.method, path: req.url ?? '/', headers },
    (up) => {
      res.statusCode = up.statusCode ?? 502
      if (up.statusMessage) res.statusMessage = up.statusMessage
      for (const [key, value] of Object.entries(up.headers)) {
        if (value === undefined) continue
        const lower = key.toLowerCase()
        // `transfer-encoding` 交给 node 自己按有没有 content-length 决定，别照搬
        if (HOP_BY_HOP.has(lower) || lower === 'transfer-encoding') continue
        res.setHeader(key, value)
      }
      // 放在上游头之后：上游自己也可能 Set-Cookie（预览服务自己的会话），不能被我们覆盖掉
      if (setCookie) res.setHeader('set-cookie', setCookie)
      up.pipe(res)
    }
  )
  upstream.on('error', () => {
    if (res.headersSent) res.destroy()
    else {
      // 快路只看「连不连得上」，容器里那个服务死了它看不出来 —— 把缓存丢掉，
      // 下一个请求就会走 `ensureContainerPreviewReady` 的**真·HTTP 就绪探测**，
      // 于是用户拿到的是那张说明原因、每 3 秒自动重试的页面，而不是反复的裸 502。
      onUpstreamDown?.()
      sendText(res, 502, '预览服务没有响应（容器在，但里面的服务没在讲 HTTP）')
    }
  })
  // 客户端走了（用户切走 / 关标签页）：上游那条也没人读了，放掉它。
  // ⚠️ 不能用 `req.on('close')`：请求体读完它就会触发，那会把还在等响应的上游一起砍掉；
  //    判据是「响应还没写完」。
  res.on('close', () => {
    if (!res.writableEnded) upstream.destroy()
  })
  req.pipe(upstream)
}

/**
 * WS / 升级请求：用裸 socket 转发。
 *
 * 这里**不能**复用 `forwardHttp` —— 升级后那条连接不再是 HTTP 语义的东西，只能原样搬运
 * 字节。请求头逐条从 `req.rawHeaders` 重写（`Upgrade` / `Sec-WebSocket-*` 都在里面；
 * 用 `req.headers` 会丢大小写与重复项，有些服务端就认这个）。
 */
function forwardUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, port: number): void {
  const upstream = netConnect({ host: '127.0.0.1', port })
  upstream.once('connect', () => {
    const lines = [`${req.method ?? 'GET'} ${req.url ?? '/'} HTTP/1.1`]
    for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) {
      const key = req.rawHeaders[i]!
      if (key.toLowerCase() === 'host') continue
      lines.push(`${key}: ${req.rawHeaders[i + 1]!}`)
    }
    lines.push(`Host: 127.0.0.1:${port}`)
    upstream.write(`${lines.join('\r\n')}\r\n\r\n`)
    // 升级请求可能已经多读了一点字节（`head`），必须先补写过去，否则那截就丢了
    if (head.length > 0) upstream.write(head)
    upstream.pipe(socket)
    socket.pipe(upstream)
  })
  upstream.on('error', () => socket.destroy())
  socket.on('error', () => upstream.destroy())
  socket.on('close', () => upstream.destroy())
}

function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
  /**
   * ⚠️ 上来先兜住 socket 的错误：升级后的连接随时被对端掐掉，而 `resolveTarget` 里
   * 可能要冷启动（几十秒）。没有这条监听时，任何一次 write / pipe 失败都会在
   * **没人接收的 `'error'` 事件**上把整个进程带崩（Node 对未监听的 'error' 是抛）。
   */
  socket.on('error', () => socket.destroy())
  void resolveTarget(hostOf(req), req)
    .then((target) => {
      if (!target.ok) {
        if (socket.destroyed) return
        socket.write(`HTTP/1.1 ${target.status} \r\ncontent-length: 0\r\nconnection: close\r\n\r\n`)
        socket.destroy()
        return
      }
      forwardUpgrade(req, socket, head, target.port)
    })
    .catch(() => socket.destroy())
}

/** 独立公网入口的监听器（`startPublicGateway` 起，`stopPublicGateway` 关） */
let server: Server | null = null

/**
 * 起公网入口（**幂等**）。
 *
 * `FIZZ_PUBLIC_HTTP_PORT` 为 `0` / 未配 → **整体不启用、不报错**：没打算对外发布的用户
 * 本来就不配它，这不是错误状态。监听取不到域名也照样起（域名可以之后在设置里加，判定是
 * 每个请求现读的），只是没域名时所有请求都会落 404。
 *
 * 监听在所有网卡上 —— 公网流量就是从外部网卡进来的。
 */
export function startPublicGateway(): void {
  if (server) return
  const port = publicPort()
  if (port === 0) return
  const instance = createServer((req, res) => {
    void resolveTarget(hostOf(req), req)
      .then((target) => {
        if (!target.ok) {
          if (target.status === 503) sendStartingPage(res, target.reason ?? '正在启动')
          else if (target.status === 401) {
            if (target.silent) sendText(res, 401, 'Preview key required')
            else sendKeyPage(res)
          } else sendText(res, 404, 'Not Found')
          return
        }
        forwardHttp(req, res, target.port, () => portCache.delete(target.slug), target.setCookie)
      })
      .catch((err: unknown) => {
        appLog.error('system', `公网入口转发失败：${String(err)}`)
        if (!res.headersSent) sendText(res, 502, 'Bad Gateway')
        else res.destroy()
      })
  })
  instance.on('upgrade', (req, socket, head) => handleUpgrade(req, socket, head))
  instance.on('error', (err) => {
    appLog.error('system', `公网入口监听失败（:${port}）：${err.message}`)
    server = null
    notePublicGateway(null)
  })
  instance.listen(port, '0.0.0.0', () => {
    console.log(
      `[container-projects] 公网入口监听 :${port}（${
        publicDomainNames().map((d) => `*.${d}`).join(', ') || '未配域名，全部请求 404'
      }）`
    )
    notePublicGateway(port)
  })
  server = instance
}

/**
 * 停公网入口：关监听器、清端口缓存、把「在跑」的登记撤掉。
 *
 * 退出收尾（`shutdown.ts`）与后台停止（`background.ts`）都调它。
 */
export function stopPublicGateway(): void {
  server?.close()
  server = null
  notePublicGateway(null)
  portCache.clear()
}

/**
 * 域名解析提示里该指到哪儿（给设置页显示，纯文案）。
 *
 * - 已知公网 IP（`FIZZ_PUBLIC_IP`）→ 直接给；
 * - 否则给本机**非回环** IPv4 的第一个 —— 内网 / 同机反代时够用；
 * - 都没有（桌面端且没联网卡）→ `undefined`，前端只说「解析到这台机器」不给具体 IP。
 *
 * ⚠️ 不在这里做「公网 IP 探测」（外网请求）：设置页打开就发请求去问第三方，是隐私问题。
 */
export function suggestedPublicTarget(): string | undefined {
  const configured = process.env.FIZZ_PUBLIC_IP?.trim()
  if (configured) return isIP(configured) ? configured : undefined
  for (const addrs of Object.values(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) return addr.address
    }
  }
  return undefined
}
