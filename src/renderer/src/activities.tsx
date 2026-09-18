import { useMemo } from 'react'
import type { ComponentType } from 'react'
import { FileCode2, Puzzle, Server, StickyNote } from 'lucide-react'
import { HostsPanel } from '@/components/HostsPanel'
import { NotesPanel } from '@/components/NotesPanel'
import { useAppStore } from '@/stores/app-store'
import {
  HOSTS_ACTIVITY_ID,
  NOTES_ACTIVITY_ID,
  PLUGINS_ACTIVITY_ID,
  SCRIPTS_ACTIVITY_ID,
  pluginActivityId
} from '@/activity-ids'

/** 主区域内容标识（活动栏是唯一导航真源，主区域显示什么由当前功能区决定） */
export type ActivityView = 'terminal' | 'scripts' | 'plugin' | 'plugins' | 'notes'

/**
 * 功能区（活动栏条目）= 一个 tab。
 *
 * 新增一个功能区：在 components/ 下写好界面，再往 BUILTIN_ACTIVITIES 追加一项。
 * 活动栏图标、高亮、侧边栏折叠、主区域切换都由 ActivityBar / Sidebar / App 统一处理，
 * 条目本身不用关心自己排在第几个。
 *
 * 侧边栏属于功能区：有 panel 的功能区才有侧边栏，没有的（整页界面）切换时不会
 * 动别人的侧边栏状态。
 */
export interface Activity {
  /** 唯一 id，存于 ui.activeActivity */
  id: string
  /** 活动栏悬浮提示（同时作为无障碍标签）；建议 2-4 个字 */
  label: string
  /** 活动栏图标 */
  icon: ComponentType<{ className?: string }>
  /** 侧边面板：省略表示该功能区没有侧边栏 */
  panel?: ComponentType
  /** 该功能区在主区域显示的内容 */
  view: ActivityView
}

export const BUILTIN_ACTIVITIES: Activity[] = [
  {
    id: HOSTS_ACTIVITY_ID,
    label: '主机',
    icon: Server,
    panel: HostsPanel,
    view: 'terminal'
  },
  {
    id: SCRIPTS_ACTIVITY_ID,
    label: '脚本管理',
    icon: FileCode2,
    view: 'scripts'
  },
  {
    id: NOTES_ACTIVITY_ID,
    label: '笔记',
    icon: StickyNote,
    panel: NotesPanel,
    view: 'notes'
  },
  {
    id: PLUGINS_ACTIVITY_ID,
    label: '插件管理',
    icon: Puzzle,
    view: 'plugins'
  }
]

/** 插件贡献的功能区所需的最小信息（plugin view 子集） */
interface PluginActivitySource {
  viewId: string
  name: string
  icon?: string
}

/** 内置功能区 + 插件贡献的功能区（插件可装卸，所以是运行时算出来的） */
export function resolveActivities(plugins: PluginActivitySource[]): Activity[] {
  return [
    ...BUILTIN_ACTIVITIES,
    ...plugins.map((p) => {
      // 插件图标是 emoji 字符串，包一层组件以适配 Activity.icon 的组件签名
      const EmojiIcon = (): React.ReactElement => (
        <span className="text-[13px] leading-4">{p.icon ?? '🔌'}</span>
      )
      return {
        id: pluginActivityId(p.viewId),
        label: p.name,
        icon: EmojiIcon,
        view: 'plugin' as const
      }
    })
  ]
}

/** 解析当前功能区：id 失效（插件被卸载等）时回退到第一个内置功能区 */
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
  const plugins = useAppStore((s) => s.plugins)
  const activeId = useAppStore((s) => s.ui.activeActivity)
  const collapsedActivities = useAppStore((s) => s.ui.collapsedActivities)
  const activities = useMemo(() => resolveActivities(plugins), [plugins])
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