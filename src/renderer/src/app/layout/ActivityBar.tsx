import { useRef } from 'react'
import { Button, Tooltip } from 'antd'
import { useActiveActivity } from '@/app/activities'
import { useAppStore } from '@/stores/app-store'
import { cn } from 'cn'

/**
 * 左侧活动栏（类 VS Code）：竖条图标 = 功能区 tab，点击即切换，**拖拽可重排**。
 *
 * 条目来自 activities.tsx 的功能区注册表，新增功能区不用改这里；
 * 高亮、侧边栏折叠、主区域内容都由 ui.activeActivity 派生，没有第二份视图状态。
 * 点击「当前已激活」的功能区 = 折叠/展开它自己的侧边栏（没有侧边栏的功能区无此行为）。
 *
 * 拖拽用原生 HTML5 DnD（不值得为 5 个图标引入 dnd-kit）：dragstart 记住被拖的 id，
 * drop 时把插入目标位置的完整顺序写入 ui.activityOrder，排序由 activities.tsx 统一生效。
 */
export function ActivityBar() {
  const { activities, activity, sidebarCollapsed } = useActiveActivity()
  const selectActivity = useAppStore((s) => s.selectActivity)
  const setSidebarCollapsed = useAppStore((s) => s.setSidebarCollapsed)
  const setActivityOrder = useAppStore((s) => s.setActivityOrder)
  const currentId = activity.id
  /** 正在被拖拽的功能区 id（drop 时未必还能从 dataTransfer 读到，记一份在内存里） */
  const dragIdRef = useRef<string | null>(null)

  /** 拖到目标图标上：把被拖项插入目标位置，写入完整 id 顺序 */
  const reorder = (dragId: string, targetId: string): void => {
    if (dragId === targetId) return
    const ids = activities.map((a) => a.id)
    const from = ids.indexOf(dragId)
    const to = ids.indexOf(targetId)
    if (from < 0 || to < 0) return
    ids.splice(to, 0, ids.splice(from, 1)[0])
    setActivityOrder(ids)
  }

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
          <Tooltip key={a.id} title={a.label} placement="right">
            <Button
              type="text"
              aria-label={a.label}
              aria-pressed={active}
              draggable
              onDragStart={(e) => {
                dragIdRef.current = a.id
                e.dataTransfer.effectAllowed = 'move'
                // Firefox 需要 setData 才会进入拖拽；读取方以 dragIdRef 为准
                e.dataTransfer.setData('text/plain', a.id)
              }}
              onDragOver={(e) => {
                e.preventDefault()
                e.dataTransfer.dropEffect = 'move'
              }}
              onDragEnd={() => {
                dragIdRef.current = null
              }}
              onDrop={(e) => {
                e.preventDefault()
                const dragId = dragIdRef.current || e.dataTransfer.getData('text/plain')
                dragIdRef.current = null
                if (dragId) reorder(dragId, a.id)
              }}
              icon={<Icon className="size-4" />}
              className={cn(
                'size-9 cursor-grab text-muted-foreground hover:text-foreground active:cursor-grabbing',
                // 激活态用主题色底色区分（antd 的 text 按钮自身会铺背景，需提高优先级压过它）
                active && '!bg-primary/15 text-foreground hover:!bg-primary/20'
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
        )
      })}
    </nav>
  )
}