import { ipcMain } from 'electron'
import { agentService } from '../services/ai/agent'
import { acpAgentService } from '../services/ai/acp-agent'
import { storage } from '../services/storage'
import type { AgentChatRequest, AgentStreamEvent } from '@shared/types'
import type { IpcContext } from './shared'

/**
 * 工作区 Agent IPC：工作区 CRUD、对话流、确认卡。
 *
 * 同一个 `agent:*` 通道下面是**两个可切换的后端**（按工作区的 backend 字段分派）：
 * 内置 AI SDK（agentService）与外部 ACP agent（acpAgentService）。
 * 确认卡两个后端共用同一通道 —— 渲染端不必关心是哪一个在要权限。
 */
export function registerAgentIpc(ctx: IpcContext): void {
  ipcMain.handle('agent:workspaces:list', () => storage.listAgentWorkspaces())
  ipcMain.handle(
    'agent:workspaces:save',
    (_e, input: { id?: string; name: string; path: string }) =>
      storage.saveAgentWorkspace(input)
  )
  ipcMain.handle('agent:workspaces:delete', (_e, id: string) =>
    storage.deleteAgentWorkspace(id)
  )

  ipcMain.handle('agent:chat', async (_e, req: AgentChatRequest) => {
    // 后端按工作区（会话）独立：acp 走外部 agent 连接，其余走内置 AI SDK
    const ws = storage.getAgentWorkspace(req.workspaceId)
    return (ws?.backend === 'acp' ? acpAgentService : agentService).chat(req)
  })
  ipcMain.handle('agent:abort', (_e, requestId: string) => {
    agentService.abort(requestId)
    acpAgentService.abort(requestId)
  })
  agentService.on('chat-event', (requestId: string, event: AgentStreamEvent) =>
    ctx.broadcast('agent:chat-event', { requestId, event })
  )
  acpAgentService.on('chat-event', (requestId: string, event: AgentStreamEvent) =>
    ctx.broadcast('agent:chat-event', { requestId, event })
  )

  agentService.setConfirmSink({
    request: (req) => ctx.broadcast('agent:confirm', req),
    resolved: (id) => ctx.broadcast('agent:confirm-resolved', { id })
  })
  acpAgentService.setConfirmSink({
    request: (req) => ctx.broadcast('agent:confirm', req),
    resolved: (id) => ctx.broadcast('agent:confirm-resolved', { id })
  })
  ipcMain.handle(
    'agent:confirm:resolve',
    (_e, payload: { id: string; approved: boolean }) => {
      agentService.resolveConfirm(payload.id, payload.approved)
      acpAgentService.resolveConfirm(payload.id, payload.approved)
    }
  )
}
