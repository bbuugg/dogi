import { ipcMain } from 'electron'
import { agentService } from '../services/ai/agent'
import { acpAgentService } from '../services/ai/acp-agent'
import {
  listWorkspaceDir,
  readWorkspaceFile,
  writeWorkspaceFile
} from '../services/ai/workspace-fs'
import {
  ensureWorkspaceConfigDir,
  readWorkspaceConfig,
  saveWorkspaceConfig
} from '../services/ai/workspace-config'
import { storage } from '../services/storage'
import type {
  AgentBackend,
  AgentChatMessage,
  AgentChatRequest,
  AgentStreamEvent
} from '@shared/types'
import type { WorkspaceConfig } from '@shared/workspace-config'
import type { IpcContext } from './shared'

/** 取工作区；不存在就抛错（渲染端拿到的是明确原因，不是空数组） */
function requireWorkspace(id: string) {
  const ws = storage.getAgentWorkspace(id)
  if (!ws) throw new Error('工作区不存在，请重新选择')
  return ws
}

/**
 * 工作区 Agent IPC：工作区 CRUD、对话流、确认卡。
 *
 * 同一个 `agent:*` 通道下面是**两个可切换的后端**（按工作区的 backend 字段分派）：
 * 内置 AI SDK（agentService）与外部 ACP agent（acpAgentService）。
 * 确认卡两个后端共用同一通道 —— 渲染端不必关心是哪一个在要权限。
 */
export function registerAgentIpc(ctx: IpcContext): void {
  /**
   * 对话请求 → 会话 id。渲染端要靠它把事件路由到正确的会话，而它自己那张表
   * 建立得比事件晚（见 agent:chat 里的说明），所以由主进程在广播里带上。
   */
  const chatConversations = new Map<string, string>()

  /** 广播一条流事件（带上归属会话；一轮结束后清理映射） */
  const broadcastAgentEvent = (requestId: string, event: AgentStreamEvent): void => {
    const conversationId = chatConversations.get(requestId)
    ctx.broadcast('agent:chat-event', { requestId, conversationId, event })
    if (event.type === 'finish') chatConversations.delete(requestId)
  }

  ipcMain.handle('agent:workspaces:list', () => storage.listAgentWorkspaces())
  ipcMain.handle(
    'agent:workspaces:save',
    async (_e, input: { id?: string; name: string; path: string }) => {
      const workspaces = storage.saveAgentWorkspace(input)
      // 工作区一落地就在项目目录里备好隐藏配置目录（已有则只补齐缺失的文件），
      // 这样「工作区配置存在哪」不依赖用户先点开过配置弹窗
      const saved = workspaces.find((w) => w.path === input.path)
      if (saved) {
        try {
          await ensureWorkspaceConfigDir(saved.path)
        } catch (err) {
          // 目录不可写之类的问题不该让「添加工作区」失败，配置弹窗里会再暴露一次
          console.warn('[workspace] 创建配置目录失败:', saved.path, err)
        }
      }
      return workspaces
    }
  )
  ipcMain.handle('agent:workspaces:delete', (_e, id: string) =>
    storage.deleteAgentWorkspace(id)
  )

  // ---------- 会话（一个工作区下可以有多个） ----------
  ipcMain.handle('agent:conversations:list', () => storage.listAgentConversations())
  ipcMain.handle(
    'agent:conversations:save',
    (
      _e,
      input: {
        id?: string
        workspaceId: string
        title?: string
        messages?: AgentChatMessage[]
        backend?: AgentBackend
        configId?: string
      }
    ) => storage.saveAgentConversation(input)
  )
  ipcMain.handle('agent:conversations:delete', (_e, id: string) =>
    storage.deleteAgentConversation(id)
  )

  // ---------- 工作区文件（右侧文件树的懒加载列表 + 编辑器读写） ----------
  ipcMain.handle('agent:fs:list', (_e, payload: { workspaceId: string; dir?: string }) =>
    listWorkspaceDir(requireWorkspace(payload.workspaceId), payload.dir ?? '')
  )
  ipcMain.handle('agent:fs:read', (_e, payload: { workspaceId: string; path: string }) =>
    readWorkspaceFile(requireWorkspace(payload.workspaceId), payload.path)
  )
  ipcMain.handle(
    'agent:fs:write',
    (_e, payload: { workspaceId: string; path: string; content: string }) =>
      writeWorkspaceFile(requireWorkspace(payload.workspaceId), payload.path, payload.content)
  )

  // ---------- 工作区目录配置（`<工作区>/.dogi/workspace.json`：快捷功能等） ----------
  // 配置跟着项目目录走，所以不走 electron-store；读写都由 services/ai/workspace-config 落盘
  ipcMain.handle('agent:workspace:config:get', (_e, workspaceId: string) =>
    readWorkspaceConfig(requireWorkspace(workspaceId))
  )
  ipcMain.handle(
    'agent:workspace:config:save',
    (_e, payload: { workspaceId: string; config: WorkspaceConfig }) =>
      saveWorkspaceConfig(requireWorkspace(payload.workspaceId), payload.config)
  )

  ipcMain.handle('agent:chat', async (_e, req: AgentChatRequest) => {
    // 后端**按会话**独立：优先取请求里带的（渲染端是会话记录的唯一真源），
    // 其次回退到会话记录 / 工作区设置 —— 切一个会话的后端不该影响其它会话
    const conv = storage.listAgentConversations().find((c) => c.id === req.conversationId)
    const ws = storage.getAgentWorkspace(req.workspaceId)
    const backend = req.backend ?? conv?.backend ?? ws?.backend ?? 'ai-sdk'
    const result = await (backend === 'acp' ? acpAgentService : agentService).chat(req)
    // 事件归属：**必须在这里登记**，因为「未配置模型」这种失败分支是用 setTimeout(0)
    // 发事件的，会比 invoke 的回包更早到达渲染端 —— 渲染端那时还不知道 requestId 属于谁，
    // 事件就被丢掉了（表现为转圈不结束、通知不弹）。这里同步微任务一定早于那个定时器。
    chatConversations.set(result.requestId, req.conversationId)
    return result
  })
  ipcMain.handle('agent:abort', (_e, requestId: string) => {
    agentService.abort(requestId)
    acpAgentService.abort(requestId)
  })
  agentService.on('chat-event', broadcastAgentEvent)
  acpAgentService.on('chat-event', broadcastAgentEvent)

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
