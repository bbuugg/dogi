/**
 * 底部状态栏（类 VS Code / 对齐上级目录 dogi 的 `StatusBar`）：整宽一条 `h-8`，
 * 左侧是全局入口，右侧按当前上下文注入内容。
 *
 * ## 为什么把全局入口从活动栏挪到这里
 *
 * 以前「菜单」挂在活动栏底缘（`ActivityBar` 的 footer）。活动栏是**竖条**，横向只有 40px 宽，
 * 底缘那颗按钮既挤又和功能区图标混在同一列；而底部状态栏是**整宽**的常驻横条，天然适合放
 * 「全局、低频、与当前功能区无关」的入口。
 *
 * Global controls stay first, followed by injected `left` status, a flexible spacer,
 * focused-tab `right` status, and persistent `actions` at the far right. Injected nodes
 * own their visibility and use `STATUS_ITEM_CLASS` (`@/shared/lib/status-bar`) to
 * keep item height, text, and hover styling consistent.
 *
 * ## 手机形态
 *
 * 手机也渲染这条状态栏（`h-9`）。手机上这里**只有**最左那颗全局菜单：侧栏抽屉的入口在顶部
 * `WebTitleBar` 左侧那颗按钮，且竖条（活动栏）恒可见 —— 手机上**不再支持藏竖条**。
 *
 * ## 这里没有「展开 / 收起侧栏」
 *
 * 侧栏的收放**只有活动栏那一个入口**：点**当前**功能区的那颗图标即折叠 / 展开（手机上是
 * 开关抽屉，见 `ActivityBar` 的 `onClick`）。状态栏曾经还挂着一颗「展开侧栏」，那是活动栏
 * 底缘那颗按钮搬过来时的遗留 —— 同一个动作出现两个位置，点了活动栏图标的人还会以为
 * 「点了没反应，得去状态栏再点一次」。统一到一个入口后移除。
 */
import type { ReactNode } from 'react'
import { SidebarMenu } from './SidebarMenu'
import type { AgentApp } from '@fizz/agent-kit/shared/hooks/useAgentApp'

export function StatusBar({
  app,
  onOpenSettings,
  onOpenCommandPalette,
  left,
  right,
  actions
}: {
  app: AgentApp
  onOpenSettings: () => void
  onOpenCommandPalette: () => void
  /** Global/local status after the built-in controls; nodes own visibility and STATUS_ITEM_CLASS. */
  left?: ReactNode
  /** Status for the focused panel tab after the spacer; nodes return null when inapplicable. */
  right?: ReactNode
  /** Persistent global actions at the far right, independent of the focused tab. */
  actions?: ReactNode
}) {
  return (
    <footer className="flex h-9 shrink-0 items-center gap-0.5 px-2 py-1">
      {/* 全局菜单：位置恒定在最左 */}
      <SidebarMenu
        app={app}
        onOpenSettings={onOpenSettings}
        onOpenCommandPalette={onOpenCommandPalette}
        className="size-7! p-0! text-muted-foreground hover:text-foreground"
      />

      {left}
      <div className="flex-1" />
      {right}
      {actions}
    </footer>
  )
}