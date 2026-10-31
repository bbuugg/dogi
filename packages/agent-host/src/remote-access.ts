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
 * 暴露出去就不再「零 token」。启用时这里写进 `process.env.FIZZ_AUTH_PASS / _JWT_SECRET` ——
 * `authEnabled()` 与 `verifyWsToken` 都是**调用时**读环境变量（见 server 的
 * `lib/auth-jwt.ts`），所以不改 server 一行代码，登录接口 / JWT 中间件 / WS 鉴权就一并生效。
 *
 * `FIZZ_AUTH_PASS` 存的是**密码哈希**（scrypt），不是明文；为空表示还没设置密码，
 * 第一次从浏览器登录时输入的密码会被哈希后持久化（回调由桌面主进程提供）。
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
  /**
   * **全部**可用的局域网访问地址（每块非回环 IPv4 一条，私网段在前）。
   *
   * 多网卡机器上「哪一块才是别人能连到的」只有用户自己知道（WiFi / 有线 / VMware /
   * Docker / WSL / Tailscale 混在一起），所以这里全列出来让人挑，不替用户猜。
   * 没有对外网卡时是空数组。
   */
  urls: string[]
  /** `urls` 的第一条（保留旧字段，兼容既有调用点）；没有对外网卡时是 null */
  url: string | null
  /** 是否找到了 web 产物并开始同源托管（没有就只能当纯 API 用） */
  webServed: boolean
  /**
   * 是否找到了**手机版**产物并挂上 `/m/*` + 手机 UA 跳转。
   * 为 false 时手机浏览器拿到的是 web 的响应式布局（不是报错，只是没有手机版外壳）。
   */
  mobileServed: boolean
  error?: string
}

let server: Server | null = null
let info: RemoteAccessInfo | null = null
/** 启动时注入的持久化撤销函数（server 模块是动态加载的，stop 时不一定还拿得到） */
let clearPasswordPersister: (() => void) | null = null

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

/**
 * 找**手机版**产物目录（`apps/mobile/dist-server`，`npm run build:mobile:hosted` 的产物）。
 *
 * 为什么必须在这里显式找一遍：server 的 `app.ts` 只认 `FIZZ_MOBILE_DIR`，缺省值写的是
 * `join(import.meta.dirname, '../../mobile/dist-server')` —— 那个相对路径只在
 * `apps/server/{src,dist}` 这种「包目录还躺在仓库里」的布局下成立。桌面端把 server
 * 打进 `out/main` 的 bundle 后，`import.meta.dirname` 变成 `apps/desktop/out/main`
 * 或 asar 里的 `<app>/out/main`，怎么拼都拼不到 `apps/mobile/dist-server`。
 * 于是 `app.ts` 里 `existsSync(MOBILE_DIR/index.html)` 为假，`/m/*` 与手机 UA 的 302
 * **整段不挂** —— 手机打开只拿到 web 产物，走 web 的响应式布局。
 */
function resolveMobileDir(hint?: string): string | null {
  const resourcesPath = (process as unknown as { resourcesPath?: string }).resourcesPath
  // 候选覆盖：桌面形态的 hint、仓库根（npm run dev:desktop）、apps/desktop（electron .）、
  // apps/desktop/out/main（dev 主进程目录）、打包后的 resources 目录
  const candidates = [
    hint,
    process.env.FIZZ_MOBILE_DIR,
    join(process.cwd(), 'apps/mobile/dist-server'),
    join(process.cwd(), 'mobile/dist-server'),
    join(process.cwd(), '../mobile/dist-server'),
    join(process.cwd(), '../../mobile/dist-server'),
    // 打包形态：electron-builder 的 extraResources 把 hosted 产物放在 <resources>/mobile-dist
    resourcesPath ? join(resourcesPath, 'mobile-dist') : undefined
  ]
  for (const dir of candidates) {
    if (dir && existsSync(join(dir, 'index.html'))) return dir
  }
  return null
}

/**
 * 列出**所有**可用的访问地址（每块非回环 IPv4 一条）。
 *
 * 为什么不再只挑一个：`networkInterfaces()` 的枚举顺序由系统决定，多网卡机器
 * （WiFi + 有线 + VMware / VirtualBox / Docker / WSL / Tailscale）里第一条经常是
 * 一块虚拟网卡 —— 用户把那个地址抄给别人，对方在局域网里根本打不开，还会以为功能坏了。
 * 全列出来让人自己挑，比猜一个「最像的」可靠。
 *
 * 排序：私网段优先（192.168 → 10 → 172.16-31），其余（公网 / 虚拟网卡）靠后；
 * 169.254.*（APIPA 自分配，只在本机链路有效）直接丢掉。
 */
