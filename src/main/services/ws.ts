/**
 * 主进程 WebSocket 客户端（「接口请求」功能里的 WebSocket 调试）。
 *
 * 与 `http.ts` 同一套思路：连接由**主进程**建立，渲染端只做「开 / 发 / 关 + 收事件」。
 * 这样不受渲染进程的限制，也能带上自定义请求头（浏览器的 WebSocket API 不允许设头）
 * 并跳过 wss 自签证书校验。
 *
 * 底层优先用 undici 的 `WebSocket` —— 它的构造函数支持 `{ headers, protocols, dispatcher }`，
 * 正好覆盖上面两点；拿不到 undici 时降级到 Node 全局 `WebSocket`
 * （此时**自定义请求头会被忽略**，通过返回值里的 `warning` 告知渲染端，不静默失败）。
 *
 * 与 HTTP 不同的是这是**长连接**：`open()` 只负责把连接建起来并返回 connId，
 * 真正的结果（成功/失败/收消息/关闭）全部通过 `event` 事件推给渲染端。
 */

import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import type { WsConnectOptions, WsEvent, WsOpenResult, WsSendPayload } from '@shared/types'

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

/** WebSocket 的 CONNECTING 状态值（WHATWG 固定为 0） */
const CONNECTING = 0
/** WebSocket 的 OPEN 状态值（WHATWG 固定为 1） */
const OPEN = 1

class WsService extends EventEmitter {
  /** 活着的连接：connId → socket */
  private conns = new Map<string, WsLike>()

  /**
   * 建立连接。**立刻返回** connId（不等待握手）：
   * 握手结果通过 `open` / `error` 事件推给渲染端，界面先显示「连接中」。
   *
   * connId 由**渲染端**生成并传进来（而不是这里现取）：
   * 握手可能快到 IPC 回包之前就完成了，若 connId 要等返回值才知道，
   * 渲染端会把提前到达的 open / message 事件当成「别人的连接」丢掉。
   * 先拿到 id 再发起连接，这个竞态就不存在了。传空则退回自己生成。
   */
  async open(connId: string, options: WsConnectOptions): Promise<WsOpenResult> {
    const id = connId.trim() || randomUUID()
    const url = options.url.trim()
    if (!url) return { connId: id, error: '请填写 WebSocket 地址' }
    if (!/^wss?:\/\//i.test(url)) {
      return { connId: id, error: '地址需以 ws:// 或 wss:// 开头' }
    }

    // 优先 undici（能带头 / 能跳证书校验），拿不到就降级到全局 WebSocket
    const undici = (await import('undici').catch(() => null)) as {
      WebSocket: new (
        url: string,
        init?: { protocols?: string | string[]; headers?: Record<string, string>; dispatcher?: unknown }
      ) => WsLike
      Agent: new (o: unknown) => unknown
    } | null

    const headers = options.headers ?? {}
    const headerCount = Object.keys(headers).length
    const protocols = options.protocols?.filter((p) => p.trim())
    let warning: string | undefined

    let socket: WsLike
    try {
      if (undici) {
        const init: {
          protocols?: string[]
          headers?: Record<string, string>
          dispatcher?: unknown
        } = {}
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
      return { connId: id, error: e instanceof Error ? e.message : String(e) }
    }

    // 二进制帧统一按 ArrayBuffer 收，便于直接转 base64（默认的 blob 在 Node 里不好取字节）
    try {
      socket.binaryType = 'arraybuffer'
    } catch {
      // 个别实现可能只读，忽略
    }

    this.conns.set(id, socket)
    this.bind(id, socket)
    return { connId: id, ...(warning ? { warning } : {}) }
  }

  /** 把 socket 的原生事件翻译成统一的 WsEvent 推给渲染端 */
  private bind(connId: string, socket: WsLike): void {
    const emit = (e: WsEvent): void => {
      this.emit('event', e)
    }

    socket.onopen = () => {
      emit({ connId, type: 'open', protocol: socket.protocol || '' })
    }

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
      this.conns.delete(connId)
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
      const message = ev?.message || ev?.error?.message || '连接出错'
      emit({ connId, type: 'error', message })
    }
  }

  /** 发送一帧；连接不存在或状态不对时返回 `{ ok: false, error }`，不抛 */
  send(connId: string, payload: WsSendPayload): { ok: boolean; error?: string } {
    const socket = this.conns.get(connId)
    if (!socket) return { ok: false, error: '连接已关闭' }
    if (socket.readyState !== OPEN) return { ok: false, error: '连接尚未就绪' }
    try {
      if (payload.encoding === 'base64') {
        const buf = Buffer.from(payload.data, 'base64')
        socket.send(buf)
      } else {
        socket.send(payload.data)
      }
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }

  /** 主动关闭（正常关闭码 1000）。关闭事件仍会走 `onclose` 推给渲染端 */
  close(connId: string, code = 1000, reason = ''): void {
    const socket = this.conns.get(connId)
    if (!socket) return
    try {
      if (socket.readyState === CONNECTING) {
        // 还没握手完就关：直接丢弃（有些实现此时 close() 会抛）。
        // 仍然补一条 close 事件 —— 否则渲染端会永远停在「连接中」。
        this.conns.delete(connId)
        this.emit('event', {
          connId,
          type: 'close',
          code,
          reason,
          at: Date.now()
        } satisfies WsEvent)
        return
      }
      socket.close(code, reason)
    } catch {
      this.conns.delete(connId)
    }
  }

  /** 退出前清干净（应用关闭时调用） */
  closeAll(): void {
    for (const id of [...this.conns.keys()]) this.close(id)
    this.conns.clear()
  }
}

/** 把各种二进制载荷统一成 Buffer（拿不到返回 null） */
function toBuffer(data: unknown): Buffer | null {
  if (data instanceof ArrayBuffer) return Buffer.from(data)
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  }
  return null
}

export const wsService = new WsService()
