import type { BrowserSessionHandlers } from './session'

/**
 * 浏览器会话的对外事件出口。
 *
 * 会话可能被两条路径创建：渲染端面板的 `browser:open`（走 ipc/browser.ts），
 * 以及 Agent 工具第一次调用时的懒启动（走 services/browser/agent.ts）。
 * 两边的帧 / 状态都要推到渲染端同一组 `browser:*` 通道，所以出口集中在这里，
 * 由 `registerBrowserIpc` 在注册时注入一次 broadcaster（那时才拿得到 IpcContext）。
 *
 * 所有事件都**自带 sessionId**（AGENTS.md 4.2）—— 渲染端据此把帧路由到对应面板，
 * 不依赖「先建映射再收事件」的时序。
 */
type Broadcaster = (channel: string, payload: unknown) => void

let broadcaster: Broadcaster | null = null

export function setBrowserBroadcaster(fn: Broadcaster): void {
  broadcaster = fn
}

export function createBrowserSessionHandlers(): BrowserSessionHandlers {
  const send: Broadcaster = (channel, payload) => broadcaster?.(channel, payload)
  return {
    onFrame: (frame) => send('browser:frame', frame),
    onState: (state) => send('browser:state', state),
    onClosed: (payload) => send('browser:closed', payload)
  }
}
