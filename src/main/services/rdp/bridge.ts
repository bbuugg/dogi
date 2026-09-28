/**
 * 主进程 RDP 本地桥（RDCleanPath 协议）：把渲染端的 WASM RDP 客户端（ironrdp-wasm）
 * 与真实 RDP 服务器连起来。
 *
 * 传输协议（与 electerm 同款路线）：WASM 客户端经 WebSocket 连到本地桥，
 * 第一条二进制消息是 DER 编码的 RDCleanPath 请求（含目标 destination 与
 * X.224 连接请求）；桥替它完成 TCP 连接、X.224 交换与 TLS 握手，再把服务器
 * 证书链回填给客户端（由 WASM 侧校验），之后 WebSocket ↔ TLS 双向透传 RDP 数据
 * （NLA / CredSSP 发生在透传的 RDP 层内，与 TLS 无关）。
 *
 * 安全基线：WebSocket 只监听 127.0.0.1 随机端口，URL 路径带每连接随机 token；
 * 桥只连接创建时固定下来的 host:port（请求里的 destination 必须与之一致，
 * 不做任意的端口转发）。
 *
 * 目标主机必须是 kind === 'rdp' 的主机配置（远程桌面是独立的主机类型，
 * 不再从 ssh 主机的入口旁路打开）；host / port 都取自该配置 —— rdp 主机的
 * port 就是 RDP 端口，与 ssh 主机的 SSH 端口不再有混用空间。
 */
import { randomBytes } from 'node:crypto'
import * as net from 'node:net'
import * as tls from 'node:tls'
import { WebSocketServer, WebSocket, type RawData } from 'ws'
import { storage } from '../storage'
import { hostLogger } from '../log/logger'
import type { RdpBridgeInfo } from '@shared/types'

// ── RDCleanPath 是 ASN.1 DER 编码；常量与编解码按 ironrdp-wasm 参考代理实现移植 ──

/** RDCleanPath 版本号（固定 3389 + 1） */
const RDPCLEANPATH_VERSION = 3390

const TAG_SEQUENCE = 0x30
const TAG_INTEGER = 0x02
const TAG_OCTET_STRING = 0x04
const TAG_UTF8STRING = 0x0c
/** 上下文相关 EXPLICIT 标签 [n] 的 tag 前缀 */
const TAG_CTX_BASE = 0xa0

/** 把 WebSocket 收到的消息统一成 Buffer（ws 可能给 Buffer / ArrayBuffer / Buffer[]） */
function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data
  if (Array.isArray(data)) return Buffer.concat(data)
  return Buffer.from(data)
}

function derEncodeLength(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length])
  const bytes: number[] = []
  let temp = length
  while (temp > 0) {
    bytes.unshift(temp & 0xff)
    temp >>= 8
  }
  return Buffer.from([0x80 | bytes.length, ...bytes])
}

function derWrap(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), derEncodeLength(content.length), content])
}

function derEncodeInteger(value: number): Buffer {
  if (value === 0) return derWrap(TAG_INTEGER, Buffer.from([0]))
  const bytes: number[] = []
  let temp = value
  while (temp > 0) {
    bytes.unshift(temp & 0xff)
    temp >>= 8
  }
  // 最高位为 1 时补 0x00，避免被解析成负数
  if (bytes[0] & 0x80) bytes.unshift(0)
  return derWrap(TAG_INTEGER, Buffer.from(bytes))
}

function derEncodeUtf8(str: string): Buffer {
  return derWrap(TAG_UTF8STRING, Buffer.from(str, 'utf-8'))
}

function derEncodeOctet(buf: Buffer): Buffer {
  return derWrap(TAG_OCTET_STRING, buf)
}

function derWrapContext(tagNum: number, content: Buffer): Buffer {
  return derWrap(TAG_CTX_BASE + tagNum, content)
}

interface DerTlv {
  tag: number
  value: Buffer
  totalLength: number
}

