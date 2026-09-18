import { Button, Tooltip } from 'antd'
import { useActiveActivity } from '@/activities'
import { useAppStore } from '@/stores/app-store'
import { cn } from 'cn'

/**
 * 左侧活动栏（类 VS Code）：竖条图标 = 功能区 tab，点击即切换。
 *
 * 条目来自 activities.tsx 的功能区注册表，新增功能区不用改这里；
 * 高亮、侧边栏折叠、主区域内容都由 ui.activeActivity 派生，没有第二份视图状态。
 * 点击「当前已激活」的功能区 = 折叠/展开它自己的侧边栏（没有侧边栏的功能区无此行为）。
 */
export function ActivityBar() {
  const { activities, activity, sidebarCollapsed } = useActiveActivity()
  const selectActivity = useAppStore((s) => s.selectActivity)
  const setSidebarCollapsed = useAppStore((s) => s.setSidebarCollapsed)
  const currentId = activity.id

  return (
    <nav
      className="flex w-12 shrink-0 flex-col items-center gap-1 bg-sidebar py-2"
      aria-label="功能区"
    >
      {activities.map((a) => {
        const Icon = a.icon
        // 没有面板的功能区（整页界面）不显示侧边栏，始终算激活
        const active = a.id === currentId && (a.panel ? !sidebarCollapsed : true)
        return (
          // 相对定位的包裹层用于放激活指示器（按钮本身由 antd 渲染，不便再加子元素）
          <div key={a.id} className="relative">
            <Tooltip title={a.label} placement="right">
              <Button
                type="text"
                aria-label={a.label}
                aria-pressed={active}
                icon={<Icon className="size-4" />}
                className={cn(
                  'size-9 text-muted-foreground hover:text-foreground',
                  active && 'bg-sidebar-accent text-foreground'
                )}
                onClick={() => {
                  if (a.id === currentId && a.panel) {
                    setSidebarCollapsed(!sidebarCollapsed)
                    return
                  }
                  selectActivity(a.id)
                }}
              />
            </Tooltip>
            {active && (
              <span className="pointer-events-none absolute inset-x-0 bottom-0 mx-auto h-0.5 w-4 rounded-full bg-primary" />
            )}
          </div>
        )
      })}
    </nav>
  )
}