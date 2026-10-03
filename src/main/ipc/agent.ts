import { ipcMain } from 'electron'
import { agentService } from '../services/ai/agent'
import { acpAgentService } from '../services/ai/acp-agent'
import { detectInstalledAcpAgents } from '../services/ai/acp-detect'
import { sessionManager } from '../services/terminal/sessions'
import { clearConversationSummary, compressConversationNow } from '../services/ai/context-summary'
import {
  listWorkspaceDir,
  readWorkspaceFile,
  writeWorkspaceFile,
  deleteWorkspacePath,
  renameWorkspacePath,
  createWorkspacePath,
  copyWorkspacePath
} from '../services/ai/workspace-fs'
import {
  ensureWorkspaceConfigDir,
  readWorkspaceConfig,
  saveWorkspaceConfig
} from '../services/ai/workspace-config'
import { storage } from '../services/storage'
import { browserSessions } from '../services/browser/session'
import { purgeArtifacts } from '../services/ai/output-artifact'
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

/** 取某个已登记的 ACP agent 配置；不存在就抛错（渲染端提示「重新导入」） */
function requireAcpAgent(id?: string) {
  const cfg = id ? storage.getAiSettings().acpAgents?.find((a) => a.id === id) : undefined
  if (!cfg?.command) throw new Error('该 ACP agent 配置不存在，请重新检测 / 添加')
  return cfg
}

