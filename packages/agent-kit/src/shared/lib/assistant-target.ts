/**
 * AI 助手的模型偏好(客户端偏好,直接落 localStorage —— 与主题 / 权限档同一条约定)。
 *
 * 助手是跨项目的轻量对话,模型选择做成**全局偏好**而不是按会话记:切换助手会话
 * 不换模型,要换就全局换。只覆盖内置 Agent agent(助手不接 ACP)。
 */

export interface AssistantTarget {
  /** 模型配置 id(domain.listModels() 的一项) */
  configId: string
  /** 配置下的模型 id(`AiModelConfig.models` 里某一项的 `id`) */
  modelId: string
}

const STORAGE_KEY = 'fizz.agent.assistantTarget'

export function loadAssistantTarget(): AssistantTarget | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as AssistantTarget | null
    if (!parsed?.configId || !parsed?.modelId) return null
    return parsed
  } catch {
    return null
  }
}

export function saveAssistantTarget(target: AssistantTarget | null): void {
  try {
    if (!target) localStorage.removeItem(STORAGE_KEY)
    else localStorage.setItem(STORAGE_KEY, JSON.stringify(target))
  } catch {
    // 存不进去就只保留本次会话(与其他客户端偏好一致)
  }
}