function listUrls(port: number): string[] {
  const found: string[] = []
  for (const addrs of Object.values(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family !== 'IPv4' || addr.internal) continue
      if (addr.address.startsWith('169.254.')) continue
      found.push(addr.address)
    }
  }
  /** 私网段档位：越小越像「真正的局域网」 */
  const rank = (ip: string): number => {
    if (ip.startsWith('192.168.')) return 0
    if (ip.startsWith('10.')) return 1
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 2
    return 3
  }
  /** 按四段数值比大小（字符串比较会把 .10 排到 .2 前面） */
  const numeric = (ip: string): number =>
    ip.split('.').reduce((acc, part) => acc * 256 + (Number(part) || 0), 0)
  // 同一地址可能挂在多块网卡上（有线 + 网桥），去重后再排
  return [...new Set(found)]
    .sort((a, b) => rank(a) - rank(b) || numeric(a) - numeric(b))
    .map((ip) => `http://${ip}:${port}`)
}

export async function startRemoteAccess(opts: {
  port: number
  /** 已保存的密码哈希；空 / 缺省 = 首次登录时设置新密码 */
  passwordHash?: string
  /** 首次登录设置密码后，把哈希交给宿主落盘（桌面端写 window-prefs.json） */
  persistPasswordHash?: (hash: string) => void
  /** web 产物目录提示（打包形态由主进程传 `process.resourcesPath` 下的路径） */
  webDirHint?: string
  /** 手机版产物目录提示（同上；缺省时按 resolveMobileDir 的候选列表找） */
  mobileDirHint?: string
}): Promise<RemoteAccessInfo> {
  stopRemoteAccess()
  const next: RemoteAccessInfo = {
    running: false,
    port: opts.port,
    urls: [],
    url: null,
    webServed: false,
    mobileServed: false
  }

  try {
    const webDir = resolveWebDir(opts.webDirHint)
    if (webDir) process.env.FIZZ_WEB_DIR = webDir
    const mobileDir = resolveMobileDir(opts.mobileDirHint)
    if (mobileDir) process.env.FIZZ_MOBILE_DIR = mobileDir
    // 打开鉴权（调用时读环境变量，见上「鉴权」一节）。密码只存哈希。
    process.env.FIZZ_AUTH_PASS = opts.passwordHash ?? ''
    process.env.FIZZ_JWT_SECRET = randomBytes(32).toString('base64url')

    // app.ts / state.ts 已被 manager 加载过（globalThis 单例），这里直接复用缓存模块
    const [{ createApp, setPasswordPersister }, { attachWebSockets }] = await Promise.all([
      import('@fizz/server'),
      import('@fizz/server/ws')
    ])
    // 首次登录写入的哈希交给桌面主进程持久化（重启后仍能校验）
    setPasswordPersister((hash) => opts.persistPasswordHash?.(hash))
    clearPasswordPersister = () => setPasswordPersister(null)
    const app = createApp({ auth: true, staticWeb: !!(webDir || mobileDir) })
    next.webServed = !!webDir
    next.mobileServed = !!mobileDir
    if (!mobileDir) {
      console.warn(
        '[remote-access] 没找到手机版产物（apps/mobile/dist-server）：手机浏览器会回退到 web 的响应式布局。' +
          '跑 `npm run build:mobile:hosted` 重建；打包形态还要确认 extraResources 里有 mobile-dist。'
      )
    }

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
    // 监听成功后才算「这些地址现在真的能连」—— 端口占用失败时列表留空，界面显示 error
    next.urls = listUrls(opts.port)
    next.url = next.urls[0] ?? null
  } catch (err) {
    next.error = err instanceof Error ? err.message : String(err)
  }

  info = next
  return info
}

export function stopRemoteAccess(): void {
  server?.close()
  server = null
  if (info) info = { ...info, running: false, urls: [], url: null }
  clearPasswordPersister?.()
  clearPasswordPersister = null
  // 鉴权随关闭一并撤掉：进程内路径本就不走它，留着只会让下一次启用前状态含糊
  delete process.env.FIZZ_AUTH_PASS
  delete process.env.FIZZ_JWT_SECRET
  // 手机版目录同理（server 的 app.ts 在 createApp 时**调用时**读取它）
  delete process.env.FIZZ_MOBILE_DIR
}

export function getRemoteAccessInfo(): RemoteAccessInfo {
  return (
    info ?? {
      running: false,
      port: 0,
      urls: [],
      url: null,
      webServed: false,
      mobileServed: false
    }
  )
}
