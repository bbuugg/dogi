/**
 * AI 助手面板的展开 / 收起(模块级 + 订阅)。
 *
 * 为什么不放在 `AgentApp` 里用 `useState`：开关按钮(app-shell 右下角的悬浮钮)与
 * 面板自身的「收起」按钮、面板渲染处不在同一个组件层级,和 `sidebar-collapsed.ts`
 * 同一个理由 —— 带订阅的模块变量是最小做法,顺手把状态记进 localStorage(重开保持)。
 */
import { useSyncExternalStore } from 'react'

const STORAGE_KEY = 'fizz.agent.assistantOpen'

const listeners = new Set<() => void>()
let open = readInitial()

function readInitial(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

export function getAssistantPanelOpen(): boolean {
  return open
}

export function setAssistantPanelOpen(next: boolean): void {
  if (next === open) return
  open = next
  try {
    localStorage.setItem(STORAGE_KEY, next ? '1' : '0')
  } catch {
    // 存不进去就只保留本次会话(与 sidebar-collapsed 一致)
  }
  for (const listener of listeners) listener()
}

export function toggleAssistantPanel(): void {
  setAssistantPanelOpen(!open)
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useAssistantPanelOpen(): boolean {
  return useSyncExternalStore(subscribe, getAssistantPanelOpen, () => false)
}