function derDecodeLength(buf: Buffer, offset: number): { length: number; bytesRead: number } {
  const first = buf[offset]
  if (first < 0x80) return { length: first, bytesRead: 1 }
  const numBytes = first & 0x7f
  let length = 0
  for (let i = 0; i < numBytes; i++) length = (length << 8) | buf[offset + 1 + i]
  return { length, bytesRead: 1 + numBytes }
}

function derDecodeTlv(buf: Buffer, offset: number): DerTlv {
  const tag = buf[offset]
  const { length, bytesRead } = derDecodeLength(buf, offset + 1)
  const headerLen = 1 + bytesRead
  return {
    tag,
    value: buf.subarray(offset + headerLen, offset + headerLen + length),
    totalLength: headerLen + length
  }
}

function derDecodeChildren(buf: Buffer): DerTlv[] {
  const children: DerTlv[] = []
  let offset = 0
  while (offset < buf.length) {
    const tlv = derDecodeTlv(buf, offset)
    // 防御：脏数据导致长度不进位时终止，避免死循环
    if (tlv.totalLength <= 0) break
    children.push(tlv)
    offset += tlv.totalLength
  }
  return children
}

function derDecodeInteger(buf: Buffer): number {
  let val = 0
  for (let i = 0; i < buf.length; i++) val = (val << 8) | buf[i]
  return val
}

interface RdpCleanPathRequest {
  destination: string
  /** X.224 连接请求原始字节（桥把它原样发给 RDP 服务器完成协商） */
  x224ConnectionRequest: Buffer
}

/** 解析 RDCleanPath 请求 PDU；缺字段 / 版本不符时抛错（由调用方回错误 PDU） */
function parseRdpCleanPathRequest(data: Buffer): RdpCleanPathRequest {
  const outer = derDecodeTlv(data, 0)
  if (outer.tag !== TAG_SEQUENCE) {
    throw new Error(`RDCleanPath 请求不是 SEQUENCE（0x${outer.tag.toString(16)}）`)
  }
  let version: number | null = null
  let destination: string | null = null
  let x224: Buffer | null = null
  for (const child of derDecodeChildren(outer.value)) {
    const ctxTag = child.tag & 0x1f
    if (ctxTag === 0) {
      version = derDecodeInteger(derDecodeTlv(child.value, 0).value)
    } else if (ctxTag === 2) {
      destination = derDecodeTlv(child.value, 0).value.toString('utf-8')
    } else if (ctxTag === 6) {
      x224 = derDecodeTlv(child.value, 0).value
    }
  }
  if (version !== RDPCLEANPATH_VERSION) {
    throw new Error(`不支持的 RDCleanPath 版本：${version}（期望 ${RDPCLEANPATH_VERSION}）`)
  }
  if (!destination) throw new Error('RDCleanPath 请求缺少 destination')
  if (!x224) throw new Error('RDCleanPath 请求缺少 x224_connection_pdu')
  return { destination, x224ConnectionRequest: x224 }
}

/** 编码 RDCleanPath 应答 PDU：[0] version、[6] x224_connection_pdu、[7] server_cert_chain、[9] server_addr */
function buildRdpCleanPathResponse(
  serverAddr: string,
  x224Response: Buffer,
  certChain: Buffer[]
): Buffer {
  const certSeq = derWrap(TAG_SEQUENCE, Buffer.concat(certChain.map((cert) => derEncodeOctet(cert))))
  return derWrap(
    TAG_SEQUENCE,
    Buffer.concat([
      derWrapContext(0, derEncodeInteger(RDPCLEANPATH_VERSION)),
      derWrapContext(6, derEncodeOctet(x224Response)),
      derWrapContext(7, certSeq),
      derWrapContext(9, derEncodeUtf8(serverAddr))
    ])
  )
}

