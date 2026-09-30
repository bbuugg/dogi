import { app, dialog, ipcMain } from 'electron'
import { stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { executeHttp } from '../services/api/http'
import { wsService } from '../services/api/ws'
import { storage } from '../services/storage'
import type {
  ApiHistoryEntry,
  ApiHttpRequest,
  ApiPickFileResult,
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
/**
 * 进行中的 HTTP 请求（sendId → controller）。
 * 渲染端每次 api:send 带一个自生成的 sendId，点「取消」时按它中断对应请求；
 * 请求结束（无论成败）立即移除，避免 Map 无限增长。
 */
const inflightHttp = new Map<string, AbortController>()

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
  // 由主进程发出请求：不受渲染进程 CORS 限制，可访问内网与自签证书服务。
  // sendId 由渲染端生成：登记 AbortController，供 api:abort 手动取消。
  ipcMain.handle('api:send', async (_e, req: ApiHttpRequest, sendId?: string) => {
    const ac = new AbortController()
    if (sendId) inflightHttp.set(sendId, ac)
    try {
      return await executeHttp(req, ac.signal)
    } finally {
      if (sendId) inflightHttp.delete(sendId)
    }
  })
  // 取消进行中的请求：中断 fetch，api:send 照常回包（status=0 + error）
  ipcMain.handle('api:abort', (_e, sendId: string) => {
    inflightHttp.get(sendId)?.abort()
    inflightHttp.delete(sendId)
  })
  // 为 form-data 的文件字段选一个本地文件。
  // 渲染端只拿得到「路径 + 文件名 + 大小」：文件内容由 api:send 在主进程侧读
  //（渲染进程没有 fs，也不该为了发一个文件把它整个搬进内存再走 IPC）。
  ipcMain.handle('api:pickFile', async (): Promise<ApiPickFileResult> => {
    // 原生对话框无法被自动化点击（同 sftp:uploadDir 的取法）：探针用环境变量指定文件，
    // 正常运行不设该变量，照常弹对话框。
    let filePath = process.env.DOGI_API_PICK_FILE || ''
    if (!filePath) {
      const window = ctx.win()
      const options = { title: '选择要上传的文件', properties: ['openFile' as const] }
      const result =
        window && !window.isDestroyed()
          ? await dialog.showOpenDialog(window, options)
          : await dialog.showOpenDialog(options)
      if (result.canceled || !result.filePaths.length) return { canceled: true }
      filePath = result.filePaths[0]
    }
    try {
      const info = await stat(filePath)
      if (!info.isFile()) return { canceled: false, error: `所选路径不是文件：${filePath}` }
      return {
        canceled: false,
        file: { path: filePath, name: basename(filePath), size: info.size }
      }
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e)
      return { canceled: false, error: `无法读取所选文件：${filePath} —— ${reason}` }
    }
  })

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
