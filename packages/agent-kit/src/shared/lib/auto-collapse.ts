/**
 * 会话消息的「自动折叠」偏好（与 `terminal-prefs.ts` 同一套模式：模块级 + 订阅）。
 *
 * 一轮跑完后，助手消息里的思考 / 工具调用要不要自动收起来。四档：
 * - `none`：都不折叠 —— 思考与工具卡都摊在消息里（思考保持展开、工具卡默认展开）；
 * - `reasoning`：只折叠思考（收进折叠条 + 结束自动收起）；工具卡摊开；
 * - `tools`：只折叠工具调用（收进折叠条 + 工具卡默认收起）；思考摊开；
 * - `all`（缺省）：都折叠，与这个开关出现之前的行为一致。
 *
 * 两处消费，判定同源（都走下面的 `autoCollapses*`）：
 * - 列表侧 `components/chat/message-parts.tsx`：哪一类 part 归进 `TurnStepGroup` 折叠条；
 * - 单卡侧 `components/PartView.tsx`：思考条 / 工具卡**自身的默认展开态**。
 *
 * 纯客户端偏好（localStorage）：阅读习惯是每个浏览器自己的事，不进服务端设置。
 * 设置页（`GeneralTab`）写、消息渲染（`MessageParts` / `PartView`）读，两边靠订阅实时同步。
 *
 * 注意范围：只影响**已跑完那一轮**的展示，以及思考条的「结束自动收起」；
 * 流式中的轮次照旧全展开（否则跑的过程中什么都看不到）。
 */
import { useSyncExternalStore } from 'react'

export type AutoCollapseMode = 'none' | 'reasoning' | 'tools' | 'all'

const AUTO_COLLAPSE_KEY = 'fizz.web.autoCollapse'

/** 缺省档：与开关出现之前的行为一致（思考 + 工具全折叠） */
const DEFAULT_MODE: AutoCollapseMode = 'all'

/** 四档的文案（设置页的选项按钮 + 选中项说明共用） */
export const AUTO_COLLAPSE_OPTIONS: ReadonlyArray<{
  value: AutoCollapseMode
  label: string
  hint: string
}> = [
  { value: 'none', label: '不折叠', hint: '思考与工具卡都展开。' },
  { value: 'reasoning', label: '折叠思考', hint: '只折叠思考。' },
  { value: 'tools', label: '折叠工具', hint: '只折叠工具卡。' },
  { value: 'all', label: '全部折叠', hint: '思考与工具卡都折叠（默认）。' }
]

const listeners = new Set<() => void>()

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** 读偏好；没存过 / 存坏了（老数据、手改的 localStorage）一律当缺省档 */
export function getAutoCollapse(): AutoCollapseMode {
  try {
    const raw = localStorage.getItem(AUTO_COLLAPSE_KEY)
    return AUTO_COLLAPSE_OPTIONS.some((option) => option.value === raw)
      ? (raw as AutoCollapseMode)
      : DEFAULT_MODE
  } catch {
    return DEFAULT_MODE
  }
}

export function setAutoCollapse(mode: AutoCollapseMode): void {
  try {
    if (mode === DEFAULT_MODE) localStorage.removeItem(AUTO_COLLAPSE_KEY)
    else localStorage.setItem(AUTO_COLLAPSE_KEY, mode)
  } catch {
    // 存不进去也不致命：本次会话内仍然生效
  }
  for (const listener of listeners) listener()
}

// 别的窗口改了 localStorage：`storage` 事件只在「别的窗口改了存储」时触发（同窗口不会）
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (!e.key || e.key === AUTO_COLLAPSE_KEY) for (const listener of listeners) listener()
  })
}

/** 订阅「自动折叠」偏好（服务端快照 = 缺省档，与客户端首帧一致，不会 hydration 打架） */
export function useAutoCollapse(): AutoCollapseMode {
  return useSyncExternalStore(subscribe, getAutoCollapse, () => DEFAULT_MODE)
}

/** 思考要不要「自动折叠」（结束流式后自动收起 + 收进折叠条） */
export function autoCollapsesReasoning(mode: AutoCollapseMode): boolean {
  return mode === 'reasoning' || mode === 'all'
}

/** 工具调用要不要「自动折叠」（收进折叠条） */
export function autoCollapsesTools(mode: AutoCollapseMode): boolean {
  return mode === 'tools' || mode === 'all'
}