/** 编码 RDCleanPath 错误 PDU：[0] version、[1] error{ [0] error_code、[1] http_status_code } */
function buildRdpCleanPathError(errorCode: number, httpStatusCode: number): Buffer {
  const errSeq = derWrap(
    TAG_SEQUENCE,
    Buffer.concat([
      derWrapContext(0, derEncodeInteger(errorCode)),
      derWrapContext(1, derEncodeInteger(httpStatusCode))
    ])
  )
  return derWrap(
    TAG_SEQUENCE,
    Buffer.concat([derWrapContext(0, derEncodeInteger(RDPCLEANPATH_VERSION)), derWrapContext(1, errSeq)])
  )
}

/** 解析 destination（支持 IPv6 `[::1]:3389` 与常规 `host:port`，缺省端口 3389） */
function parseDestination(destination: string): { host: string; port: number } {
  if (destination.startsWith('[')) {
    const bracketEnd = destination.indexOf(']')
    if (bracketEnd === -1) throw new Error(`非法的 IPv6 目标：${destination}`)
    const host = destination.slice(1, bracketEnd)
    const rest = destination.slice(bracketEnd + 1)
    const port = rest.startsWith(':') ? parseInt(rest.slice(1), 10) : 3389
    return { host, port: Number.isFinite(port) ? port : 3389 }
  }
  const lastColon = destination.lastIndexOf(':')
  if (lastColon === -1) return { host: destination, port: 3389 }
  const port = parseInt(destination.slice(lastColon + 1), 10)
  if (Number.isNaN(port)) return { host: destination, port: 3389 }
  return { host: destination.slice(0, lastColon), port }
}

/** 从 Node 的对端证书对象里抽出完整证书链（DER 字节数组，含签发者链） */
function extractCertChain(peerCert: tls.PeerCertificate | tls.DetailedPeerCertificate): Buffer[] {
  const certs: Buffer[] = []
  if (!peerCert || !('raw' in peerCert) || !peerCert.raw) return certs
  const seen = new Set<string>()
  let current: tls.DetailedPeerCertificate | undefined = peerCert as tls.DetailedPeerCertificate
  while (current && current.raw) {
    const fingerprint = current.fingerprint256 || current.raw.toString('hex')
    if (seen.has(fingerprint)) break
    seen.add(fingerprint)
    certs.push(Buffer.from(current.raw))
    if (current.issuerCertificate && current.issuerCertificate !== current) {
      current = current.issuerCertificate
    } else {
      break
    }
  }
  return certs
}

/** 握手阶段（TCP + X.224 + TLS）总超时；就绪后的透传阶段不设空闲超时 */
const HANDSHAKE_TIMEOUT_MS = 15000

/** 兼容降级用的静态 RSA 套件清单。必须写 OpenSSL 风格名 —— BoringSSL 的 cipher
 *  解析器不认 IANA 全名（'TLS_RSA_WITH_...' 会解析成空列表 → NO_CIPHERS_AVAILABLE）。 */
const RSA_FALLBACK_CIPHERS =
  'AES256-GCM-SHA384:AES128-GCM-SHA384:AES256-SHA256:AES128-SHA256:AES256-SHA:AES128-SHA'

type TlsAttemptOptions = Pick<tls.ConnectionOptions, 'minVersion' | 'maxVersion' | 'ciphers'>

/** BoringSSL 在客户端对服务器证书 keyUsage 的强校验错误（OpenSSL / SChannel / rustls 都不查） */
function isKeyUsageError(err: unknown): boolean {
  return err instanceof Error && err.message.includes('KEY_USAGE_BIT_INCORRECT')
}

interface RdpHandshakeResult {
  x224Response: Buffer
  certChain: Buffer[]
  tlsSocket: tls.TLSSocket
}

/**
 * 接入握手（带证书兼容兜底）。
 *
 * 默认按 TLS 1.3/1.2 + 全量套件握手。部分自签 RDP 证书的 keyUsage 只有
 * keyEncipherment（缺 digitalSignature）；BoringSSL 对「证书用于签名」按 X.509
 * 用途位强校验（KEY_USAGE_BIT_INCORRECT），而 OpenSSL / SChannel / rustls 都不查 ——
 * 这类服务器在别的客户端能连、在本桥上被掐断。它们唯一合法用途是静态 RSA 密钥交换
 * （证书用于加密，正对 keyEncipherment），因此识别到该错误时降级 TLS 1.2 +
 * 静态 RSA 套件重试一次（多一次 TCP 往返，仅这类证书会走到）。
 */
