/**
 * 终端 WS 通道的公共骨架。
 *
 * 两条终端通道（`/api/terminal` 本机 PTY、`/api/ssh/terminal` SSH 主机）**协议逐条相同**
 * （见 contracts 的 `TerminalClientMessage` / `TerminalServerMessage`），差别只有「会话怎么建」。
 * 这里把三件容易写歪的事收在一处：
 *
 * 1. **消息分发**：二进制帧 = 原始输入字节（ZMODEM 的 rz/sz 协议帧、文件块），直通会话；
 *    文本帧才是控制协议（input / resize / ping / stop）。
 * 2. **心跳保活 + 僵死回收**：30s 协议层 ping（撑过 nginx 的 `proxy_read_timeout`），
 *    连两轮没有 pong 才 terminate（丢一个 pong 太常见，误杀活着的会话代价太大）。
 * 3. **断开清场**：`clearInterval` + `session.kill()`。
 *
 * ⚠️ 这两条通道以前是**两份复制代码**，`terminal/ws.ts` 的注释里自己写着「与 ssh/ws.ts 的
 * 同名分支逐字同款」。代价很快显现：`stop` 只在本机通道实现、SSH 通道收到后静默丢弃；
 * `progress` 只有 SSH 会发 —— 每加一条协议都得记得改两处，靠注释提醒而不是靠类型。
 * 合并之后**协议只有这一份实现**，新增帧只改这里；通道差异全部落在 `stopForeground`
 * 这个可选方法上（不实现 = 这条通道没有「强停」能力，由类型保证）。
 */
import type { Duplex } from 'node:stream'
import type { IncomingMessage } from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'
import {
  type SshConnectProgress,
  type TerminalClientMessage,
  type TerminalServerMessage
} from '@fizz/contracts/agent-api'
import { appLog } from '@fizz/workspace'
import { rejectSocket } from '../lib/ws'
import { verifyWsToken } from '../auth'

/**
 * 通道所需的会话能力：本机 PTY 与 SSH 会话都满足。
 *
 * `stopForeground` 刻意是可选的 —— 它是「必须停」那道闸，只有宿主能看见前台进程组时才可能
 * 实现（本机 POSIX PTY）。SSH 远端进程组不在视野里，能做的只有「再发一次 `\x03`」，而那等于
 * 替用户又按一次 Ctrl+C（命令已退出时那记迟到的中断会在提示符上再回显一个 `^C`），
 * 所以那条通道**不实现**，`stop` 帧自然被忽略。
 */
export interface TerminalChannelSession {
  write(data: string | Uint8Array): void
  resize(cols: number, rows: number): void
  kill(): void
  stopForeground?(): void | Promise<void>
}

/** 交给会话构造函数的回调：输出 / 退出 / 建连进度怎么发到 WS 上，这里已经接好 */
export interface TerminalChannelSink {
  /** 输出：裸二进制帧（保真免 base64） */
  onData: (buf: Buffer) => void
  /** 会话结束：先下发 `exit`，再关连接 */
  onExit: (exitCode: number) => void
  /** SSH 建连进度（本机会话用不到，忽略即可） */
  onProgress: (progress: SshConnectProgress) => void
}

export interface TerminalChannelOptions {
  req: IncomingMessage
  socket: Duplex
  head: Buffer
  url: URL
  /** 是否校验 `?token=`（默认校验；只有同进程内可信调用会关掉） */
  auth?: boolean
  /** 日志分类（`appLog` 的 scope）：`terminal` / `ssh` */
  logScope: string
  /** 建会话失败时写进日志的标题，例如「SSH 终端启动失败」 */
  failureTitle: string
  /** 建会话失败时补在错误信息前的上下文（工作目录、主机 id…），没有就返回空串 */
  failureContext?: () => string
  /** 真正建会话。抛错 = 关连接，close reason 带错误文本 */
  create: (sink: TerminalChannelSink) => TerminalChannelSession
}

function sendJson(ws: WebSocket, message: TerminalServerMessage): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message))
}

const wss = new WebSocketServer({ noServer: true })

/**
 * 处理一条**已经确认路径是终端**的升级请求（分流由 `../ws.ts` 的 `attachWebSockets()` 做）。
 *
 * 鉴权：`?token=` 查询参数 —— WS 拿不到自定义请求头，浏览器 `WebSocket` 只能走查询参数；
 * 能开终端的人本来就等价于能在服务端跑任意命令（与 `/api/chat` 同级），所以不额外收窄。
 *
 * ⚠️ 这个回调里任何抛出都会变成 uncaughtException 直接干掉整个服务端
 * （`serve()` 的 upgrade 事件不在 Hono `onError` 覆盖范围内），所以**兜底只能有一层**，
 * 就放在这里。
 */
