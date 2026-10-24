/**
 * 终端标签里**内嵌 AI 助手**的宽度。
 *
 * ## 为什么全局一份，不按 tab 各记（与 `lib/panel-width.ts` 相反）
 *
 * `panel-width` 按会话各记一份，是因为那边宽度与「面板开合状态」同属一个作用域
 * （`panelSessions[sessionKey]`）。内嵌助手的开合状态是 `TerminalTabView` 里的
 * 组件级 `useState`（收起即卸载，不持久化），没有这个绑定；按 tabKey 记的话，
 * localStorage 会随终端标签开开关关不断攒键，且关掉的标签那份再也读不回来。
 * 用户对「助手多宽」的预期也是一份整体的偏好：在 A 标签拖窄了，在 B 标签不该
 * 突然变回默认。
 *
 * ## 值域：`null` = 用户没拖过
 *
 * `null` 不是「宽度 0」，而是「**没记录**」→ 由 `defaultTerminalAssistantWidth`
 * 按容器宽度现场算（与 `files-pane-width.ts` 同一条理由：容器宽度是会变的 ——
 * 侧栏被拖窄、终端标签从主区挪进对话右侧的面板，都算）。
 *
 * 键名 `fizz.web.terminalAssistantWidth`（沿用 `fizz.web.*` 约定，见 AGENTS.md）。
 */
import { useSyncExternalStore } from 'react'

const KEY = 'fizz.web.terminalAssistantWidth'

/** 再窄消息就折行了：消息区与全局面板取同一个下限（app-shell 的 `min={320}`） */
export const TERMINAL_ASSISTANT_MIN_WIDTH = 320
/** 拖太宽终端就没地方站了：与 `SidePanel` 的 `MIN_CONTENT_WIDTH` 一致 */
export const TERMINAL_MIN_WIDTH = 320
/**
 * 左右分屏所需的最小容器宽：助手最小可用宽 + 终端最小宽。
 *
 * 容器窄于它时**分屏本就不成立** —— 两个 320 放不下，`max()` 兜底会把助手顶到 320、
 * 把终端压到几十 px（手机上 `375px` 只给终端剩 55px）。所以低于它时 `TerminalTabView`
 * 改成**覆盖形态**：助手盖住终端，一次只看一个（与 `SidePanel` 手机端的 overlay 同约定）。
 */
export const TERMINAL_SPLIT_MIN_WIDTH = TERMINAL_ASSISTANT_MIN_WIDTH + TERMINAL_MIN_WIDTH
/** 容器宽度还没量到时的兜底（`useContainerWidth` 首帧就是 0） */
const FALLBACK_CONTAINER_WIDTH = 900

const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) listener()
}

/** 读内嵌助手的宽度（px）；`null` = 没拖过 */
export function getTerminalAssistantWidth(): number | null {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw === null) return null
    const n = Number(raw)
    return Number.isFinite(n) && n >= TERMINAL_ASSISTANT_MIN_WIDTH ? Math.round(n) : null
  } catch {
    return null
  }
}

/** 记下宽度；非法值当「清除记录」，回到按容器算的默认值 */
export function setTerminalAssistantWidth(width: number): void {
  const next =
    Number.isFinite(width) && width >= TERMINAL_ASSISTANT_MIN_WIDTH ? Math.round(width) : null
  if (getTerminalAssistantWidth() === next) return
  try {
    // null = 清除记录（双击复位条走这条路）
    if (next === null) localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, String(next))
  } catch {
    // 存不进去也不致命：本次会话内仍然生效（与 panel-width 一致）
  }
  notify()
}

/** 清除记录，回到按容器算的默认宽度（双击拖拽条） */
export function resetTerminalAssistantWidth(): void {
  setTerminalAssistantWidth(Number.NaN)
}

/**
 * 助手宽度的**下限**：320（消息区还能读的最小宽），但容器不够时退让到容器的一半。
 *
 * 320 是给宽容器的；窄容器下它反过来会把终端挤没 —— `375px` 的手机上助手顶到 320、
 * 终端只剩 55px。分屏本身要求 640（见 `TERMINAL_SPLIT_MIN_WIDTH`），低于它
 * `TerminalTabView` 会走覆盖形态；这里的退让是给「容器刚好卡在阈值上下」与拖拽下限
 * 留的余量：一半给助手、一半给终端，谁也别把谁挤没。
 */
export function minTerminalAssistantWidth(containerWidth: number): number {
  const w = containerWidth > 0 ? containerWidth : FALLBACK_CONTAINER_WIDTH
  return Math.min(TERMINAL_ASSISTANT_MIN_WIDTH, Math.round(w / 2))
}

/**
 * 没拖过时给多宽：容器宽度的四成（约等于原来写死的 `w-96`，但跟着容器走）。
 *
 * 原来的 `w-96 max-w-[45%]` 断的是死值 384 —— 终端标签被塞进对话右侧窄面板
 * （380~600px 常见）时，384 会把终端挤到只剩几十 px。
 */
export function defaultTerminalAssistantWidth(containerWidth: number): number {
  if (containerWidth <= 0) return TERMINAL_ASSISTANT_MIN_WIDTH
  return Math.max(
    minTerminalAssistantWidth(containerWidth),
    Math.min(Math.round(containerWidth * 0.4), maxTerminalAssistantWidth(containerWidth))
  )
}

/**
 * 拖拽上限：容器宽 - 终端最小宽；容器还没量到时按 `FALLBACK_CONTAINER_WIDTH` 兜底。
 *
 * ⚠️ 两处下限都得随容器收缩，否则 `max()` 兜底会把它们顶回 320：
 * - 终端的「最小宽」不能写死 320px，得按容器封顶到四成 —— 与 `files-pane-width.ts`
 *   同一条教训：窄容器下 `容器 - 320` 会小于助手下限，上限被夹到**正好等于下限**，
 *   可拖范围退化成 0，拖起来像完全没反应；
 * - 助手的下限同理会把终端挤没（见 `minTerminalAssistantWidth`）。
 *
 * 于是 `390 → 234`、`640 → 384`、`1200 → 880`，宽容器（≥640）仍旧实打实留 320px 给终端。
 */
export function maxTerminalAssistantWidth(containerWidth: number): number {
  const w = containerWidth > 0 ? containerWidth : FALLBACK_CONTAINER_WIDTH
  const terminalMin = Math.min(TERMINAL_MIN_WIDTH, Math.round(w * 0.4))
  return Math.max(minTerminalAssistantWidth(w), w - terminalMin)
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** 组件版：内嵌助手宽度（`null` = 没拖过，按容器算默认） */
export function useTerminalAssistantWidth(): number | null {
  return useSyncExternalStore(subscribe, getTerminalAssistantWidth, () => null)
}

// 别的窗口改了 localStorage：`storage` 事件只在「别的窗口改了存储」时触发（同窗口不会）。
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === null || e.key === KEY) notify()
  })
}
