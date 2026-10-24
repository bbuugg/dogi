/**
 * 功能区注册表 —— **安卓壳只有「AI Agent / 会话列表」这一项**。
 *
 * 与 `apps/web` / `apps/desktop` 的同名文件**故意不同**：手机屏窄，左侧那根活动栏竖条
 * 和它背后的功能区（主机 / 接口请求 / 笔记 / 插件）全部去掉，侧栏固定是会话列表
 * （`AgentSidebar`），横向空间全留给对话。所以这里只剩一项：
 *
 * - `ActivityBar` 不再渲染（见 `app-shell.tsx`），也就没有「切换功能区」这回事；
 * - 侧栏内容固定（见 `layout/Sidebar.tsx`），不看 `activeActivityId`；
 * - 持久化里可能还留着 `notes` / `hosts` 之类的旧 id（用户从 web 版带过来的偏好），
 *   这里只有一项，取不到就自然落到它 —— 不会出现「界面空白」。
 *
 * ⚠️ 别把 web 那份的 `BUILTIN_ACTIVITIES` 同步过来。三份外壳（web / desktop / mobile）
 * 本来就允许各自演化，本文件就是那条例外的落点（见 `docs/architecture/frontend-split.md`）。
 */
import { type ComponentProps, type ComponentType } from 'react'
import { Bot } from 'lucide-react'
import { AgentSidebar } from '@fizz/agent-kit/features/chat/AgentSidebar'
import { AGENT_ACTIVITY_ID } from '@fizz/agent-kit/shared/lib/activity-ids'
import { useSidebarCollapsed } from '@fizz/agent-kit/shared/lib/sidebar-collapsed'

/**
 * 活动侧边栏面板的 props 契约（取最宽的那个面板：`AgentSidebar`）。
 *
 * 手机上只有它一个面板，留着这层类型是为了 `layout/Sidebar.tsx` 的传参有据可依、
 * 以及日后真要加回第二个功能区时不用重新发明契约。
 */
export type ActivityPanelProps = ComponentProps<typeof AgentSidebar>

export interface Activity {
  /** 唯一 id，存于 `activity-state` 的 `activeActivityId` */
  id: string
  /** 悬浮提示 / 无障碍标签 */
  label: string
  /** 图标（手机版不渲染活动栏，留着是为了 `Activity` 这个形状完整） */
  icon: ComponentType<{ className?: string }>
  /** 侧边栏内容。`null` = 该功能区没有侧边栏（整页界面） */
  sidebar: ComponentType<ActivityPanelProps> | null
}

/** 手机版唯一的功能区：会话列表 */
export const BUILTIN_ACTIVITIES: Activity[] = [
  {
    id: AGENT_ACTIVITY_ID,
    label: 'AI Agent',
    icon: Bot,
    sidebar: AgentSidebar
  }
]

/**
 * 当前功能区（外壳 / 顶栏共用）。
 *
 * 固定返回唯一那一项 —— 没有「按 id 解析」这一步：手机版没有切换功能区的入口，
 * 存着的旧 id 一律无视。`sidebarVisible` 的口径与 web 版一致（没有侧栏 / 被折叠时为假），
 * 外壳只认它一个布尔值。
 */
export function useActiveActivity(): {
  activities: Activity[]
  activity: Activity
  sidebarCollapsed: boolean
  sidebarVisible: boolean
} {
  const sidebarCollapsed = useSidebarCollapsed()
  const activity = BUILTIN_ACTIVITIES[0]
  return {
    activities: BUILTIN_ACTIVITIES,
    activity,
    sidebarCollapsed,
    sidebarVisible: Boolean(activity.sidebar) && !sidebarCollapsed
  }
}