export function handleTerminalChannel(options: TerminalChannelOptions): void {
  const { req, socket, head, url, auth = true } = options
  void (async () => {
    try {
      if (auth) {
        const err = await verifyWsToken(url)
        if (err) {
          rejectSocket(socket, 'HTTP/1.1 401 Unauthorized\r\n\r\n')
          return
        }
      }
      wss.handleUpgrade(req, socket, head, (ws) => attach(ws, options))
    } catch {
      rejectSocket(socket, 'HTTP/1.1 500 Internal Server Error\r\n\r\n')
    }
  })()
}

function attach(ws: WebSocket, options: TerminalChannelOptions): void {
  const { logScope, failureTitle, failureContext, create } = options

  /** 输出走 WS 二进制帧（保真免 base64）；控制帧才是 JSON 文本 */
  const sink: TerminalChannelSink = {
    onData: (buf) => {
      if (ws.readyState === ws.OPEN) ws.send(buf)
    },
    onExit: (exitCode) => {
      sendJson(ws, { type: 'exit', exitCode })
      ws.close()
    },
    onProgress: (progress) => sendJson(ws, { type: 'progress', ...progress })
  }

  let session: TerminalChannelSession | null = null
  try {
    session = create(sink)
  } catch (err) {
    // 会话没建起来：`pty.ts` / `session.ts` 那条 info 也不会打，不多记一条日志里就是一片空白
    const message = err instanceof Error ? err.message : '终端启动失败'
    const context = failureContext?.() ?? ''
    appLog.error(logScope, failureTitle, `${context ? `${context}\n` : ''}${message}`)
    ws.close(1011, message)
    return
  }

  ws.on('message', (raw: unknown, isBinary: boolean) => {
    if (!session) return
    // 二进制帧 = **原始输入字节**：ZMODEM 协议帧不能过 UTF-8 编码，进 JSON 还要 base64 膨胀 1/3
    if (isBinary) {
      session.write(Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer))
      return
    }
    let message: TerminalClientMessage
    try {
      message = JSON.parse(String(raw)) as TerminalClientMessage
    } catch {
      return
    }
    if (message.type === 'input') session.write(message.data)
    else if (message.type === 'resize') session.resize(message.cols, message.rows)
    // 「停止」与 `input` 里的 `\x03` 是两道闸：那道是「请求中断」（程序可以不理会），
    // 这道是「必须停」。没有实现 `stopForeground` 的通道（SSH）直接忽略。
    else if (message.type === 'stop') void session.stopForeground?.()
    // 应用层心跳：客户端每 10s 发 `ping`，这里回 `pong` 撑过代理的空闲超时
    else if (message.type === 'ping') sendJson(ws, { type: 'pong' })
  })

  /*
   * 心跳保活：终端是**静默**通道 —— 用户不敲键、程序没输出时链路上一个字节都没有。
   * 走域名时前面通常有 nginx，其 `proxy_read_timeout` 默认 60s：空闲连接会被代理直接掐掉，
   * 用户看到的就是「终端莫名其妙断了」。每 30s 发一个协议层 ping（浏览器自动回 pong）。
   *
   * 回收僵死连接：上一轮 pong 没回来就 terminate，免得 PTY 一直挂着。但**一轮不回不算数**，
   * 得连着两轮都空（≈60~90s 毫无回包）才收：丢一个 pong 的场景很日常（手机息屏、系统休眠、
   * 代理缓冲、弱网），而 terminate 的代价是用户的终端连同里面跑着的程序一起没了。
   */
  let missedPongs = 0
  const heartbeat = setInterval(() => {
    if (missedPongs >= 2) {
      console.warn(`[${logScope}] 连续两轮心跳无响应，断开连接`)
      ws.terminate()
      return
    }
    missedPongs += 1
    try {
      ws.ping()
    } catch {
      // 正在关闭：close 会清场
    }
  }, 30_000)
  ws.on('pong', () => {
    missedPongs = 0
  })

  // 客户端断开（关面板 / 刷新页面）：终端是给人交互用的，没人看了就收掉
  const cleanup = (): void => {
    clearInterval(heartbeat)
    session?.kill()
  }
  ws.on('close', cleanup)
  ws.on('error', cleanup)
}
