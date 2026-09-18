import { resolvePanel, useActiveActivity } from '@/activities'
import { useAppStore } from '@/stores/app-store'

/** 侧边栏外壳：渲染当前功能区自己的面板（功能区没有面板时回退到有面板的功能区） */
export function Sidebar() {
  const sidebarWidth = useAppStore((s) => s.ui.sidebarWidth)
  const { activities, activity } = useActiveActivity()
  const Panel = resolvePanel(activities, activity.id)

  return (
    <aside
      className="flex h-full shrink-0 flex-col bg-sidebar"
      style={{ width: sidebarWidth }}
    >
      {Panel && <Panel />}
    </aside>
  )
}