import { useState, type ReactNode } from 'react'
import { Boxes, Command as CommandIcon, ListPlus, Menu, Plus, Settings } from 'lucide-react'
import { cn } from 'cn'
import { Popover } from 'antd'
import { useAppStore } from '@/stores/app-store'
import {
  HOSTS_ACTIVITY_ID,
  PLUGINS_ACTIVITY_ID,
  SCRIPTS_ACTIVITY_ID
} from '@/activity-ids'

const ITEM_CLASS =
  'flex h-6 items-center gap-1.5 rounded px-1.5 text-[11px] whitespace-nowrap text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground'

/**
 * 应用底部功能条（类 VS Code 状态栏）：
 * 左侧是全局菜单 + 当前会话状态，右侧是常用入口。
 * 通用容器：接收 children 直接渲染，追加在原有功能项之后、右侧入口之前。
 */
export function StatusBar({ children }: { children?: ReactNode }) {
  const sessions = useAppStore((s) => s.sessions)
  const activeSessionId = useAppStore((s) => s.activeSessionId)
  const exitedSessions = useAppStore((s) => s.exitedSessions)
  const selectActivity = useAppStore((s) => s.selectActivity)
  const setCommandPaletteOpen = useAppStore((s) => s.setCommandPaletteOpen)

  const session = sessions.find((s) => s.id === activeSessionId) ?? null
  const exited = activeSessionId ? exitedSessions.has(activeSessionId) : false

  return (
    <footer className="flex h-7 shrink-0 items-center gap-0.5 bg-sidebar px-1">
      <MenuButton />

      {session ? (
        <button
          type="button"
          title={session.title}
          onClick={() => selectActivity(HOSTS_ACTIVITY_ID)}
          className={ITEM_CLASS}
        >
          <span
            className={cn(
              'size-1.5 shrink-0 rounded-full',
              exited ? 'bg-destructive' : 'bg-emerald-500'
            )}
          />
          <span className="max-w-[220px] truncate">{session.title}</span>
          {sessions.length > 1 && (
            <span className="text-muted-foreground/70">· {sessions.length} 个终端</span>
          )}
        </button>
      ) : (
        <span className="px-1.5 text-[11px] text-muted-foreground/70">没有打开的终端</span>
      )}

      {/* 追加的功能项（如服务器指标条）直接渲染在原有功能后面 */}
      {children}

      <div className="ml-auto flex items-center gap-0.5">
        <button
          type="button"
          title="命令面板"
          onClick={() => setCommandPaletteOpen(true)}
          className={ITEM_CLASS}
        >
          <CommandIcon className="size-3.5" />
          命令面板
          <span className="text-muted-foreground/70">Ctrl+Shift+P</span>
        </button>
      </div>
    </footer>
  )
}

/** 左下角全局菜单：命令面板等入口（后续功能从这里继续加） */
function MenuButton() {
  const setCommandPaletteOpen = useAppStore((s) => s.setCommandPaletteOpen)
  const selectActivity = useAppStore((s) => s.selectActivity)
  const setSshDialog = useAppStore((s) => s.setSshDialog)
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen)
  const [open, setOpen] = useState(false)

  const menuItem =
    'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs whitespace-nowrap transition-colors hover:bg-secondary'
  const hint = 'ml-auto pl-3 text-[10px] text-muted-foreground'
  /** 执行后关闭菜单 */
  const run = (fn: () => void) => () => {
    setOpen(false)
    fn()
  }

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      trigger="click"
      placement="topLeft"
      arrow={false}
      destroyOnHidden
      styles={{ container: { padding: 0 }, content: { padding: 4 } }}
      content={
        <div className="flex w-46 flex-col gap-0.5">
          <button
            type="button"
            className={menuItem}
            onClick={run(() => setCommandPaletteOpen(true))}
          >
            <CommandIcon className="size-3.5 text-muted-foreground" /> 命令面板
            <span className={hint}>Ctrl+Shift+P</span>
          </button>
          <button type="button" className={menuItem} onClick={run(() => selectActivity(SCRIPTS_ACTIVITY_ID))}>
            <ListPlus className="size-3.5 text-muted-foreground" /> 管理脚本
          </button>
          <button type="button" className={menuItem} onClick={run(() => selectActivity(PLUGINS_ACTIVITY_ID))}>
            <Boxes className="size-3.5 text-muted-foreground" /> 插件管理
          </button>
          <button
            type="button"
            className={menuItem}
            onClick={run(() => setSshDialog(true, null))}
          >
            <Plus className="size-3.5 text-muted-foreground" /> 添加主机
          </button>
          <button type="button" className={menuItem} onClick={run(() => setSettingsOpen(true))}>
            <Settings className="size-3.5 text-muted-foreground" /> 设置
            <span className={hint}>Ctrl+Alt+S</span>
          </button>
        </div>
      }
    >
      <button type="button" title="菜单" className={cn(ITEM_CLASS, 'px-1')}>
        <Menu className="size-4" />
      </button>
    </Popover>
  )
}
