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
import { browserSessions } from '../services/browser/session'
import { agentBrowserSessionId } from '@shared/browser'
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
 * 同一个 `agent:*` 通道下按后端分派（backend 字段，按会话独立）：
 * - 非 ACP 模型默认走内置 Mastra agent（agentService.mastraChat，复用同一套模型配置与工具）；
 * - 旧会话若存的是 `ai-sdk` 仍走原生 AI SDK 路径（agentService.chat）作为兜底；
 * - `acp` 走外部 ACP agent（acpAgentService）。
 * 确认卡所有后端共用同一通道 —— 渲染端不必关心是哪一个在要权限。
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
  ipcMain.handle('agent:workspaces:delete', async (_e, id: string) => {
    // 会话由 storage 一并清掉；它们的浏览器 profile（登录态等持久化数据）不能留在盘上
    // 变成没人认领的孤儿目录 —— 先记下受害者再删，逐个 purge
    const victims = storage
      .listAgentConversations()
      .filter((c) => c.workspaceId === id)
      .map((c) => c.id)
    const workspaces = storage.deleteAgentWorkspace(id)
    for (const cid of victims) await browserSessions.purge(agentBrowserSessionId(cid))
    return workspaces
  })

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
        modelId?: string
      }
    ) => storage.saveAgentConversation(input)
  )
  ipcMain.handle('agent:conversations:delete', async (_e, id: string) => {
    storage.deleteAgentConversation(id)
    // 会话没了，它的浏览器 profile（登录态等）跟着删 —— 见 session.ts 的 purge 说明
    await browserSessions.purge(agentBrowserSessionId(id))
  })

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
    // 后端**按会话**独立：优先取请求里带的（渲染端是会话记录的唯一真源），
    // 其次回退到会话记录 / 工作区设置 —— 切一个会话的后端不该影响其它会话。
    // 非 ACP 默认走内置 Mastra agent；旧会话存的 'ai-sdk' 仍走原路径，不强制迁移。
    const backend = req.backend ?? conv?.backend ?? ws?.backend ?? 'mastra'
    let result: { requestId: string }
    if (backend === 'acp') {
      result = await acpAgentService.chat(req)
    } else if (backend === 'ai-sdk') {
      result = await agentService.chat(req)
    } else {
      result = await agentService.mastraChat(req)
    }
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
