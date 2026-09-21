import { app, ipcMain } from 'electron'
import { executeHttp } from '../services/api/http'
import { wsService } from '../services/api/ws'
import { storage } from '../services/storage'
import type {
  ApiHistoryEntry,
  ApiHttpRequest,
  ApiRequestEntry,
  WsConnectOptions,
  WsEvent,
  WsSendPayload
} from '@shared/types'
import type { IpcContext } from './shared'

/**
 * 接口请求 IPC：HTTP 请求的保存 / 历史，以及 WebSocket 长连接调试。
 *
 * HTTP 与 WebSocket 由主进程真正发出（渲染进程受 CORS 限制，也访问不了内网自签证书服务）。
 */
export function registerApiIpc(ctx: IpcContext): void {
  ipcMain.handle('api:list', () => storage.listApiRequests())
  ipcMain.handle('api:save', (_e, entry: ApiRequestEntry) => storage.saveApiRequest(entry))
  ipcMain.handle('api:delete', (_e, id: string) => storage.deleteApiRequest(id))
  ipcMain.handle(
    'api:arrange',
    (
      _e,
      payload: { groupIds: string[]; requests: Array<{ id: string; groupId?: string }> }
    ) => storage.arrangeApi(payload)
  )
  ipcMain.handle('api:groups:list', () => storage.listApiGroups())
  ipcMain.handle('api:groups:save', (_e, input: { id?: string; name: string }) =>
    storage.saveApiGroup(input)
  )
  ipcMain.handle('api:groups:delete', (_e, id: string, deleteRequests?: boolean) =>
    storage.deleteApiGroup(id, deleteRequests)
  )
  ipcMain.handle('api:history:list', () => storage.listApiHistory())
  ipcMain.handle('api:history:save', (_e, entries: ApiHistoryEntry[]) =>
    storage.saveApiHistory(entries)
  )
  ipcMain.handle('api:history:clear', () => storage.clearApiHistory())
  // 由主进程发出请求：不受渲染进程 CORS 限制，可访问内网与自签证书服务
  ipcMain.handle('api:send', (_e, req: ApiHttpRequest) => executeHttp(req))

  // ---------- WebSocket 调试（接口请求里的 ws 协议） ----------
  // 长连接：open 只负责建连并返回 connId，握手结果与收发的每一帧都走 'ws:event' 推送。
  // connId 由渲染端先生成再传进来 —— 见 wsService.open 的注释（避免握手快于 IPC 回包）。
  ipcMain.handle('ws:open', (_e, connId: string, options: WsConnectOptions) =>
    wsService.open(connId, options)
  )
  ipcMain.handle('ws:send', (_e, connId: string, payload: WsSendPayload) =>
    wsService.send(connId, payload)
  )
  ipcMain.handle('ws:close', (_e, connId: string, code?: number, reason?: string) =>
    wsService.close(connId, code, reason)
  )
  wsService.on('event', (event: WsEvent) => ctx.broadcast('ws:event', event))
  // 退出前把还开着的连接关掉，避免进程退出时残留半开的 socket
  app.on('before-quit', () => wsService.closeAll())
}
