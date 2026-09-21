import {
  PLUGINS_ACTIVITY_ID,
  SCRIPTS_ACTIVITY_ID
} from '@/activity-ids'
import { useAppStore } from '@/stores/app-store'
import { Button, Popover } from 'antd'
import { Boxes, Command as CommandIcon, ListPlus, Menu, Plus, Settings } from 'lucide-react'
import { useState, type ReactNode } from 'react'

/** 状态栏条目统一样式（外部传入的节点也用它，保证与内置条目一致） */
export const STATUS_ITEM_CLASS =
  'flex h-full items-center gap-1.5 rounded px-1.5 text-xs whitespace-nowrap text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground'

/**
 * 应用底部功能条（类 VS Code 状态栏）：左侧是全局菜单，右侧是外部注入的区域。
 *
 * 自身只放「全局菜单」这一项，其余内容都由外部传入：
 * - `children`：追加在左侧（菜单之后），如服务器指标条；
 * - `right`：右侧区域（原「命令面板」按钮的位置），如编辑页保存状态、终端打开时的 AI 助手开关。
 * 终端连接状态已内联到终端标签页中展示，不再占用状态栏。
 */
export function StatusBar({ children, right }: { children?: ReactNode; right?: ReactNode }) {
  return (
    <footer className="flex h-8 shrink-0 items-center gap-0.5 bg-sidebar px-1">
      <MenuButton />

      {/* 左侧追加项（如服务器指标条） */}
      {children}

      {/* 右侧区域：由外部按当前上下文注入（无内容时不留白） */}
      <div className="ml-auto flex items-center gap-0.5">{right}</div>
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
    'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm whitespace-nowrap transition-colors hover:bg-secondary'
  const hint = 'ml-auto pl-3 text-sm text-muted-foreground'
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
        <div className="flex w-54 flex-col gap-0.5">
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
      <Button
        type="text" title="菜单"
        icon={<Menu className="size-4" />}
        className={STATUS_ITEM_CLASS}
      />
    </Popover>
  )
}