function performRdpHandshake(
  host: string,
  port: number,
  x224Request: Buffer
): Promise<RdpHandshakeResult> {
  return performHandshakeAttempt(host, port, x224Request, {}).catch((err: unknown) => {
    if (!isKeyUsageError(err)) throw err
    hostLogger.warn(
      'rdp',
      `服务器证书 keyUsage 缺少 digitalSignature（${host}:${port}），降级 TLS 1.2 静态 RSA 套件重试`
    )
    return performHandshakeAttempt(host, port, x224Request, {
      minVersion: 'TLSv1.2',
      maxVersion: 'TLSv1.2',
      ciphers: RSA_FALLBACK_CIPHERS
    })
      .then((result) => {
        hostLogger.info(
          'rdp',
          `已用 TLS 1.2 静态 RSA 套件完成握手（${host}:${port}，服务器证书仅允许 keyEncipherment）`
        )
        return result
      })
      .catch((retryErr: unknown) => {
        // 兜底也失败（如服务器禁用了静态 RSA 套件）：抛回原始错误并附降级失败原因
        const original = err instanceof Error ? err.message : String(err)
        const retry = retryErr instanceof Error ? retryErr.message : String(retryErr)
        throw new Error(`${original}（已尝试 TLS 1.2 静态 RSA 兼容握手：${retry}）`)
      })
  })
}

/**
 * 单次握手尝试：
 * 1. TCP 连接目标主机；
 * 2. 原样发送客户端的 X.224 连接请求，按 TPKT 长度读回 X.224 连接确认
 *    （服务器的确认通常一包到齐，但按长度攒齐可以避免极端情况被分片截断）；
 * 3. 在同一个 TCP 连接上升级 TLS（RDP 服务器多用自签证书，这里不做校验——
 *    证书链会随应答回给 WASM 客户端，由它按自己的策略处理）。
 */
function performHandshakeAttempt(
  host: string,
  port: number,
  x224Request: Buffer,
  tlsOptions: TlsAttemptOptions
): Promise<RdpHandshakeResult> {
  return new Promise((resolve, reject) => {
    let settled = false
    const socket = net.createConnection({ host, port }, () => {
      // RDP 是交互式协议，Nagle 会把小包攒到收到 ACK / 攒够 MSS 才发（叠加对端延迟 ACK
      // 可到 40ms 量级）；鼠标键盘上行、服务器帧确认都被它拖慢，画面就是「一顿一顿」。
      // 回环桥同理（本地 WebSocket 那侧见 open 里的 connection 处理）。
      socket.setNoDelay(true)
      socket.write(x224Request)
    })
    const fail = (err: Error): void => {
      if (settled) return
      settled = true
      socket.destroy()
      reject(err)
    }
    socket.setTimeout(HANDSHAKE_TIMEOUT_MS, () => fail(new Error('连接 RDP 服务器超时')))
    socket.once('error', (err) => fail(err))
    socket.once('close', () => fail(new Error('RDP 服务器在 X.224 协商完成前断开连接')))

    let frame: Buffer | null = null
    const onData = (chunk: Buffer): void => {
      frame = frame ? Buffer.concat([frame, chunk]) : chunk
      if (frame.length < 4) return
      const frameLength = frame.readUInt16BE(2)
      if (frameLength < 4 || frame.length < frameLength) return
      socket.removeListener('data', onData)
      // 防御：确认到达时服务器在等 ClientHello，理论上没有后续字节；若有则退回流
      if (frame.length > frameLength) socket.unshift(frame.subarray(frameLength))
      const x224Response = frame.subarray(0, frameLength)
      const tlsSocket = tls.connect(
        { socket, servername: host, rejectUnauthorized: false, ...tlsOptions },
        () => {
          if (settled) return
          settled = true
          socket.setTimeout(0)
          // TLS 层包着同一个 TCP socket，仍要再关一次 Nagle（窄依赖底层句柄，双保险）
          tlsSocket.setNoDelay(true)
          resolve({
            x224Response,
            certChain: extractCertChain(tlsSocket.getPeerCertificate(true)),
            tlsSocket
          })
        }
      )
      tlsSocket.once('error', (err) => fail(err))
    }
    socket.on('data', onData)
  })
}

