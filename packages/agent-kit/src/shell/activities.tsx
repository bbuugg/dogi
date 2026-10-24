/**
 * 功能区（活动栏条目）注册表。
 *
 * 一个功能区 = 活动栏里的一个图标 + 它自己的侧边栏。主区域统一由 PanelView 承载，
 * 不由功能区决定（见 `app/layout/PanelView.tsx`）。
 *
 * 新增一个功能区：写好它的侧边栏组件，再往 `BUILTIN_ACTIVITIES` 追加一项 ——
 * 活动栏图标、高亮、顺序、折叠都由 ActivityBar / Sidebar 统一处理，
 * 条目本身不用关心自己排在第几个。
 */
import { useMemo, type ComponentProps, type ComponentType } from 'react'
import { Bot, Globe, NotebookPen, Puzzle, Server } from 'lucide-react'
import { AgentSidebar } from '@fizz/agent-kit/features/chat/AgentSidebar'
import { HostsSidebar } from '@fizz/agent-kit/features/hosts/HostsSidebar'
import { ApiPanel } from '@fizz/agent-kit/features/api/ApiPanel'
import { NotesSidebar } from '@fizz/agent-kit/features/notes/NotesSidebar'
import { PluginSidebar } from '@fizz/agent-kit/features/plugins/PluginSidebar'
import { usePluginSurfaces } from '@fizz/agent-kit/shared/lib/plugin-surfaces'
import {
  AGENT_ACTIVITY_ID,
  API_CLIENT_ACTIVITY_ID,
  HOSTS_ACTIVITY_ID,
  NOTES_ACTIVITY_ID,
  pluginActivityId
} from '@fizz/agent-kit/shared/lib/activity-ids'
import { useActiveActivityId, useActivityOrder } from '@fizz/agent-kit/shared/lib/activity-state'
import { useSidebarCollapsed } from '@fizz/agent-kit/shared/lib/sidebar-collapsed'
import { useAppContext } from '@fizz/agent-kit/shared/hooks/use-app-context'
import { cn } from '@fizz/agent-kit/shared/lib/utils'
import { useLanguage } from '@fizz/agent-kit/shared/lib/language'
import { t } from '@fizz/i18n'

/**
 * 活动侧边栏面板的 props 契约。
 *
 * 取的是**最宽的那个面板**（AI Agent 侧栏）的 props —— 外壳 `Sidebar.tsx` 按它把
 * 「应用状态 + 外壳本地的动作」一次性灌给所有功能区。某个面板不需要这么多字段时，
 * 让它自己声明更窄的 props 即可：函数参数是**逆变**的，声明得比契约窄的组件照样能挂上来
 * （`{ app, width }` 这种窄签名可以赋给 `ComponentType<ActivityPanelProps>`）。
 */
export type ActivityPanelProps = ComponentProps<typeof AgentSidebar>

export interface Activity {
  /** 唯一 id，存于 `activity-state` 的 `activeActivityId` */
  id: string
  /** 活动栏悬浮提示（同时作为无障碍标签）；建议 2-4 个字 */
  label: string
  /** 活动栏图标 */
  icon: ComponentType<{ className?: string }>
  /** 侧边栏内容。`null` = 该功能区没有侧边栏（整页界面），活动栏点击不产生折叠行为 */
  sidebar: ComponentType<ActivityPanelProps> | null
}

export const BUILTIN_ACTIVITIES: Activity[] = [
  {
    id: AGENT_ACTIVITY_ID,
    label: 'AI Agent',
    icon: Bot,
    sidebar: AgentSidebar
  },
  {
    id: HOSTS_ACTIVITY_ID,
    label: '主机',
    icon: Server,
    sidebar: HostsSidebar
  },
  {
    id: API_CLIENT_ACTIVITY_ID,
    label: '接口请求',
    icon: Globe,
    sidebar: ApiPanel
  },
  {
    id: NOTES_ACTIVITY_ID,
    label: '笔记',
    icon: NotebookPen,
    sidebar: NotesSidebar
  }
]

/**
 * 解析当前功能区：id 失效（例如持久化里残留的旧 id）时回退到第一个内置功能区。
 *
 * ⚠️ 只回退「id 不认识」这一种情况。**不做**「当前功能区没有侧边栏就换一个有的」
 * 那种回退 —— 那会让界面悄悄显示出另一个功能区的内容，用户无从察觉（参考实现
 * 的 `resolvePanel` 就是这么错的）。
 */
