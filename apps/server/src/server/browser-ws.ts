/**
 * 浏览器画面的 **WebSocket 出口**：`/api/browser?sessionId=...`。
 *
 * 一条连接 = 订阅某会话（sessionId = `agent-browser:<conversationId>`）的 screencast 帧
 * 与状态推送；渲染端的右侧面板据此实时显示 Agent 操作的浏览器。面板发回的控制消息
 * （导航 / 前进后退 / 刷新 / 切视口 / 鼠标键盘输入）在这里转成对引擎的调用。
 *
 * desktop 与 web 共用本处理器：desktop 经进程内后端内部的 loopback WS 端口、web 经 server
 * 的 WS，两者都打到 `/api/browser`，与终端 / 工作台 WS 同一套升级分流（见 `../ws.ts`）。
 *
 * ⚠️ 不自己挂 `server.on('upgrade')`：统一由 `../ws.ts` 分流后再调 `handleBrowserUpgrade()`。
 */
import type { Duplex } from 'node:stream'
import type { IncomingMessage } from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'
import type { BrowserClientMessage, BrowserEvent } from '@fizz/contracts'
import { rejectSocket } from './lib/ws'
import { verifyWsToken } from './auth'
import { browserSessions, subscribeBrowser, ensureBrowserSession } from '@fizz/tools'

function sendJson(ws: WebSocket, message: BrowserEvent): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message))
}

function handleConnection(ws: WebSocket, url: URL): void {
  const sessionId = url.searchParams.get('sessionId') ?? ''
  if (!sessionId) {
    ws.close(1011, '缺少 sessionId')
    return
  }

  // 先订阅（按 sessionId 路由，与引擎共用一个 hub）。会话可能还没被 Agent 拉起 ——
  // 此时先挂着，等 Agent 一调 browser_navigate 建出会话、开始推帧，画面就自动流过来，
  // 不用面板反复重连。
  const unsubscribe = subscribeBrowser(sessionId, (event) => {
    sendJson(ws, event)
    // closed 到后把连接收掉（客户端也能据此显示「浏览器已关闭」）
    if (event.type === 'closed') {
      try {
        ws.close()
      } catch {
        /* 已关 */
      }
    }
  })
  // 会话已在跑：补一帧最新画面 + 最近状态（静止页面没有新帧/状态，重挂载时立刻出图）
  const existing = browserSessions.get(sessionId)
  if (existing?.isAlive()) {
    existing.replayLastFrame()
    existing.replayLastState()
  }

  ws.on('message', async (raw: unknown, isBinary: boolean) => {
    if (isBinary) return
    let message: BrowserClientMessage
    try {
      message = JSON.parse(String(raw)) as BrowserClientMessage
    } catch {
      return
    }
    // 会话还没拉起时，第一条控制消息（输网址 / 点按钮 / 发键盘鼠标）按需把它建起来：
    // 这样用户不依赖 Agent 也能手动浏览。建不起来（没装浏览器等）通知前端显示失败。
    let session: Awaited<ReturnType<typeof ensureBrowserSession>> | undefined
    try {
      session = await ensureBrowserSession(sessionId)
    } catch {
      sendJson(ws, { type: 'closed', sessionId, reason: '浏览器启动失败' })
      return
    }
    switch (message.type) {
      case 'input':
        void session.dispatchInput(message.event)
        break
      case 'navigate':
        void session.navigate(message.url)
        break
      case 'back':
        void session.goBack()
        break
      case 'forward':
        void session.goForward()
        break
      case 'reload':
        void session.reload()
        break
      case 'setViewportMode':
        void session.setViewportMode(message.mode)
        break
    }
  })

  const cleanup = (): void => {
    unsubscribe()
  }
  ws.on('close', cleanup)
  ws.on('error', cleanup)
}

const wss = new WebSocketServer({ noServer: true })

/** 浏览器端点的 noServer 实例（由 `../ws.ts` 分流后交给它） */
export function matchBrowserPath(pathname: string): boolean {
  return pathname === '/api/browser'
}

/**
 * 处理一条**已经确认路径是浏览器**的升级请求。鉴权与握手都在这里；
 * 意外抛出由 `../ws.ts` 的最外层 try/catch 兜底（upgrade 不在 Hono onError 覆盖范围内）。
 */
export function handleBrowserUpgrade(
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
      wss.handleUpgrade(req, socket, head, (ws) => handleConnection(ws, url))
    } catch {
      rejectSocket(socket, 'HTTP/1.1 500 Internal Server Error\r\n\r\n')
    }
  })()
}