/**
 * 下行合并阈值：同一事件循环 tick 内攒到这个字节数就立刻发（不等下一轮 tick）。
 * 太小会退化成「一条 TLS 分片一条 WebSocket 消息」，太大则给画面引入人为延迟。
 */
const WS_DOWNLINK_FLUSH_BYTES = 256 * 1024

/** WebSocket ↔ TLS 双向透传；任一侧结束 / 出错时把另一侧一并收尾 */
function relay(ws: WebSocket, tlsSocket: tls.TLSSocket, connId: string): void {
  // 下行（服务器 → 渲染端）合并发送：RDP 服务器的一次响应常被切成多条 TLS 记录，
  // 若每条都单独 ws.send，渲染端的 WASM 客户端要对每条消息走一遍 wasm-bindgen 回调
  // + 事件循环调度（图形绘制同步跑在渲染进程主线程上）—— 消息风暴会让更新排队、发顿。
  // 字节流语义不变（WASM 侧本就按字节流解析），只是把同一 tick 到齐的分片拼成一条。
  let outQueue: Buffer[] = []
  let outBytes = 0
  let flushScheduled = false

  let closing = false
  const cleanup = (): void => {
    if (closing) return
    closing = true
    outQueue = []
    outBytes = 0
    tlsSocket.destroy()
    try {
      if (ws.readyState === WebSocket.OPEN) ws.close()
    } catch {
      // 忽略
    }
  }

  const flushDownlink = (): void => {
    flushScheduled = false
    if (outBytes === 0) return
    const payload = outQueue.length === 1 ? outQueue[0] : Buffer.concat(outQueue, outBytes)
    outQueue = []
    outBytes = 0
    if (ws.readyState === WebSocket.OPEN) ws.send(payload)
  }

  tlsSocket.on('data', (data: Buffer) => {
    outQueue.push(data)
    outBytes += data.length
    // 攒够了就立刻发：大响应（首屏、整屏刷新）不额外等一个 tick
    if (outBytes >= WS_DOWNLINK_FLUSH_BYTES) {
      flushDownlink()
      return
    }
    if (!flushScheduled) {
      flushScheduled = true
      setImmediate(flushDownlink)
    }
  })
  tlsSocket.on('end', cleanup)
  tlsSocket.on('error', (err) => {
    hostLogger.warn('rdp', `[${connId}] RDP 连接出错：${err.message}`)
    cleanup()
  })
  ws.on('message', (data: RawData) => {
    if (!tlsSocket.destroyed) tlsSocket.write(toBuffer(data))
  })
  ws.on('close', cleanup)
  ws.on('error', cleanup)
}

interface PinnedTarget {
  host: string
  port: number
}