export function resolveActivity(activities: Activity[], activeId: string): Activity {
  return activities.find((a) => a.id === activeId) ?? activities[0]
}

/**
 * 按用户拖拽出的顺序排列功能区。
 *
 * `order` 为 `null` / 空 = 从没拖过，维持默认顺序；列表里缺失的 id（比如新增的
 * 功能区）排在已排序 id 之后、彼此保持默认相对顺序（`sort` 稳定，回退值同为
 * `Infinity` 时不换位）。
 */
export function orderActivities(activities: Activity[], order: string[] | null): Activity[] {
  if (!order?.length) return activities
  const rank = new Map(order.map((id, i) => [id, i]))
  return [...activities].sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity))
}

/**
 * 当前功能区（活动栏 / 侧边栏 / 外壳共用，保证各处口径一致）。
 *
 * 顺序解析放在这里：拖拽排序对**所有**消费方一致生效（都走这个 hook 取 activities），
 * 而不是各取各的 `BUILTIN_ACTIVITIES`。
 *
 * `sidebarVisible` 把「该功能区没有侧边栏」与「用户把它折叠了」合成一个口径 ——
 * 外壳只认这一个布尔值决定侧边栏容器宽度，不必在两处各判一次。
 */
/**
 * 插件声明的图标 → 活动栏要的图标组件。
 *
 * 插件给的是 `data:image/*` 的 data URI（服务端只放行这个形状，理由见 `ctx.ui.icon`），
 * 而 `Activity.icon` 要的是一个组件 —— **绝不能**把那段字符串拼进 DOM，所以包一层 `<img>`。
 */
function activityIconOf(icon?: string): ComponentType<{ className?: string }> {
  if (!icon) return Puzzle
  return function PluginActivityIcon({ className }: { className?: string }) {
    return <img src={icon} alt="" aria-hidden className={cn('size-5 object-contain', className)} />
  }
}

/**
 * 插件声明的图标栏项 → `Activity`。
 *
 * 所有插件**共用** `PluginSidebar` 这一份侧栏（它按当前活动 id 反解是哪个插件），
 * 所以这里不需要为插件生成各自的侧栏组件 —— 加一个插件也不会动到这张表。
 */
export function pluginActivities(surfaces: ReturnType<typeof usePluginSurfaces>): Activity[] {
  return surfaces
    .filter((surface) => surface.kind === 'activityBar')
    .map((surface) => ({
      id: pluginActivityId(surface.pluginId),
      // 活动栏只显示悬浮提示，标题可能很长 —— 截一下免得 tooltip 糊成一条
      label: surface.title.slice(0, 8) || t('插件'),
      icon: activityIconOf(surface.icon),
      sidebar: PluginSidebar
    }))
}

export function useActiveActivity(): {
  activities: Activity[]
  activity: Activity
  sidebarCollapsed: boolean
  sidebarVisible: boolean
} {
  // 订阅语言：内置功能区标签用 t() 现算（模块级常量不能跟着切）
  useLanguage()
  const activeId = useActiveActivityId()
  const order = useActivityOrder()
  const sidebarCollapsed = useSidebarCollapsed()
  const { app } = useAppContext()
  const surfaces = usePluginSurfaces(app, app.activeWorkspaceId ?? undefined)
  const activities = useMemo(
    // 插件项排在内置之后：`orderActivities` 对没拖过的 id 给 Infinity（稳定排序），
    // 于是用户拖出来的内置顺序照样生效、新增的插件项自然落在后面。
    () => [
      ...orderActivities(BUILTIN_ACTIVITIES, order).map((item) => ({
        ...item,
        label: t(item.label)
      })),
      ...pluginActivities(surfaces)
    ],
    [order, surfaces]
  )
  const activity = resolveActivity(activities, activeId)
  return {
    activities,
    activity,
    sidebarCollapsed,
    // 没有侧边栏的功能区，侧边栏永远不显示（折叠开关对它无意义）
    sidebarVisible: Boolean(activity.sidebar) && !sidebarCollapsed
  }
}
