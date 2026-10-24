/**
 * 设置模块的**共享形状**：分组 / 导航项 / 宿主扩展项 / 各壳的公共入参。
 *
 * 这里只放数据形状，不放任何导航形态 —— 桌面两栏、手机两级各自是独立组件
 * （`DesktopSettingsPanel` / `MobileSettingsPanel`），靠这份形状拼出来。
 */
import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import type { AgentApp } from '@fizz/agent-kit/shared/hooks/useAgentApp'
import type { AgentShortcutConfig } from '@fizz/agent-kit/shared/lib/shortcuts'

/** 内置设置项（内容在 `SettingsContent` 里按 id 渲染） */
export type SettingsTabId =
  | 'general'
  | 'appearance'
  | 'shortcuts'
  | 'terminal'
  | 'history'
  | 'container'
  | 'ai-prefs'
  | 'models'
  | 'acp'
  | 'mcp'
  | 'skills'
  | 'plugins'
  | 'usage'

/**
 * 导航项：内置项与宿主扩展项合并后的形状。
 * `id` 是 string（扩展分组的 id 由宿主任意定，不进 `SettingsTabId` 联合）。
 */
export interface SettingsNavItem {
  id: string
  label: string
  icon: LucideIcon
  /** 点一下就地执行，不切内容页（如手机版底部的「退出」） */
  action?: () => void
  /** 危险动作（如「退出」）用红色，别和普通设置项混在一起 */
  tone?: 'destructive'
}

export interface SettingsNavGroup {
  /** 不传 = 不画分组标题（单项的宿主入口，如手机版底部的「退出」） */
  title?: string
  items: SettingsNavItem[]
}

/**
 * 宿主扩展项：手机版用它把「数据 / 退出」这类**宿主级入口**收进设置导航
 * （入口在设置里的都该长这样，别在旁边另起炉灶）。
 *
 * `content` 与 `action` 二选一：
 * - `content` = 进内容页（设置项）；
 * - `action` = 点一下就地执行，不切页（「退出」这种一次性动作不该多一层）。
 */
export interface SettingsExtraItem {
  id: string
  label: string
  icon: LucideIcon
  /** 点这一项直接执行（不切内容页）；给了它就不需要 `content` */
  action?: () => void
  /** 选中时的内容（`action` 项不需要）；样式要跟其它 Tab 同款（`space-y-6` 根 + `space-y-2` 分节） */
  content?: ReactNode
  tone?: 'destructive'
}

export interface SettingsExtraGroup {
  title?: string
  items: SettingsExtraItem[]
}

/** 各壳都需要的入参：设置数据 + 快捷键读写（快捷键由宿主持有与分发） */
export interface SettingsCommonProps {
  app: AgentApp
  shortcuts: AgentShortcutConfig[]
  onSaveShortcuts: (shortcuts: AgentShortcutConfig[]) => void
  onShortcutRecordingChange: (recording: boolean) => void
}
