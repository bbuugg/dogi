/**
 * WebSocket 升级请求的**唯一分流器**。
 *
 * 服务端有几个 WS 端点，路径不同但共用同一个 HTTP 端口：
 * - `/api/terminal`            终端（键盘输入要往回写，必须双向）
 * - `/api/ssh-terminal`        SSH 主机终端
 * - `/api/state`               全局状态推送（快照 + 瞬时事件）
 * - `/api/browser`             浏览器面板（截图 / 操作的双向通道）
 * - `/api/api-client/ws`       接口调试的 WS 请求
 *
 * ## 为什么必须只有一个 `server.on('upgrade')`
 *
 * `serve()` 返回的 http server 把 `upgrade` 事件**广播给所有监听器**。如果每个端点
 * 各挂一个监听器，两个回调会同时收到同一条升级请求，各自看到「路径不是我的」就
 * `socket.destroy()` —— 先跑的把连接掐了，后跑的面对一个已销毁的 socket。结果
 * **所有 WS 都连不上**。所以只能在这里挂一次，判完路径再分发给对应的 handler。
 *
 * ⚠️ 加新端点就往这个分流器加分支，**别在各自的模块里自己挂 `server.on('upgrade')`**。
 *
 * ## 兜底
 *
 * 这个回调里**任何抛出都是 uncaughtException**，会直接干掉整个服务端进程
 * （`upgrade` 不在 Hono `onError` 的覆盖范围内，见 `terminal/ws.ts` 的说明）。
 * 所以最外层包一层 try/catch：与其让进程死，不如拒掉这一条连接、留条日志。
 */
import { TERMINAL_WS_PATH, SSH_TERMINAL_WS_PATH } from '@fizz/contracts/agent-api'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { rejectSocket, resolveUpgradeUrl, type UpgradeableServer } from './lib/ws'
import { handleTerminalUpgrade } from './terminal/ws'
import { handleSshTerminalUpgrade } from './ssh/ws'
import { handleStateUpgrade, matchStatePath } from './state-ws'
import { handleBrowserUpgrade, matchBrowserPath } from './browser-ws'
import { handleApiClientWsUpgrade, matchApiClientWsPath } from './api-client-ws'

/**
 * 处理一条升级请求：路径属于我们的 WS 端点就接手并返回 `true`，否则返回 `false`
 * （交给别的 upgrade 处理器 —— 比如 Next.js 的 HMR 通道）。
 *
 * `auth` = 是否校验 `?token=`。**桌面进程内的 loopback server 必须传 false**：
 * 那条通道只服务于渲染端 IPC 桥（不出进程，没有第三方能碰到），而渲染端手里
 * 根本没有 JWT —— 开了远程访问后 `authEnabled()` 变 true，不去掉这道校验，
 * 内部所有 WS（状态推送 / 终端）都会被 401 拒掉然后无限重连（实测踩过）。
 *
 * 与 `attachWebSockets` 共用这一段逻辑：旧的独立进程形态走后者（认不出的路径拒掉），
 * 与 Next.js 同进程的形态走前者（认不出的路径放行给 Next）。
 */
export function routeUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  auth = true
): boolean {
  try {
    const url = resolveUpgradeUrl(req.url)
    if (!url) {
      // 畸形 / 绝对形式的 req.url（扫描器常发）：`new URL` 已经吞了异常，这里拒掉
      rejectSocket(socket, 'HTTP/1.1 400 Bad Request\r\n\r\n')
      return true
    }
    if (url.pathname === TERMINAL_WS_PATH) {
      handleTerminalUpgrade(req, socket, head, url, auth)
      return true
    }
    if (url.pathname === SSH_TERMINAL_WS_PATH) {
      handleSshTerminalUpgrade(req, socket, head, url, auth)
      return true
    }
    if (matchStatePath(url.pathname)) {
      handleStateUpgrade(req, socket, head, url, auth)
      return true
    }
    if (matchBrowserPath(url.pathname)) {
      handleBrowserUpgrade(req, socket, head, url, auth)
      return true
    }
    if (matchApiClientWsPath(url.pathname)) {
      handleApiClientWsUpgrade(req, socket, head, url, auth)
      return true
    }
    /**
     * 认不出的路径交给调用方（独立部署时它是下一个 upgrade 处理器；桌面进程内的 loopback
     * server 则由 `attachWebSockets` 直接拒掉）。容器预览的 WS（前端 dev server 的 HMR）
     * **不在这里** —— 它走的是**独立的公网入口监听器**（`FIZZ_PUBLIC_HTTP_PORT`，见
     * `container-projects/public-gateway.ts`），那条路上自己挂了 `'upgrade'`。
     */
    return false
  } catch (err) {
    console.error('[ws] 处理升级请求失败（连接已拒）：', err)
    rejectSocket(socket, 'HTTP/1.1 500 Internal Server Error\r\n\r\n')
    return true
  }
}

/**
 * 把全部 WS 端点挂到 http server 上。在 `index.ts` 里 `serve()` 之后调用一次。
 *
 * `auth: false` **只给桌面进程内的 loopback server 用**（`packages/agent-host` 的
 * manager）——对外暴露的端口（独立部署 / 远程访问）一律保持默认的鉴权。
 */
export function attachWebSockets(server: UpgradeableServer, opts: { auth?: boolean } = {}): void {
  const auth = opts.auth !== false
  server.on('upgrade', (req, socket, head) => {
    // 认不出的路径：明确拒，别让它悬着（浏览器会一直等到超时）
    if (!routeUpgrade(req, socket, head, auth)) {
      rejectSocket(socket, 'HTTP/1.1 404 Not Found\r\n\r\n')
    }
  })
}
