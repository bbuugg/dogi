/**
 * 终端**悬浮球**的动作槽：外层（终端标签）把自己想挂的入口交给终端。
 *
 * 从前这里是「右上角操作区的额外节点」（`terminal-header-slot`）：命令历史 + AI 助手
 * 并排挂在终端右上角，会占掉终端顶部一块、也容易被当成标题栏。现在终端自己渲染一颗
 * 可拖动的悬浮球，入口由外层通过这个 context 提供，终端统一排进点击展开的圆环里
 * —— 加多少入口都不会重叠，外层也不必自己绝对定位。
 *
 * 不提供时取到空数组（容器工作台、侧栏终端等调用方）：圆环里只剩终端自己的动作；
 * 一个动作都没有就连球都不渲染（见 `TerminalFab`）。
 */
import { createContext, useContext, type ReactNode } from 'react'

/** 圆环里的一项 */
export interface TerminalAction {
  /** 稳定标识（round 的 key） */
  key: string
  /** 名字：圆环项的 tooltip 与 aria-label */
  label: string
  icon: ReactNode
  onClick: () => void
  /** 对应的浮层正开着（命令历史）：圆环里高亮那一颗 */
  active?: boolean
}

const TerminalActionsContext = createContext<TerminalAction[]>([])

export const TerminalActionsProvider = TerminalActionsContext.Provider

/** 读外层挂进悬浮球的动作（没有就是空数组） */
export function useTerminalActions(): TerminalAction[] {
  return useContext(TerminalActionsContext)
}
