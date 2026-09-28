import { ipcMain, app } from 'electron'
import { join } from 'node:path'
import type {
  BrowserChannel,
  BrowserInputEvent,
  BrowserSessionState,
  BrowserViewportMode
} from '@shared/types'
import { DEFAULT_BROWSER_VIEWPORT } from '@shared/browser'
import {
  browserSessions,
  setBrowserProfilesRoot
} from '../services/browser/session'
import { createBrowserSessionHandlers, setBrowserBroadcaster } from '../services/browser/handlers'
import { storage } from '../services/storage'
import type { IpcContext } from './shared'

/**
 * 浏览器会话的 IPC（Agent 的 browser_* 工具与内嵌面板共用）。
 *
 * 所有流式事件（帧 / 状态 / 关闭）都带 sessionId 并走 ctx.broadcast ——
 * 渲染端一个浏览器面板一个 sessionId，据此把事件路由到对应的面板（AGENTS.md 4.2）。
 */
export function registerBrowserIpc(ctx: IpcContext): void {
  /**
   * 会话出口集中注册在这里（那时才拿得到 IpcContext）。
   * Agent 的浏览器工具（services/browser/agent.ts）会在对话中途懒启动会话，
   * 它拿不到 ctx，但能拿到同一个 broadcaster —— 两边的帧走同一组 `browser:*` 通道。
   */
  setBrowserBroadcaster((channel, payload) => ctx.broadcast(channel, payload))
  // 持久化 profile 的落点：登录态要活得过会话重启（关标签 / browser_close / 应用重启），
  // 见 session.ts —— 只有删除会话 / 工作区才清 profile
  setBrowserProfilesRoot(join(app.getPath('userData'), 'browser-profiles'))
  const handlers = createBrowserSessionHandlers

  /**
   * 启动会话。`mode` 是视口预设（PC / 手机），**不是面板尺寸** ——
   * 面板宽度决定的是画面缩放比例，不该决定页面走哪套响应式断点，理由见 @shared/browser。
   */
  ipcMain.handle(
    'browser:open',
    async (
      _e,
      payload: { sessionId: string; url?: string; mode?: BrowserViewportMode }
    ): Promise<BrowserSessionState> => {
      const session = browserSessions.create(payload.sessionId, handlers())
      const mode = payload.mode ?? DEFAULT_BROWSER_VIEWPORT
      if (session.isAlive()) {
        // 会话还活着（面板重挂载、切标签页回来）就**只切视口 / UA**：
        // `start()` 见到已启动的浏览器会直接 return，拿它当「重启」是无效的 ——
        // 页面会一直停在旧视口，看起来就是「按钮显示 PC、画面还是手机」。
        await session.setViewportMode(mode)
      } else {
        const pref = (storage.getPreferences().browserChannel ?? 'auto') as BrowserChannel
        await session.start(pref, mode)
      }
      const url = payload.url?.trim()
      if (url) await session.navigate(url)
      return session.state()
    }
  )

  ipcMain.handle('browser:close', async (_e, sessionId: string) => {
    await browserSessions.close(sessionId, '标签已关闭')
  })

  ipcMain.handle('browser:state', (_e, sessionId: string) => {
    const session = browserSessions.get(sessionId)
    if (!session) return null
    // 面板重挂载（切标签页回来）时主动拉一次：会话还活着就补一帧最新画面。
    // screencast 只在页面变化时推帧，静止页面等不到推送，面板会一直显示
    // 「浏览器还没打开」，同时 mode 退回默认值 —— 和真实视口对不上。
    if (session.isAlive()) session.replayLastFrame()
    return session.state()
  })

  ipcMain.handle('browser:navigate', async (_e, p: { sessionId: string; url: string }) => {
    await browserSessions.get(p.sessionId)?.navigate(p.url)
  })

  ipcMain.handle('browser:back', async (_e, sessionId: string) => {
    await browserSessions.get(sessionId)?.goBack()
  })

  ipcMain.handle('browser:forward', async (_e, sessionId: string) => {
    await browserSessions.get(sessionId)?.goForward()
  })

  ipcMain.handle('browser:reload', async (_e, sessionId: string) => {
    await browserSessions.get(sessionId)?.reload()
  })

  /**
   * 输入转发。**不 await 到串行队列里**：鼠标移动是高频事件，
   * 每条都等 CDP 往返会让拖动明显滞后。
   */
  ipcMain.handle('browser:input', (_e, p: { sessionId: string; event: BrowserInputEvent }) => {
    void browserSessions.get(p.sessionId)?.dispatchInput(p.event)
  })

  ipcMain.handle(
    'browser:viewport',
    async (_e, p: { sessionId: string; mode: BrowserViewportMode }) => {
      await browserSessions.get(p.sessionId)?.setViewportMode(p.mode)
    }
  )
}
