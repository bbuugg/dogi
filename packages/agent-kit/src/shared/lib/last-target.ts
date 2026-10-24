/**
 * 「上次使用的模型」：最近一次**发送消息**时用的目标（backend + configId + modelId）。
 *
 * 只落 localStorage（客户端偏好，与主题 / 权限档同一套约定）：每个浏览器记住自己的
 * 习惯，刷新 / 重开都在，跨设备不共享。**新会话**（空白页）预选时用它 ——
 * 校验不过（配置 / agent 被删、模型下架）就什么都不选，界面显示「选择模型」。
 *
 * 已打开的会话记的是它自己的模型（`<项目>/.fizz/conversation/<会话 id>/config.json`），
 * 与这里互不影响。
 */
import type { AgentBackend } from '@fizz/contracts/types'

const LAST_TARGET_KEY = 'fizz.web.lastTarget'

export interface LastTarget {
  backend: AgentBackend
  configId: string
  modelId?: string
}

/** 读上次使用的目标；没存过 / 存坏了 / 字段不全 → null（调用方回退现有逻辑） */
export function loadLastTarget(): LastTarget | null {
  try {
    const raw = localStorage.getItem(LAST_TARGET_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as LastTarget | null
    if (!parsed || typeof parsed.configId !== 'string' || !parsed.configId) return null
    if (parsed.backend !== 'mastra' && parsed.backend !== 'acp') return null
    return parsed
  } catch {
    return null
  }
}

export function saveLastTarget(target: LastTarget): void {
  try {
    localStorage.setItem(LAST_TARGET_KEY, JSON.stringify(target))
  } catch {
    // 只是一个预选偏好，存不了就算了
  }
}
