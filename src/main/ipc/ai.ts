import { ipcMain } from 'electron'
import { aiService } from '../services/ai/ai'
import { detectInstalledAcpAgents } from '../services/ai/acp-detect'
import { sessionManager } from '../services/terminal/sessions'
import { storage } from '../services/storage'
import type { AiChatRequest, AiModelConfig, AiSettings, AiStreamEvent } from '@shared/types'
import type { IpcContext } from './shared'

/**
 * 终端 AI 助手 IPC：模型配置、助手设置、对话流与命令执行确认。
 *
 * 与「工作区 Agent」（agent.ts）是两套并列的能力：这里的助手绑定终端会话，
 * 工具是终端操作；agent.ts 绑定工作区，工具是文件与命令。
 */
export function registerAiIpc(ctx: IpcContext): void {
  // ---------- AI 模型配置 ----------
  ipcMain.handle('ai:config:list', () => storage.listAiConfigs())
  ipcMain.handle('ai:config:save', (_e, config: AiModelConfig) => storage.saveAiConfig(config))
  ipcMain.handle('ai:config:delete', (_e, id: string) => storage.deleteAiConfig(id))
  ipcMain.handle('ai:settings:get', () => storage.getAiSettings())
  ipcMain.handle('ai:settings:save', (_e, settings: Partial<AiSettings>) =>
    storage.saveAiSettings(settings)
  )
  ipcMain.handle('ai:detectAcpAgents', () => detectInstalledAcpAgents())
  // 拉取 OpenAI 兼容接口的模型列表（GET {baseURL}/models），供设置页「拉取远程模型」使用
  ipcMain.handle(
    'ai:listRemoteModels',
    async (_e, input: { baseURL: string; apiKey?: string }) => {
      const base = input.baseURL.trim().replace(/\/+$/, '')
      if (!/^https?:\/\//i.test(base)) {
        throw new Error('Base URL 需以 http(s):// 开头，如 https://api.xxx.com/v1')
      }
      const res = await fetch(`${base}/models`, {
        headers: input.apiKey ? { Authorization: `Bearer ${input.apiKey}` } : undefined
      })
      if (!res.ok) throw new Error(`拉取失败（HTTP ${res.status}）`)
      const body = (await res.json()) as unknown
      const list = Array.isArray(body) ? body : (body as { data?: unknown }).data
      const ids = (Array.isArray(list) ? list : [])
        .map((m) => (typeof m === 'string' ? m : (m as { id?: unknown }).id))
        .filter((v): v is string => typeof v === 'string' && v.length > 0)
      return [...new Set(ids)]
    }
  )

  // ---------- 对话流与中止 ----------
  ipcMain.handle('ai:chat', async (_e, req: AiChatRequest) => aiService.chat(req))
  ipcMain.handle('ai:abort', (_e, requestId: string) => aiService.abort(requestId))
  aiService.on('chat-event', (requestId: string, event: AiStreamEvent) =>
    ctx.broadcast('ai:chat-event', { requestId, event })
  )

  // ---------- 命令执行确认（确认模式） ----------
  aiService.setConfirmSink({
    request: (req) => ctx.broadcast('ai:confirm', req),
    // 确认已有结论（超时 / 中止等非用户路径），渲染端据此移除卡片
    resolved: (id) => ctx.broadcast('ai:confirm-resolved', { id })
  })
  ipcMain.handle('ai:confirm:resolve', (_e, payload: { id: string; approved: boolean }) =>
    aiService.resolveConfirm(payload.id, payload.approved)
  )
  // 会话关闭：销毁其 AI 助手实例（每个终端会话一个独立实例）
  sessionManager.on('closed', ({ sessionId }: { sessionId: string }) =>
    aiService.disposeSession(sessionId)
  )
}
