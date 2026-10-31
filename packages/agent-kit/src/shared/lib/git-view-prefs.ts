/**
 * git 面板的「视图偏好」本地持久化（与 `terminal-prefs.ts` 同一套模式）。
 *
 * 目前只有一项：「更改 / 已暂存的更改」按目录树展示还是平铺。默认树状（目录里动过的文件
 * 一眼能看出层级），存成平铺的人点面板头部那个树/列表图标即可切回去。
 */
import { useSyncExternalStore } from 'react'
import { writePref } from '@fizz/agent-kit/shared/lib/prefs-sync'

/** 树状视图：存了 `'0'` 才用平铺，其余（没存过 / 存坏了）都当树状 */
const TREE_VIEW_KEY = 'fizz.web.gitTreeView'

const listeners = new Set<() => void>()

/** 读视图偏好；SSR / 无 localStorage 时返回 true（= 树状，与默认值一致） */
export function getGitTreeView(): boolean {
  try {
    return localStorage.getItem(TREE_VIEW_KEY) !== '0'
  } catch {
    return true
  }
}

/** 设置视图偏好（写盘即广播 + 同步到服务端，见 prefs-sync） */
export function setGitTreeView(enabled: boolean): void {
  writePref(TREE_VIEW_KEY, enabled ? '1' : '0')
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
    if (!e.key || e.key === TREE_VIEW_KEY) for (const listener of listeners) listener()
  })
}

/** 订阅「树状视图」偏好 */
export function useGitTreeView(): boolean {
  // 服务端快照 = 默认值（树状），与客户端首帧一致，不会 hydration 打架
  return useSyncExternalStore(subscribe, getGitTreeView, () => true)
}
