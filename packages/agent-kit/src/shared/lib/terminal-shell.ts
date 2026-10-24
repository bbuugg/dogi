/**
 * 「默认终端（shell）」的本地持久化 + 响应式订阅。
 *
 * 存的是 `ShellProfile.id`（如 `pwsh` / `wsl` / `gitbash`），**不是命令路径** ——
 * id 认不出来时宿主会回落到平台默认，所以用户把某个 shell 卸掉之后存下的旧 id
 * 只会让他回到默认终端，不会把终端卡在「找不到程序」上。
 *
 * 全局一份（不按工作区 / 不按会话）：这是「我用哪个终端」的偏好 ——
 * 工具条的「终端」主按钮用它；弹层里选的 shell 只作用于当前会话，不改这里。
 *
 * 做成「模块级 + 订阅」（同 `sidebar-collapsed`）而不是某处的 useState：
 * desktop 的设置是**独立窗口**（另一份渲染进程），在那边改了默认终端，主窗口要跟着变 ——
 * `storage` 事件 + 订阅正好把「同窗口」与「跨窗口」两条路都覆盖掉。
 */
import { useSyncExternalStore } from 'react'

const STORAGE_KEY = 'fizz.agent.terminalShell'

const listeners = new Set<() => void>()

/** 读取默认终端 shell id；没存过 / 存坏了都返回 null（= 跟随平台默认） */
export function getTerminalShell(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY) || null
  } catch {
    return null
  }
}

/** 设置默认终端（null = 跟随平台默认） */
export function setTerminalShell(id: string | null): void {
  try {
    if (id) localStorage.setItem(STORAGE_KEY, id)
    else localStorage.removeItem(STORAGE_KEY)
  } catch {
    // 存不进去也不致命：本次会话内仍然生效
  }
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

// 别的窗口改了 localStorage：`storage` 事件只在「别的窗口改了存储」时触发（同窗口不会）
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (!e.key || e.key === STORAGE_KEY) for (const listener of listeners) listener()
  })
}

/** 订阅默认终端（返回 null = 跟随平台默认） */
export function useTerminalShell(): string | null {
  return useSyncExternalStore(subscribe, getTerminalShell, () => null)
}
