/**
 * 文件面板左侧「文件列表面板」（文件树）的宽度。
 *
 * ## 为什么全局一份，不按 scope 分（与 `lib/panel-width.ts` 相反）
 *
 * `panel-width` 按会话各记一份，是因为右侧面板的宽度和它的**开合状态**同一作用域
 * （见那个文件头的说明）。这里拖的是「同一块面板内部两个区域之间的那条线」，没有这种绑定；
 * 而按会话 / 工作区记的话，localStorage 会随着会话与工作区增删不断攒键（那边有
 * `prunePanelWidths` 回收，这边没有，多半就是一堆再也读不到的垃圾）。
 *
 * ## 值域：`null` = 用户没拖过
 *
 * `null` 不是「宽度 0」，而是「**没记录**」→ 由 `defaultFilesPaneWidth` 按容器宽度现场算。
 * 这样面板变窄（侧栏被拖窄、手机横竖屏）时默认宽度会跟着走，而不是留着一个算出来的死值。
 *
 * 键名 `fizz.web.filesPaneWidth`（沿用 `fizz.web.*` 约定，见 AGENTS.md）。
 */
import { useSyncExternalStore } from 'react'

const KEY = 'fizz.web.filesPaneWidth'

/** 再窄文件名就只剩省略号了 */
export const FILES_PANE_MIN_WIDTH = 140
/** 拖太宽，右侧编辑器就没地方站了 */
export const FILES_PANE_EDITOR_MIN_WIDTH = 280

/**
 * 容器窄于这个宽度就不再并排两栏，改为「一次一屏」的单栏形态（上下钻）。
 *
 * 值是**推出来的**，不是随手取的：两栏各自的最小宽度之和 —— 文件树 `FILES_PANE_MIN_WIDTH`
 * （140）+ 编辑器 `FILES_PANE_EDITOR_MIN_WIDTH`（280）—— 就是并排的硬临界。中间的
 * `ResizeHandle` 用负 margin 扩抓取热区、**不占布局宽度**（见它的文件头），所以这个和是
 * 实打实的：容器再窄，两栏必然有一边跌破自己的最小值，两边同时只剩省略号。
 * 写成表达式而不是 420 —— 那两个最小值改了，阈值自动跟着走。
 *
 * 判据用的是**容器**宽度（`useContainerWidth` 量的面板自身宽度），不是视口 —— 面板本身
 * 可以被拖得很窄（侧栏 / 流程节点里 380px 的工作台），那时即使在宽屏上，一次一屏也比
 * 「两栏各一半、两边都在省略号里挣扎」好用。
 */
export const FILES_SINGLE_PANE_BELOW_WIDTH =
  FILES_PANE_MIN_WIDTH + FILES_PANE_EDITOR_MIN_WIDTH
/** 没拖过时在宽容器下的取值（上限） */
const FILES_PANE_DEFAULT_MAX = 240
/** 容器宽度还没量到时的兜底（`useContainerWidth` 首帧就是 0） */
const FALLBACK_CONTAINER_WIDTH = 640

const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) listener()
}

/** 读文件列表面板的宽度（px）；`null` = 没拖过 */
export function getFilesPaneWidth(): number | null {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw === null) return null
    const n = Number(raw)
    return Number.isFinite(n) && n >= FILES_PANE_MIN_WIDTH ? Math.round(n) : null
  } catch {
    return null
  }
}

/** 记下宽度；非法值当「清除记录」，回到按容器算的默认值 */
export function setFilesPaneWidth(width: number): void {
  const next = Number.isFinite(width) && width >= FILES_PANE_MIN_WIDTH ? Math.round(width) : null
  if (getFilesPaneWidth() === next) return
  try {
    // null = 清除记录（双击复位条走这条路）
    if (next === null) localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, String(next))
  } catch {
    // 存不进去也不致命：本次会话内仍然生效（与 panel-width 一致）
  }
  notify()
}

/**
 * 没拖过时给多宽：容器够宽就 240px（沿用原来 `md:w-60` 的观感），
 * 容器窄（侧栏里常见 380~600px）就占四成，别把编辑区挤没了。
 *
 * 原来的 `w-1/2 md:w-60` 断的是**视口**宽度，不是容器宽度 —— 桌面宽屏上把侧栏拖到 380px，
 * 文件树照样吃掉 240px、编辑区只剩 140px，所以这里改成按容器实测算。
 */
export function defaultFilesPaneWidth(containerWidth: number): number {
  if (containerWidth <= 0) return FILES_PANE_DEFAULT_MAX
  return Math.max(FILES_PANE_MIN_WIDTH, Math.min(FILES_PANE_DEFAULT_MAX, Math.round(containerWidth * 0.4)))
}

/**
 * 拖拽上限：容器宽 - 编辑区最小宽；容器还没量到时按 `FALLBACK_CONTAINER_WIDTH` 兜底。
 *
 * ⚠️ 编辑区的「最小宽」不能写死 `FILES_PANE_EDITOR_MIN_WIDTH`（280px）：手机上侧栏是**覆盖形态**，
 * 容器宽度就等于内容区宽度（`SidePanel` 的 `overlayWidth = containerWidth`），一台 390px 的手机于是
 * `390 - 280 = 110 < 下限 140` → 上限被夹到**正好等于下限**，可拖范围退化成 0，拖起来像完全没反应。
 * （这正是「手机上用不了」的第二个原因，与 ResizeHandle 缺 touch-action 那个叠在一起。）
 *
 * 所以编辑区最小宽按容器封顶到四成：宽容器仍旧实打实留 280px；窄容器则允许文件树占大头 ——
 * 390px → 上限 234（可拖 140~234）；640px → 384；1200px → 920，与改动前一致。
 */
export function maxFilesPaneWidth(containerWidth: number): number {
  const w = containerWidth > 0 ? containerWidth : FALLBACK_CONTAINER_WIDTH
  const editorMin = Math.min(FILES_PANE_EDITOR_MIN_WIDTH, Math.round(w * 0.4))
  return Math.max(FILES_PANE_MIN_WIDTH, w - editorMin)
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** 组件版：文件列表面板宽度（`null` = 没拖过，按容器算默认） */
export function useFilesPaneWidth(): number | null {
  return useSyncExternalStore(subscribe, getFilesPaneWidth, () => null)
}

// 别的窗口改了 localStorage：`storage` 事件只在「别的窗口改了存储」时触发（同窗口不会）。
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === null || e.key === KEY) notify()
  })
}