/** 处理渲染端 WASM 客户端的一条 WebSocket 连接：RDCleanPath 握手 + 透传 */
async function handleRdpConnection(
  ws: WebSocket,
  target: PinnedTarget,
  connId: string
): Promise<void> {
  ws.on('error', (err) => hostLogger.warn('rdp', `[${connId}] 本地 WebSocket 出错：${err.message}`))
  ws.once('message', (data) => {
    void (async () => {
      try {
        const request = parseRdpCleanPathRequest(toBuffer(data))
        const dest = parseDestination(request.destination)
        if (dest.host !== target.host || dest.port !== target.port) {
          throw new Error(
            `目标不匹配：请求 ${dest.host}:${dest.port}，桥固定的目标为 ${target.host}:${target.port}`
          )
        }
        const { x224Response, certChain, tlsSocket } = await performRdpHandshake(
          dest.host,
          dest.port,
          request.x224ConnectionRequest
        )
        if (ws.readyState !== WebSocket.OPEN) {
          tlsSocket.destroy()
          return
        }
        ws.send(buildRdpCleanPathResponse(`${dest.host}:${dest.port}`, x224Response, certChain))
        hostLogger.info('rdp', `[${connId}] RDCleanPath 握手完成，开始透传 RDP 数据`)
        relay(ws, tlsSocket, connId)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        hostLogger.error('rdp', `[${connId}] 本地桥握手失败：${message}`)
        try {
          ws.send(buildRdpCleanPathError(1, 502))
        } catch {
          // 忽略
        }
        try {
          ws.close()
        } catch {
          // 忽略
        }
      }
    })()
  })
}

/** 一个 RDP 桥实例 = 一个本地 WebSocket 服务 + 固定的目标主机 */
interface RdpBridgeConn {
  info: RdpBridgeInfo
  server: WebSocketServer
}

/** RDP 端口规范化：非法值（历史数据 / 手改）兜底 3389；桥与凭据 IPC 共用同一口径 */
export function normalizeRdpPort(port: number | undefined): number {
  return Number.isInteger(port) && port! > 0 && port! < 65536 ? port! : 3389
}

class RdpBridgeManager {
  private conns = new Map<string, RdpBridgeConn>()

  /**
   * 为某个远程桌面主机（kind = rdp）开一座本地 RDP 桥（幂等：同 connId 重复调用返回同一座）。
   * 返回的 wsUrl 供渲染端 WASM 客户端连接；一个 RDP 标签一座桥，
   * 标签关闭时应调 close 收尾。目标 host:port 全部取自主机配置。
   */
  async open(connId: string, profileId: string): Promise<RdpBridgeInfo> {
    const existing = this.conns.get(connId)
    if (existing) return existing.info
    const profile = storage.getSshProfile(profileId)
    if (!profile || profile.kind !== 'rdp') throw new Error('主机配置不存在或不是远程桌面类型')
    const target: PinnedTarget = { host: profile.host, port: normalizeRdpPort(profile.port) }

    // 每连接一个随机 token 作为路径：除渲染端持有的 URL 外，其他本地进程探测不到入口
    const token = randomBytes(24).toString('hex')
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0, path: `/${token}` })
    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve)
      server.once('error', reject)
    })
    const address = server.address()
    if (!address || typeof address === 'string') {
      server.close()
      throw new Error('RDP 本地桥监听失败')
    }
    const info: RdpBridgeInfo = { connId, wsUrl: `ws://127.0.0.1:${address.port}/${token}` }
    server.on('connection', (ws, req) => {
      // 本地 WebSocket 也关掉 Nagle：输入事件（鼠标 / 键盘）上行都是小包，
      // 攒包会直接体现为「点了没反应 / 拖动跟手差」。
      req.socket.setNoDelay(true)
      void handleRdpConnection(ws, target, connId)
    })
    server.on('error', (err) => hostLogger.warn('rdp', `[${connId}] 本地桥服务出错：${err.message}`))
    this.conns.set(connId, { info, server })
    hostLogger.info('rdp', `[${connId}] 本地桥已就绪：127.0.0.1:${address.port} → ${target.host}:${target.port}`)
    return info
  }

  /** 关闭指定桥（不存在的 connId 静默忽略）；标签关闭 / 窗口关闭时调用 */
  close(connId: string): void {
    const entry = this.conns.get(connId)
    if (!entry) return
    this.conns.delete(connId)
    for (const client of entry.server.clients) {
      try {
        client.close()
      } catch {
        // 忽略
      }
    }
    entry.server.close()
    hostLogger.info('rdp', `[${connId}] 本地桥已关闭`)
  }

  closeAll(): void {
    for (const id of [...this.conns.keys()]) this.close(id)
  }
}

export const rdpBridge = new RdpBridgeManager()
