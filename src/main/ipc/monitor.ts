import { ipcMain } from 'electron'
import { monitorService } from '../services/terminal/monitor'
import { sessionManager } from '../services/terminal/sessions'
import { storage } from '../services/storage'
import type { ServerMetrics, SessionInfo } from '@shared/types'
import type { IpcContext } from './shared'

/**
 * 服务器监控 IPC：指标推送与采集间隔。
 *
 * 采集的生命周期跟着会话走，所以这里自己订阅 sessionManager 的 created / closed
 * （terminal.ts 也订阅同一批事件做转发，EventEmitter 支持多监听器，互不依赖）。
 */
export function registerMonitorIpc(ctx: IpcContext): void {
  monitorService.on('data', (payload: { sessionId: string; metrics: ServerMetrics }) =>
    ctx.broadcast('monitor:data', payload)
  )
  // 连接到主机后即在后台采集指标；采集不到数据的主机会自动停止（前端不显示）
  sessionManager.on('created', (info: SessionInfo) => monitorService.start(info.id))
  // 会话关闭时停止其监控，避免泄漏
  sessionManager.on('closed', ({ sessionId }: { sessionId: string }) =>
    monitorService.stop(sessionId)
  )

  // 采集间隔：启动时沿用上次的设置；渲染端调整后立即对现有会话生效并持久化
  monitorService.setInterval(storage.getPreferences().monitorInterval)
  ipcMain.handle('monitor:setInterval', (_e, ms: number) => {
    monitorService.setInterval(ms)
    return storage.savePreferences({ monitorInterval: monitorService.getInterval() })
  })
}
