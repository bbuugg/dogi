/**
 * 侧栏「分区」的状态：只剩用户**拖出来的高度**。
 *
 * 折叠态**已移除**（分区现在是一行静态标签，见 `StackedSections` 的文件头），
 * 所以这里不再有 `collapsed` 记录 —— 留着它只会让「分区还能收起」这个错觉继续存在。
 * 老版本写进 localStorage 的 `fizz.agent.sectionCollapsed` 直接无视（不读、不清，
 * 免得为一条死数据加迁移代码）。
 *
 * 与 `sidebar-collapsed.ts` 同一套路（模块级变量 + 订阅 + localStorage），不放进
 * `AgentApp` 的 Context：分区头在很深的子树里（面板 → 分区 → 头），而状态要被
 * 同一面板里的多个分区共享，还要跨面板重挂载保住 —— 提 Context 得穿过四五层
 * 无关键，不如一个带订阅的模块变量。
 *
 * ## key 的约定
 *
 * key 是分区的**稳定 id**（见 `shared/lib/section-ids.ts`），不是组件实例：
 * 所以「收起状态栏后重挂载」「切功能区再切回来」都不会丢。**id 必须全局唯一**，
 * 否则两个面板的同名分区会互相串高度。
 *
 * ## 为什么高度要单独存
 *
 * 分区默认按 `grow` 权重瓜分剩余空间（见 StackedSections）；只有用户**真的拖过**
 * 那条分隔条之后，才改成一个固定像素高度 —— 没拖过就按权重走，窗口大小变化时
 * 跟着自适应，这是更好的默认行为。
 */
import { useSyncExternalStore } from 'react'

const HEIGHTS_KEY = 'fizz.agent.sectionHeights'

/**
 * 一个分区的「身份证」。
 *
 * 现在只有 `id` 一个字段：它既是拖拽高度的 key，也是「这是哪个分区」的唯一标识。
 * 曾经还带 `defaultCollapsed`（默认收起），折叠移除后一并删掉 —— 一个没人读的
 * 默认值留在类型里，只会让人以为分区还能收起。
 *
 * 定义放在 `shared/lib/section-ids.ts`（用 `import type` 引这里的类型 —— 纯类型引用
 * 会被擦除，那边仍然是「不 import 任何运行时代码」的叶子模块，不会形成循环依赖）。
 */
export interface SectionSpec {
  /** 分区稳定 id（全局唯一，见 `shared/lib/section-ids.ts`） */
  id: string
}

interface SectionState {
  /** 分区 id → 用户拖出来的高度（px）；缺省 = 还没拖过，按 flex 权重分配 */
  heights: Record<string, number>
}

const listeners = new Set<() => void>()

/** 当前状态。整体替换（不是就地改），让订阅者拿到的一定是新对象 */
let state: SectionState = readInitial()

function readRecord<T>(key: string): Record<string, T> {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, T>)
      : {}
  } catch {
    // 存不进去 / 存坏了都按「没有」处理（与 sidebar-collapsed 一致，不让脏数据炸界面）
    return {}
  }
}

function readInitial(): SectionState {
  return { heights: readRecord<number>(HEIGHTS_KEY) }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // 只保留本次会话
  }
}

function commit(next: SectionState): void {
  state = next
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** 用户拖出来的高度（undefined = 还没拖过，按权重自动分配） */
export function useSectionHeight(id: string | undefined): number | undefined {
  return useSyncExternalStore(
    subscribe,
    () => (id ? state.heights[id] : undefined),
    () => undefined
  )
}

/**
 * 高度落盘**防抖**：拖动分隔条时 `setSectionHeight` 每帧都调，逐帧
 * `JSON.stringify` + `localStorage.setItem` 会明显掉帧。内存里立刻生效（界面跟手），
 * 落盘等停手。
 */
let heightFlushTimer: ReturnType<typeof setTimeout> | null = null

export function setSectionHeight(id: string, px: number): void {
  if (state.heights[id] === px) return
  commit({ ...state, heights: { ...state.heights, [id]: px } })
  if (heightFlushTimer) clearTimeout(heightFlushTimer)
  heightFlushTimer = setTimeout(() => {
    heightFlushTimer = null
    write(HEIGHTS_KEY, state.heights)
  }, 250)
}
