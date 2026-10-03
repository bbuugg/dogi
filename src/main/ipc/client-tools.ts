import { ipcMain } from 'electron'
import { clientToolBroker } from '../services/ai/client-tools'
import type { IpcContext } from './shared'

/**
 * 客户端工具（client tools）IPC：渲染端执行、渲染端确认。
 *
 * 定义**不经过 IPC 注册** —— 随 `agent:chat` 请求携带（页面发消息时带上自己那组），
 * 主进程组装进工具集。这里只剩回填通道：模型调用时广播 `clientTools:invoke`，
 * 渲染端（按自己的权限策略处理完）经 `clientTools:result` 回填。
 */
export function registerClientToolsIpc(ctx: IpcContext): void {
  clientToolBroker.setBroadcaster((channel, payload) => ctx.broadcast(channel, payload))

  ipcMain.handle(
    'clientTools:result',
    (_e, payload: { callId: string; ok: boolean; result?: unknown; error?: string }) =>
      clientToolBroker.resolve(payload)
  )
}
