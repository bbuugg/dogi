/**
 * 升级请求（WebSocket）的公共工具。
 *
 * 单独抽出来是因为服务端有**多个** WS 端点（终端 `/api/terminal`、SSH 终端、
 * 节点日志与工作台等），而它们必须共用一个 `upgrade` 监听器（见 `../ws.ts`），
 * 于是「解析 URL / 拒绝连接」这些活儿双方都要用，不能再各自留一份。
 */
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'

/** `serve()` 返回值里我们唯一要用的能力：挂一个 upgrade 监听 */
export interface UpgradeableServer {
  on(
    event: 'upgrade',
    listener: (req: IncomingMessage, socket: Duplex, head: Buffer) => void
  ): unknown
}

/**
 * 拒绝一条升级请求：**先挂 'error' 监听再销毁**。
 *
 * 裸 socket 若没有 'error' 监听器，对端 RST（客户端进程被杀 / 网络抖动 / 扫描器发完就断）
 * 时 Node 会把 error 事件直接 throw —— 又是一个能干掉整个服务端的入口。
 * 只在这里挂，不碰 `handleUpgrade` 之后的 socket（那段由 ws 库自己管）。
 */
export function rejectSocket(socket: Duplex, statusLine?: string): void {
  socket.on('error', () => undefined)
  try {
    if (statusLine && !socket.destroyed) socket.write(statusLine)
  } catch {
    // socket 已经没了：忽略
  }
  socket.destroy()
}

/**
 * 解析升级请求的 URL；畸形 / 绝对形式的 `req.url`（扫描器常发，例如 `http://[`）
 * 会让 `new URL` 抛 `ERR_INVALID_URL` —— 这里吞掉并返回 null，交给调用方拒绝连接。
 */
export function resolveUpgradeUrl(rawUrl: string | undefined): URL | null {
  try {
    return new URL(rawUrl ?? '/', 'http://localhost')
  } catch {
    return null
  }
}