/**
 * Agent IPC：工作区 CRUD、对话流（工作区 + 终端两条作用域）、确认卡、ACP 会话导入。
 *
 * `agent:chat` 先按**会话作用域**（`scope`）分派：`workspace`（缺省）与 `terminal`
 * （终端 AI 助手）都由 agentService 承接 —— 同一个引擎、不同的工具与提示词；
 * workspace 内再按**会话形态**（`kind`）分流：
 * - `mastra`：内置 Mastra agent（agentService），消息随会话落盘；
 * - `acp`：外部 ACP agent（acpAgentService），**消息由 agent 自己管理**，
 *   本地只存绑定关系（acpAgentId + acpSessionId）。
 * 确认卡各路径共用同一通道 —— 渲染端不必关心是哪一个在要权限。
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
    for (const cid of victims) {
      await browserSessions.purge(agentBrowserSessionId(cid))
      await purgeArtifacts(cid)
    }
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
        kind?: AgentBackend
        title?: string
        messages?: AgentChatMessage[]
        configId?: string
        modelId?: string
        acpAgentId?: string
        acpSessionId?: string
      }
    ) => storage.saveAgentConversation(input)
  )
  ipcMain.handle('agent:conversations:delete', async (_e, id: string) => {
    storage.deleteAgentConversation(id)
    // 会话没了，它的浏览器 profile（登录态等）跟着删 —— 见 session.ts 的 purge 说明
    await browserSessions.purge(agentBrowserSessionId(id))
    // 长输出产物同理：会话删了，产物也没人再读回去
    await purgeArtifacts(id)
  })

  // ---------- 终端 AI 助手会话（独立目录存储，绝不进工作区会话列表） ----------
  // 会话模型与工作区会话同构（AgentConversation），但物理分目录 ——
  // 「不入 AI Agent 列表」由存储边界保证（见 conversation-store.ts 的 terminalConversationStore）
  ipcMain.handle('agent:terminal-convs:list', () => storage.listTerminalConversations())
  ipcMain.handle(
    'agent:terminal-convs:save',
    (
      _e,
      input: {
        id?: string
        kind?: AgentBackend
        title?: string
        messages?: AgentChatMessage[]
        configId?: string
        modelId?: string
      }
    ) => storage.saveTerminalConversation(input)
  )
  ipcMain.handle('agent:terminal-convs:delete', async (_e, id: string) => {
    storage.deleteTerminalConversation(id)
    await purgeArtifacts(id)
  })
  // 终端会话关闭：中止绑定在它上面的终端对话（挂起的确认 / 提问 / 客户端工具一并收尾）
  sessionManager.on('closed', ({ sessionId }: { sessionId: string }) =>
    agentService.disposeTerminalSession(sessionId)
  )

  // ---------- 上下文摘要检查点（手动压缩） ----------
  // 原始消息一条不动：压缩只改「组装发往模型的历史」，所以清除摘要就是无损回到全文。
  ipcMain.handle('agent:context:compress', (_e, conversationId: string) =>
    compressConversationNow(conversationId)
  )
  ipcMain.handle('agent:context:clear', (_e, conversationId: string) =>
    clearConversationSummary(conversationId)
  )

  // ---------- ACP：检测 / 会话发现 / 历史回放 / 模型切换 ----------
  /** 扫描本机 PATH 里已安装的已知 ACP agent（导入弹窗的「检测」用） */
  ipcMain.handle('agent:acp:detect', () => detectInstalledAcpAgents())
  /** 拉取某个 agent 侧的会话列表（`session/list`）：导入弹窗的数据源 */
  ipcMain.handle(
    'agent:acp:listSessions',
    (_e, payload: { acpAgentId: string; cwd?: string }) =>
      acpAgentService.listSessions(requireAcpAgent(payload.acpAgentId), payload.cwd)
  )
  /** 向 agent 询问可用模型（临时建连读 configOptions）：设置页勾选模型用 */
  ipcMain.handle('agent:acp:listModels', (_e, acpAgentId: string) =>
    acpAgentService.listModels(requireAcpAgent(acpAgentId))
  )
  /** 让 agent 删掉它那边的会话（`session/delete`）：删除会话弹窗里的可选项 */
  ipcMain.handle(
    'agent:acp:deleteSession',
    (_e, payload: { acpAgentId: string; sessionId: string }) =>
      acpAgentService.deleteSession(requireAcpAgent(payload.acpAgentId), payload.sessionId)
  )
  /** 打开一个 ACP 会话：让 agent 用 `session/load` 回放历史（本地不落盘） */
  ipcMain.handle(
    'agent:acp:load',
    async (
      _e,
      payload: {
        workspaceId: string
        conversationId: string
        acpAgentId?: string
        acpSessionId?: string
        modelId?: string
      }
    ) => {
      const result = await acpAgentService.load(payload)
      // 与 chat 同一套归属登记：历史/错误事件可能早于 invoke 回包到达
      chatConversations.set(result.requestId, payload.conversationId)
      return result
    }
  )
  /** 切换某个 ACP 会话的模型（`session/set_config_option`，不重建会话） */
  ipcMain.handle(
    'agent:acp:setModel',
    (_e, payload: { conversationId: string; modelId?: string }) =>
      acpAgentService.setModel(payload.conversationId, payload.modelId)
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
  // ---------- 工作区文件（右键菜单 / 触屏长按：删、重命名、新建、复制/剪切粘贴） ----------
  ipcMain.handle('agent:fs:delete', (_e, payload: { workspaceId: string; path: string }) =>
    deleteWorkspacePath(requireWorkspace(payload.workspaceId), payload.path)
  )
  ipcMain.handle(
    'agent:fs:rename',
    (_e, payload: { workspaceId: string; path: string; name: string }) =>
      renameWorkspacePath(requireWorkspace(payload.workspaceId), payload.path, payload.name)
  )
  ipcMain.handle(
    'agent:fs:create',
    (
      _e,
      payload: { workspaceId: string; dir: string; name: string; type: 'file' | 'dir' }
    ) =>
      createWorkspacePath(
        requireWorkspace(payload.workspaceId),
        payload.dir,
        payload.name,
        payload.type
      )
  )
  ipcMain.handle(
    'agent:fs:copy',
    (
      _e,
      payload: {
        workspaceId: string
        from: string
        toDir: string
        mode: 'copy' | 'move'
      }
    ) =>
      copyWorkspacePath(
        requireWorkspace(payload.workspaceId),
        payload.from,
        payload.toDir,
        payload.mode
      )
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
    // 作用域分派：terminal（终端助手）与 workspace（缺省）都进 agentService；
    // workspace 内再按**会话形态**分流（按会话固定：优先取请求里带的，其次回退到
    // 磁盘上的会话记录 —— 老会话记录缺 kind 时按 mastra 处理）。
    if ((req.scope ?? 'workspace') === 'workspace') {
      const conv = storage.getAgentConversation(req.conversationId)
      const kind: AgentBackend = req.kind ?? conv?.kind ?? 'mastra'
      if (kind === 'acp') {
        const result = await acpAgentService.chat(req)
        chatConversations.set(result.requestId, req.conversationId)
        return result
      }
    }
    const result = await agentService.chat(req)
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

  // ACP 会话就绪后把绑定关系（agent 侧会话 id + 可切换的模型列表）推给渲染端：
  // 「新建的会话」要靠它把 session/new 返回的 id 落盘。
  acpAgentService.on('acp-state', (state) => ctx.broadcast('agent:acp-state', state))

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
