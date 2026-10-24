/**
 * 活动栏的**偏好**状态：当前激活的功能区 + 图标顺序。
 *
 * 与 `lib/sidebar-collapsed.ts` 同款做法（模块级 + `useSyncExternalStore`）：
 * 活动栏、侧边栏、外壳分处不同的渲染位置，却要读写同一份值，用带订阅的模块变量
 * 是最小的做法 —— 不必为了两个字符串往上提一层 Context。
 *
 * ⚠️ 只持久化**偏好**（激活项 / 顺序）。真正的**布局树**（标签分组、分裂）是运行时
 * 状态，不落盘：它是「这一次拖出来的样子」，重启后应当回到干净的初始布局。
 */
import { useSyncExternalStore } from 'react'
import { AGENT_ACTIVITY_ID } from '@fizz/agent-kit/shared/lib/activity-ids'

const ACTIVE_KEY = 'fizz.agent.activeActivity'
const ORDER_KEY = 'fizz.agent.activityOrder'
const OVERFLOW_KEY = 'fizz.agent.activityOverflow'

const listeners = new Set<() => void>()

function readString(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) ?? fallback
  } catch {
    return fallback
  }
}

let activeActivityId = readString(ACTIVE_KEY, AGENT_ACTIVITY_ID)

/**
 * 用户拖出来的功能区顺序（完整 id 列表）。
 *
 * `null` = 从没拖过，维持注册表里的默认顺序。解析时列表里缺失的 id（比如以后新增的
 * 功能区）排在已排序 id 之后、彼此保持默认相对顺序（sort 稳定，回退值同为 Infinity
 * 时不换位）。整块存成一个 JSON 数组，避免「每项一个 key」这种碎片化存储。
 */
let activityOrder: string[] | null = readOrder()

function readOrder(): string[] | null {
  try {
    const raw = localStorage.getItem(ORDER_KEY)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return null
    const ids = parsed.filter((x): x is string => typeof x === 'string')
    return ids.length ? ids : null
  } catch {
    return null
  }
}

/**
 * 「收进「更多」」的功能区 id。
 *
 * 与顺序是**两件事**：顺序决定图标在主栏里的先后，这份决定**在不在主栏里**。
 * 收起来的项仍可以被激活（从「更多」弹层里点），所以它不是「隐藏 / 禁用」。
 *
 * ⚠️ 与 `activityOrder` 同一条纪律：**引用必须稳定**（`useSyncExternalStore` 每次
 * `getSnapshot` 拿到新数组会无限重渲染），所以只在写入时替换引用，读出来是同一份。
 */
let activityOverflow: string[] = readOverflow()

function readOverflow(): string[] {
  try {
    const raw = localStorage.getItem(OVERFLOW_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((x): x is string => typeof x === 'string')
  } catch {
    return []
  }
}

function emit(): void {
  for (const listener of listeners) listener()
}

export function getActiveActivityId(): string {
  return activeActivityId
}

export function setActiveActivityId(id: string): void {
  if (id === activeActivityId) return
  activeActivityId = id
  try {
    localStorage.setItem(ACTIVE_KEY, id)
  } catch {
    // 存不进去就只保留本次会话（与 usePersistedNumber 一致）
  }
  emit()
}

export function getActivityOrder(): string[] | null {
  return activityOrder
}

export function setActivityOrder(ids: string[]): void {
  activityOrder = ids.length ? ids : null
  try {
    if (activityOrder) localStorage.setItem(ORDER_KEY, JSON.stringify(activityOrder))
    else localStorage.removeItem(ORDER_KEY)
  } catch {
    // 存不进去就只保留本次会话
  }
  emit()
}

/** 收在「更多」里的 id（引用稳定，见上面的说明） */
export function getActivityOverflow(): string[] {
  return activityOverflow
}

export function setActivityOverflow(ids: string[]): void {
  activityOverflow = ids
  try {
    if (ids.length) localStorage.setItem(OVERFLOW_KEY, JSON.stringify(ids))
    else localStorage.removeItem(OVERFLOW_KEY)
  } catch {
    // 存不进去就只保留本次会话
  }
  emit()
}

/** 把一个功能区收进「更多」（顺序不动，只是不在主栏里出现） */
export function moveActivityToOverflow(id: string): void {
  if (activityOverflow.includes(id)) return
  setActivityOverflow([...activityOverflow, id])
}

/** 把一个功能区移回主栏（它在顺序里的位置不受影响） */
export function moveActivityOutOfOverflow(id: string): void {
  if (!activityOverflow.includes(id)) return
  setActivityOverflow(activityOverflow.filter((x) => x !== id))
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useActiveActivityId(): string {
  return useSyncExternalStore(subscribe, getActiveActivityId, () => AGENT_ACTIVITY_ID)
}

/**
 * ⚠️ 返回的是**数组引用**（`activityOrder`），必须保证「没变就不换引用」，
 * 否则 `useSyncExternalStore` 每次 `getSnapshot` 都拿到新数组会无限重渲染。
 * 这里直接返回模块里那份引用（只在 `setActivityOrder` 时才替换），满足要求。
 */
export function useActivityOrder(): string[] | null {
  return useSyncExternalStore(subscribe, getActivityOrder, () => null)
}

/** ⚠️ 服务端快照也必须是**同一个**空数组引用（每次新建会让客户端与它永远不一致） */
const EMPTY_IDS: string[] = []

export function useActivityOverflow(): string[] {
  return useSyncExternalStore(subscribe, getActivityOverflow, () => EMPTY_IDS)
}
