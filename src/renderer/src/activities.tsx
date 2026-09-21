import type { ComponentType } from 'react'
import { Bot, FileCode2, Globe, Puzzle, Server, StickyNote } from 'lucide-react'
import { AgentPanel } from '@/components/AgentPanel'
import { ApiPanel } from '@/components/ApiPanel'
import { HostsPanel } from '@/components/HostsPanel'
import { NotesPanel } from '@/components/NotesPanel'
import { PluginsPanel } from '@/components/PluginsPanel'
import { ScriptsPanel } from '@/components/ScriptsPanel'
import { useAppStore } from '@/stores/app-store'
import {
  AGENT_ACTIVITY_ID,
  API_ACTIVITY_ID,
  HOSTS_ACTIVITY_ID,
  NOTES_ACTIVITY_ID,
  PLUGINS_ACTIVITY_ID,
  SCRIPTS_ACTIVITY_ID
} from '@/activity-ids'

/**
 * 功能区（活动栏条目）= 一个 tab。
 *
 * 新增一个功能区：在 components/ 下写好界面，再往 BUILTIN_ACTIVITIES 追加一项。
 * 活动栏图标、高亮、侧边栏折叠都由 ActivityBar / Sidebar 统一处理，
 * 条目本身不用关心自己排在第几个。
 *
 * 每个功能区都有 sidebar panel；右侧主区域统一由 PanelView 承载，不再由 activity 决定。
 *
 * 插件不再贡献功能区：安装的插件不会往活动栏挂条目，插件视图只在 PanelView 里
 * 以标签页形式打开（入口在插件管理面板的「打开」按钮）。
 */
export interface Activity {
  /** 唯一 id，存于 ui.activeActivity */
  id: string
  /** 活动栏悬浮提示（同时作为无障碍标签）；建议 2-4 个字 */
  label: string
  /** 活动栏图标 */
  icon: ComponentType<{ className?: string }>
  /** 侧边面板 */
  panel: ComponentType
}

export const BUILTIN_ACTIVITIES: Activity[] = [
  {
    id: AGENT_ACTIVITY_ID,
    label: 'AI Agent',
    icon: Bot,
    panel: AgentPanel
  },
  {
    id: HOSTS_ACTIVITY_ID,
    label: '主机',
    icon: Server,
    panel: HostsPanel
  },
  {
    id: SCRIPTS_ACTIVITY_ID,
    label: '脚本管理',
    icon: FileCode2,
    panel: ScriptsPanel
  },
  {
    id: NOTES_ACTIVITY_ID,
    label: '笔记',
    icon: StickyNote,
    panel: NotesPanel
  },
  {
    id: API_ACTIVITY_ID,
    label: '接口请求',
    icon: Globe,
    panel: ApiPanel
  },
  {
    id: PLUGINS_ACTIVITY_ID,
    label: '插件管理',
    icon: Puzzle,
    panel: PluginsPanel
  }
]

/** 解析当前功能区：id 失效（例如残留的旧插件功能区 id）时回退到第一个内置功能区 */
export function resolveActivity(activities: Activity[], activeId: string): Activity {
  return activities.find((a) => a.id === activeId) ?? activities[0]
}

/** 侧边栏面板：当前功能区没有面板时回退到第一个有面板的功能区，避免展开时空白 */
export function resolvePanel(
  activities: Activity[],
  activeId: string
): ComponentType | undefined {
  const current = activities.find((a) => a.id === activeId)
  return current?.panel ?? activities.find((a) => a.panel)?.panel
}

/**
 * 当前功能区与它自己的侧边栏状态（App / TitleBar / ActivityBar / Sidebar 共用，
 * 保证各处口径一致）。
 */
export function useActiveActivity(): {
  activities: Activity[]
  activity: Activity
  sidebarCollapsed: boolean
  sidebarVisible: boolean
} {
  const activeId = useAppStore((s) => s.ui.activeActivity)
  const collapsedActivities = useAppStore((s) => s.ui.collapsedActivities)
  const activities = BUILTIN_ACTIVITIES
  const activity = resolveActivity(activities, activeId)
  const sidebarCollapsed = Boolean(collapsedActivities[activity.id])
  return {
    activities,
    activity,
    sidebarCollapsed,
    // 没有侧边栏的功能区，侧边栏永远不显示
    sidebarVisible: Boolean(activity.panel) && !sidebarCollapsed
  }
}
