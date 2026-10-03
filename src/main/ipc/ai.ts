import { ipcMain } from 'electron'
import { storage } from '../services/storage'
import type { AiModelConfig, AiSettings } from '@shared/types'

/**
 * AI 模型配置与设置 IPC（两条 AI 线共用：设置页的模型配置、权限模式、超时等）。
 *
 * 对话流已经统一到 `agent:chat`（见 ipc/agent.ts）——终端 AI 助手与工作区 Agent
 * 走同一组通道（`agent:chat` / `agent:chat-event` / `agent:confirm`）。
 * 这里只剩模型配置的 CRUD 与设置读写，不再有任何对话状态。
 */
export function registerAiIpc(): void {
  // ---------- AI 模型配置 ----------
  ipcMain.handle('ai:config:list', () => storage.listAiConfigs())
  ipcMain.handle('ai:config:save', (_e, config: AiModelConfig) => storage.saveAiConfig(config))
  ipcMain.handle('ai:config:delete', (_e, id: string) => storage.deleteAiConfig(id))
  ipcMain.handle('ai:settings:get', () => storage.getAiSettings())
  ipcMain.handle('ai:settings:save', (_e, settings: Partial<AiSettings>) =>
    storage.saveAiSettings(settings)
  )
  // 拉取 OpenAI 兼容接口的模型列表（GET {baseURL}/models），供设置页「拉取远程模型」使用。
  // configId：编辑已有配置时表单里的 apiKey 是空的（脱敏不回显），按它取存储的解密 key，
  // 否则「保存后编辑再拉取」就会变成无鉴权请求而失败。
  ipcMain.handle(
    'ai:listRemoteModels',
    async (_e, input: { baseURL: string; apiKey?: string; configId?: string }) => {
      const base = input.baseURL.trim().replace(/\/+$/, '')
      if (!/^https?:\/\//i.test(base)) {
        throw new Error('Base URL 需以 http(s):// 开头，如 https://api.xxx.com/v1')
      }
      const apiKey =
        input.apiKey ?? (input.configId ? storage.getAiConfig(input.configId)?.apiKey : undefined)
      const res = await fetch(`${base}/models`, {
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined
      })
      if (!res.ok) throw new Error(`拉取失败（HTTP ${res.status}）`)
      const body = (await res.json()) as unknown
      const list = Array.isArray(body) ? body : (body as { data?: unknown }).data
      const ids = (Array.isArray(list) ? list : [])
        .map((m) => (typeof m === 'string' ? (m as { id?: unknown }).id : undefined))
        .filter((v): v is string => typeof v === 'string' && v.length > 0)
      return [...new Set(ids)]
    }
  )
}
