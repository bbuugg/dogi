/**
 * 右侧面板的宽度：**按 scope 各记一份**（scope = 会话 key，容器工作台传固定串）。
 *
 * ## 为什么要有这个模块（而不是每个面板自己 `usePersistedNumber` 一个 key）
 *
 * 面板的「开合 / 正看哪个标签」本来就是**按会话**记的（`hooks/use-app-context.tsx` 的
 * `panelSessions[sessionKey]`），而宽度却曾经是**全局一份** localStorage key。作用域
 * 不一致带来两个看得见的故障：
 *
 * 1. 在 A 里把面板拖窄，切到 B 也变窄 —— B 从来没被拖过；
 * 2. 切会话时面板宽度**先撑到上限、再弹回原来的宽度**。第二条的来由：旧实现里
 *    「撑满」是个组件级 state，而撑满规则是「每次展开都撑满」，切会话时被误判成
 *    「用户刚展开」而重放了一遍。
 *
 * 现在宽度与开合同属一个作用域：切会话读到的是**这个会话自己的**宽度，形状不变，
 * 所以不跳。
 *
 * ## 值域：`null` = 用户没拖过
 *
 * `null` 不是「宽度 0」，而是「**没记录**」—— 展开时按容器比例给（默认一半，见 `SidePanel`
 * 里 `flowWidth` 的算法）。用 `null` 而不是 0 是因为 0 在 px 语义上是合法宽度，
 * 与「没拖过」混在一起会让持久化分不清。
 *
 * 键名 `fizz.web.panelWidth.<scope>`（沿用 `fizz.web.*` 约定，见 AGENTS.md）。
 */
import { useSyncExternalStore } from 'react'

const KEY_PREFIX = 'fizz.web.panelWidth.'

/** 用户为这个 scope 拖出来的宽度（px）；`null` = 没拖过 */
export type PanelWidth = number | null

/** scope → 宽度。缓存住是为了让 `getPanelWidth` 每次返回**同一个值**（useSyncExternalStore 要求） */
const cache = new Map<string, PanelWidth>()
const listeners = new Set<() => void>()

function readStored(scope: string): PanelWidth {
  try {
    const raw = localStorage.getItem(KEY_PREFIX + scope)
    const n = raw === null ? NaN : Number(raw)
    return Number.isFinite(n) && n > 0 ? n : null
  } catch {
    return null
  }
}

/** 读某个 scope 的宽度（没拖过 = `null`） */
export function getPanelWidth(scope: string): PanelWidth {
  if (!cache.has(scope)) cache.set(scope, readStored(scope))
  return cache.get(scope) ?? null
}

/** 记下某个 scope 的宽度（拖拽时调用）；非法值当「清除记录」，回到撑满 */
export function setPanelWidth(scope: string, width: number): void {
  const next: PanelWidth = Number.isFinite(width) && width > 0 ? Math.round(width) : null
  if (getPanelWidth(scope) === next) return
  cache.set(scope, next)
  try {
    if (next === null) localStorage.removeItem(KEY_PREFIX + scope)
    else localStorage.setItem(KEY_PREFIX + scope, String(next))
  } catch {
    // 存不进去也不致命：本次会话内仍然生效（与 usePersistedNumber 一致）
  }
  for (const listener of listeners) listener()
}

/**
 * 清掉已不在 `keep` 里的 scope 的宽度记录。
 *
 * 会话被删掉时调用（见 `use-app-context.tsx` 的面板回收 effect），免得 localStorage 里
 * 越攒越多、也免得「删掉的会话 id 又被复用」时莫名继承一份旧宽度。
 *
 * ⚠️ 调用方**必须等会话列表真的加载完**再清：加载前 id 清单是空的，那会把所有会话的
 * 宽度一次性误删（这条约束写在这里，因为踩它的人不会先读调用点）。
 */
export function prunePanelWidths(keep: Iterable<string>): void {
  const kept = new Set(keep)
  let changed = false
  try {
    // 用标准的 Storage 迭代（`length` + `key(i)`）而不是 `Object.keys(localStorage)`：
    // 后者依赖「存储项就是对象自有属性」这个实现细节，垫片 / 某些环境上枚举出来的是别的东西。
    // 倒着删：删掉一个键会让后面的下标整体前移。
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i)
      if (key === null || !key.startsWith(KEY_PREFIX)) continue
      const scope = key.slice(KEY_PREFIX.length)
      if (kept.has(scope)) continue
      localStorage.removeItem(key)
      cache.delete(scope)
      changed = true
    }
  } catch {
    // localStorage 不可用：宽度本来就只在内存缓存里，删不动就算了
    return
  }
  if (changed) for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** 组件版：订阅某个 scope 的宽度（切 scope 就是换一份记录，各自独立） */
export function usePanelWidth(scope: string): PanelWidth {
  return useSyncExternalStore(
    subscribe,
    () => getPanelWidth(scope),
    () => null
  )
}

// 别的窗口改了 localStorage：`storage` 事件只在「别的窗口改了存储」时触发（同窗口不会）。
// 与 `lib/terminal-prefs.ts` 同一套：缓存作废、重读，避免两个标签页各记一份宽度。
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key !== null && !e.key.startsWith(KEY_PREFIX)) return
    cache.clear()
    for (const listener of listeners) listener()
  })
}