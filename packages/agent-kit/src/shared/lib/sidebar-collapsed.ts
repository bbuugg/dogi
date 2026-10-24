/**
 * 侧边栏折叠状态（模块级 + 订阅）。
 *
 * 为什么不放在 `AgentApp` 里用 `useState`：写这个值的地方（活动栏那颗当前功能区的图标、
 * 底部状态栏的「展开侧栏」）与 `AgentApp` 不在同一处渲染。用一个带订阅的模块变量是最小的
 * 做法 —— 比往上提一层 Context 省事，也不必为了传一个布尔值去改组件层级。
 *
 * 折叠态记在 localStorage，与侧边栏宽度一个待遇（重开保持）。
 *
 * ⚠️ 侧栏自己**不再渲染**「收起 / 展开」按钮（各侧栏的 `SidebarTopBar` 里说明了原因：
 * 那个动作归活动栏，手机另有遮罩）。所以这里只剩 `setSidebarCollapsed`（给定目标态）——
 * 原先还有个 `toggleSidebarCollapsed`（取反），随那批按钮一起删掉了，没有调用方。
 */
import { useSyncExternalStore } from 'react'

const STORAGE_KEY = 'fizz.agent.sidebarCollapsed'

const listeners = new Set<() => void>()
let collapsed = readInitial()

function readInitial(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

export function getSidebarCollapsed(): boolean {
  return collapsed
}

export function setSidebarCollapsed(next: boolean): void {
  if (next === collapsed) return
  collapsed = next
  try {
    localStorage.setItem(STORAGE_KEY, next ? '1' : '0')
  } catch {
    // 存不进去就只保留本次会话（与 usePersistedNumber 一致）
  }
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useSidebarCollapsed(): boolean {
  return useSyncExternalStore(subscribe, getSidebarCollapsed, () => false)
}
