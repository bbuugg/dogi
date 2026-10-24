/**
 * 远程访问：把进程内后端暴露到一个**真实端口**上，让浏览器里的 web 端直接连。
 *
 * 与内部 WS 端口（`manager.ts`）的区别：那个只为 `upgrade` 存在、绑 127.0.0.1、
 * 渲染端也只经 IPC 间接用；这个是用户在设置里显式打开的「把桌面端当服务器用」——
 * 绑 0.0.0.0、带鉴权、顺手把 web 产物**同源托管**出去，浏览器打开
 * `http://<本机ip>:<port>` 就是完整的 web 工作台（web 端零改动：它的连接页本就
 * 固定打当前 host，登录后 token 走 Bearer / `?token=`）。
 *
 * ## 鉴权
 *
 * 暴露出去就不再「零 token」。启用时由调用方给一套凭据，这里写进
 * `process.env.FIZZ_AUTH_USER / _PASS / _JWT_SECRET` —— `authEnabled()` 与
 * `verifyWsToken` 都是**调用时**读环境变量（见 server 的 `lib/auth-jwt.ts`），
 * 所以不改 server 一行代码，登录接口 / JWT 中间件 / WS 鉴权就一并生效。
 *
 * ⚠️ 只影响**这个新起的 app 实例**：进程内的 `app.fetch()`（`auth: false`，
 * 根本没装中间件）不受影响；内部 WS 的 loopback server 也由 manager 显式
 * `attachWebSockets(..., { auth: false })` 关掉了鉴权 —— 否则这里设置的
 * `FIZZ_AUTH_*` 会让内部所有 WS 升级被 401 拒掉（verifyWsToken 是**调用时**
 * 读环境变量，不认 createApp 的选项，实测踩过）。桌面端自己的体验不变，
 * 这也是这里要**再 createApp 一次**而不是复用 manager 里那个实例的原因。
 *
 * ## 为什么不复用 manager 的 app
 *
 * `createApp({ auth })` 的差别是「装不装 JWT 中间件」，而两个实例读的是**同一个**
 * `lib/server/state.ts` 的 globalThis 单例（store / domain / triggerDomain 全共享），
 * 所以「桌面自己走免鉴权直连、外部走带鉴权 HTTP」可以并存，互不知道对方存在。
 */
import { createServer, type Server } from 'node:http'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { networkInterfaces } from 'node:os'
import { randomBytes } from 'node:crypto'
import { getRequestListener } from '@hono/node-server'

export interface RemoteAccessInfo {
  running: boolean
  port: number
  /** 局域网访问地址（取一块非回环 IPv4）；没有对外网卡时是 null */
  url: string | null
  username: string
  password: string
  /** 是否找到了 web 产物并开始同源托管（没有就只能当纯 API 用） */
  webServed: boolean
  error?: string
}

let server: Server | null = null
let info: RemoteAccessInfo | null = null

/**
 * 找 web 产物目录（`index.html` 存在才算）。桌面主进程会用 `process.cwd()` 提示，
 * 打包形态可经 `extraResources` 放进 `process.resourcesPath` 再用 hint 传进来。
 */
function resolveWebDir(hint?: string): string | null {
  // 打包形态：electron-builder 的 extraResources 把 web 产物放在 <resources>/web-dist
  const resourcesPath = (process as unknown as { resourcesPath?: string }).resourcesPath
  // 候选覆盖：仓库根（npm run dev:desktop）、apps/desktop（electron .）、
  // apps/desktop/out/main（dev 主进程目录）、打包后的 resources 目录
  const candidates = [
    hint,
    process.env.FIZZ_WEB_DIR,
    join(process.cwd(), 'apps/web/dist'),
    join(process.cwd(), 'web/dist'),
    join(process.cwd(), '../web/dist'),
    join(process.cwd(), '../../web/dist'),
    resourcesPath ? join(resourcesPath, 'web-dist') : undefined
  ]
  for (const dir of candidates) {
    if (dir && existsSync(join(dir, 'index.html'))) return dir
  }
  return null
}

/** 从非回环网卡挑一个 IPv4，拼出「别人能用浏览器打开」的地址 */
function lanUrl(port: number): string | null {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) return `http://${addr.address}:${port}`
    }
  }
  return null
}

/** 随机密码：去掉易混字符（0/O、1/l/I），8 位够局域网用了 */
export function generateRemotePassword(): string {
  const alphabet = '23456789abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ'
  const bytes = randomBytes(8)
  return [...bytes].map((b) => alphabet[b % alphabet.length]!).join('')
}

export async function startRemoteAccess(opts: {
  port: number
  username: string
  password: string
  /** web 产物目录提示（打包形态由主进程传 `process.resourcesPath` 下的路径） */
  webDirHint?: string
}): Promise<RemoteAccessInfo> {
  stopRemoteAccess()
  const next: RemoteAccessInfo = {
    running: false,
    port: opts.port,
    url: null,
    username: opts.username,
    password: opts.password,
    webServed: false
  }

  try {
    const webDir = resolveWebDir(opts.webDirHint)
    if (webDir) process.env.FIZZ_WEB_DIR = webDir
    // 打开鉴权（调用时读环境变量，见上「鉴权」一节）
    process.env.FIZZ_AUTH_USER = opts.username
    process.env.FIZZ_AUTH_PASS = opts.password
    process.env.FIZZ_JWT_SECRET = randomBytes(32).toString('base64url')

    // app.ts / state.ts 已被 manager 加载过（globalThis 单例），这里直接复用缓存模块
    const [{ createApp }, { attachWebSockets }] = await Promise.all([
      import('@fizz/server'),
      import('@fizz/server/ws')
    ])
    const app = createApp({ auth: true, staticWeb: !!webDir })
    next.webServed = !!webDir

    const requestListener = getRequestListener(app.fetch)
    /**
     * 这个监听器**只服务工作台**（与独立部署的 `apps/server/src/index.ts` 同一套）。
     *
     * 容器预览走**独立的公网入口监听器**（`FIZZ_PUBLIC_HTTP_PORT`），由
     * `startBackgroundServices()` 拉起（桌面端进程内后端同样会调到）。所以这里不做
     * Host 分派、也不用登记「对外监听」。
     */
    const httpServer = createServer((req, res) => requestListener(req, res))
    // 同一个端口承载 WS（状态推送 / 工作台 / 终端 —— web 端的终端就是服务端 PTY）
    attachWebSockets(httpServer)
    await new Promise<void>((resolve, reject) => {
      httpServer.once('error', reject)
      httpServer.listen(opts.port, '0.0.0.0', () => resolve())
    })

    server = httpServer
    next.running = true
    next.url = lanUrl(opts.port)
  } catch (err) {
    next.error = err instanceof Error ? err.message : String(err)
  }

  info = next
  return info
}

export function stopRemoteAccess(): void {
  server?.close()
  server = null
  if (info) info = { ...info, running: false, url: null }
  // 鉴权随关闭一并撤掉：进程内路径本就不走它，留着只会让下一次启用前状态含糊
  delete process.env.FIZZ_AUTH_USER
  delete process.env.FIZZ_AUTH_PASS
  delete process.env.FIZZ_JWT_SECRET
}

export function getRemoteAccessInfo(): RemoteAccessInfo {
  return (
    info ?? {
      running: false,
      port: 0,
      url: null,
      username: 'fizz',
      password: '',
      webServed: false
    }
  )
}
