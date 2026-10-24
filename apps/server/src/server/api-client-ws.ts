/**
 * 「接口请求」功能的 WebSocket 调试**中继端点**：`/api/api-client/ws/:connId`。
 *
 * ## 为什么要中继
 *
 * 浏览器原生 `WebSocket` 有两个硬限制：**不能设自定义握手请求头**（Authorization /
 * Cookie / Origin 全带不了），也**不能跳过 wss 自签证书校验**。所以真正的连接由服务端
 * 建立（与 dogi「主进程建连」语义等价，见 `main/services/api/ws.ts`）。
 *
 * 渲染端一条调试连接 = 一条打到这里的浏览器 WS；服务端按首帧 `connect` 里的
 * `WsConnectOptions` 连外部目标，并把目标帧翻译成 JSON `WsEvent` 回推。
 *
 * ## 协议
 *
 * 渲染端 → 中继（`WsRelayClientMessage`）：`connect`（必须第一条）/ `send` / `close`。
 * 中继 → 渲染端（`WsEvent`）：`open` / `message` / `close` / `error`。
 *
 * ## 与 dogi 的差别
 *
 * dogi 是「一条 IPC 事件总线 + connId 过滤」；这里**每个 connId 各自一条浏览器 WS**
 * （`connId` 从路径里取），所以中继内部只维护**本条连接**的目标 socket，不用全局 Map。
 *
 * ⚠️ 不自己挂 `server.on('upgrade')`：统一由 `../ws.ts` 分流后再调 `handleApiClientWsUpgrade()`。
 */
import type { Duplex } from 'node:stream'
import type { IncomingMessage } from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'
import type { WsConnectOptions, WsEvent, WsRelayClientMessage } from '@fizz/contracts/types'
import { rejectSocket } from './lib/ws'
import { verifyWsToken } from './auth'

/** 连接对象的**结构化**最小子集：不依赖 undici 的类型（它是可选依赖） */
interface WsLike {
  readyState: number
  binaryType: string
  /** 协商出来的子协议 */
  readonly protocol: string
  send(data: string | ArrayBuffer | ArrayBufferView): void
  close(code?: number, reason?: string): void
  onopen: ((ev: unknown) => void) | null
  onmessage: ((ev: unknown) => void) | null
  onclose: ((ev: unknown) => void) | null
  onerror: ((ev: unknown) => void) | null
}

/** undici `WebSocket` 的最小类型（仅用到构造签名） */
type UndiciWebSocketModule = {
  WebSocket: new (
    url: string,
    init?: { protocols?: string | string[]; headers?: Record<string, string>; dispatcher?: unknown }
  ) => WsLike
  Agent: new (o: unknown) => unknown
}

/** WebSocket 的 CONNECTING / OPEN 状态值（WHATWG 固定） */
const CONNECTING = 0
const OPEN = 1

/** 把各种二进制载荷统一成 Buffer（拿不到返回 null） */
function toBuffer(data: unknown): Buffer | null {
  if (data instanceof ArrayBuffer) return Buffer.from(data)
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  }
  return null
}

/** 往浏览器侧发一条 JSON 事件（连接已关就丢弃） */
function sendJson(ws: WebSocket, event: WsEvent): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(event))
}

/**
 * 按 `WsConnectOptions` 连外部目标，并把目标事件翻译成 `WsEvent` 回推。
 *
 * 与 dogi `WsService.open` 同一套：优先 undici（能带头 / 能跳证书校验），拿不到降级到
 * 全局 `WebSocket`（此时自定义请求头会被忽略）。降级不改连接成败，所以把提示挂在
 * `open` 事件的 `warning` 上（渲染端照常进入已连接状态、顺带显示这条告警），而不是
 * 发 `error`（那会让界面把一次**成功**的连接当成失败）。
 */
async function connectTarget(
  ws: WebSocket,
  connId: string,
  options: WsConnectOptions,
  setTarget: (socket: WsLike | null) => void
): Promise<void> {
  const emit = (event: WsEvent): void => sendJson(ws, event)
  const url = (options.url ?? '').trim()
  if (!url) {
    emit({ connId, type: 'error', message: '请填写 WebSocket 地址' })
    return
  }
  if (!/^wss?:\/\//i.test(url)) {
    emit({ connId, type: 'error', message: '地址需以 ws:// 或 wss:// 开头' })
    return
  }

  const undici = (await import('undici').catch(() => null)) as UndiciWebSocketModule | null
  const headers = options.headers ?? {}
  const headerCount = Object.keys(headers).length
  const protocols = options.protocols?.filter((p) => p.trim())

  /** 降级提示（连上了才随 `open` 事件带出；连接都失败的话它没有意义） */
  let warning: string | undefined

  let socket: WsLike
  try {
    if (undici) {
      const init: { protocols?: string[]; headers?: Record<string, string>; dispatcher?: unknown } = {}
      if (protocols?.length) init.protocols = protocols
      if (headerCount) init.headers = headers
      // 仅 wss + 显式要求时才关校验，避免默认削弱 TLS
      if (options.rejectUnauthorized === false && /^wss:\/\//i.test(url)) {
        init.dispatcher = new undici.Agent({ connect: { rejectUnauthorized: false } })
      }
      socket = new undici.WebSocket(url, init)
    } else {
      // 降级路径：全局 WebSocket 不支持自定义头（协议本身就没有这个入口）
      if (headerCount) {
        warning = `当前环境缺少 undici，已忽略 ${headerCount} 个自定义请求头`
      }
      socket = new (globalThis as unknown as { WebSocket: new (u: string, p?: string[]) => WsLike })
        .WebSocket(url, protocols?.length ? protocols : undefined)
    }
  } catch (e) {
    emit({ connId, type: 'error', message: e instanceof Error ? e.message : String(e) })
    return
  }

  // 二进制帧统一按 ArrayBuffer 收，便于直接转 base64（默认的 blob 在 Node 里不好取字节）
  try {
    socket.binaryType = 'arraybuffer'
  } catch {
    // 个别实现可能只读，忽略
  }

  setTarget(socket)

  socket.onopen = () =>
    emit({
      connId,
      type: 'open',
      protocol: socket.protocol || '',
      ...(warning ? { warning } : {})
    })

  socket.onmessage = (raw) => {
    const data = (raw as { data?: unknown }).data
    if (typeof data === 'string') {
      emit({
        connId,
        type: 'message',
        data,
        encoding: 'text',
        bytes: Buffer.byteLength(data, 'utf8'),
        at: Date.now()
      })
      return
    }
    const buf = toBuffer(data)
    if (buf) {
      emit({
        connId,
        type: 'message',
        data: buf.toString('base64'),
        encoding: 'base64',
        bytes: buf.byteLength,
        at: Date.now()
      })
      return
    }
    // 兜底：既不是字符串也拿不到字节，按文本强转（信息总比丢掉强）
    const text = String(data ?? '')
    emit({
      connId,
      type: 'message',
      data: text,
      encoding: 'text',
      bytes: Buffer.byteLength(text, 'utf8'),
      at: Date.now()
    })
  }

  socket.onclose = (raw) => {
    const ev = raw as { code?: number; reason?: string }
    setTarget(null)
    emit({
      connId,
      type: 'close',
      code: typeof ev.code === 'number' ? ev.code : 1006,
      reason: ev.reason ?? '',
      at: Date.now()
    })
  }

  socket.onerror = (raw) => {
    // 各种实现的错误事件形状不一：ErrorEvent 有 message/error，Event 什么都没有
    const ev = raw as { message?: string; error?: { message?: string } }
    emit({ connId, type: 'error', message: ev?.message || ev?.error?.message || '连接出错' })
  }
}

/** 一条浏览器中继连接：维护它自己的目标 socket，按收到的控制帧驱动 */
function handleConnection(ws: WebSocket, connId: string): void {
  let target: WsLike | null = null

  /** 关掉目标（浏览端主动断开 / 中继连接关闭时调用）；关闭事件仍由 onclose 回推 */
  const closeTarget = (code = 1000, reason = ''): void => {
    const socket = target
    if (!socket) return
    try {
      if (socket.readyState === CONNECTING) {
        // 还没握手完就关：直接丢弃（有些实现此时 close() 会抛），并补一条 close 事件
        target = null
        sendJson(ws, { connId, type: 'close', code, reason, at: Date.now() })
        return
      }
      socket.close(code, reason)
    } catch {
      target = null
    }
  }

  ws.on('message', (raw: unknown, isBinary: boolean) => {
    if (isBinary) return
    let message: WsRelayClientMessage
    try {
      message = JSON.parse(String(raw)) as WsRelayClientMessage
    } catch {
      return
    }
    if (message.type === 'connect') {
      // 重复 connect：忽略（一条连接只连一个目标）
      if (target) return
      void connectTarget(ws, connId, message.options, (socket) => {
        target = socket
      })
      return
    }
    if (message.type === 'send') {
      const socket = target
      if (!socket || socket.readyState !== OPEN) {
        sendJson(ws, { connId, type: 'error', message: '连接尚未就绪' })
        return
      }
      try {
        if (message.encoding === 'base64') socket.send(Buffer.from(message.data, 'base64'))
        else socket.send(message.data)
      } catch (e) {
        sendJson(ws, { connId, type: 'error', message: e instanceof Error ? e.message : String(e) })
      }
      return
    }
    if (message.type === 'close') closeTarget(message.code, message.reason)
  })

  const cleanup = (): void => {
    const socket = target
    target = null
    if (!socket) return
    try {
      socket.close()
    } catch {
      // 已经关了
    }
  }
  ws.on('close', cleanup)
  ws.on('error', cleanup)
}

const wss = new WebSocketServer({ noServer: true })

/** 接口调试中继端点的路径前缀（`/api/api-client/ws/<connId>`） */
export function matchApiClientWsPath(pathname: string): boolean {
  return pathname.startsWith('/api/api-client/ws/')
}

/**
 * 处理一条**已经确认路径是中继**的升级请求。鉴权与握手都在这里；
 * 意外抛出由 `../ws.ts` 的最外层 try/catch 兜底（upgrade 不在 Hono onError 覆盖范围内）。
 */
export function handleApiClientWsUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  url: URL,
  auth = true
): void {
  void (async () => {
    try {
      if (auth) {
        const err = await verifyWsToken(url)
        if (err) {
          rejectSocket(socket, 'HTTP/1.1 401 Unauthorized\r\n\r\n')
          return
        }
      }
      const connId = decodeURIComponent(url.pathname.slice('/api/api-client/ws/'.length))
      if (!connId) {
        rejectSocket(socket, 'HTTP/1.1 400 Bad Request\r\n\r\n')
        return
      }
      wss.handleUpgrade(req, socket, head, (ws) => handleConnection(ws, connId))
    } catch {
      rejectSocket(socket, 'HTTP/1.1 500 Internal Server Error\r\n\r\n')
    }
  })()
}