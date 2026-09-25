import { PLUGINS_ACTIVITY_ID } from '@/app/activity-ids'
import { useAppStore } from '@/stores/app-store'
import { Button, Dropdown, type MenuProps } from 'antd'
import {
  ArrowRightLeft,
  Boxes,
  Command as CommandIcon,
  FileDown,
  FileUp,
  ListPlus,
  Menu,
  Plus,
  Settings
} from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { DataTransferDialog, type TransferMode } from './DataTransferDialog'

/** 状态栏条目统一样式（外部传入的节点也用它，保证与内置条目一致） */
export const STATUS_ITEM_CLASS =
  'flex h-full items-center gap-1.5 rounded px-1.5 text-xs whitespace-nowrap text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground'

/**
 * 应用底部功能条（类 VS Code 状态栏）：左侧是全局菜单，右侧是外部注入的区域。
 *
 * 自身只放「全局菜单」这一项，其余内容全部由外部按当前上下文注入 `right`：
 * 编辑页保存状态、系统监控条、终端 AI 助手开关、SFTP 传输任务入口等
 * （各项自己判断该不该出现，没有内容时右侧不留白）。
 * 终端连接状态已内联到终端标签页中展示，不再占用状态栏。
 */
export function StatusBar({ right }: { right?: ReactNode }) {
  /** 导入 / 导出对话框的模式（null = 关闭） */
  const [transfer, setTransfer] = useState<TransferMode>(null)

  return (
    <footer className="flex h-8 shrink-0 items-center gap-0.5 bg-sidebar px-1">
      <MenuButton onTransfer={setTransfer} />

      {/* 右侧区域：由外部按当前上下文注入（无内容时不留白） */}
      <div className="ml-auto flex items-center gap-0.5">{right}</div>

      <DataTransferDialog mode={transfer} onClose={() => setTransfer(null)} />
    </footer>
  )
}

/**
 * 左下角全局菜单：命令面板、管理脚本、插件、添加主机、导入 / 导出（二级菜单）、设置。
 *
 * 用 antd `Dropdown` 而不是自绘 Popover：「导入 / 导出」需要**二级菜单**，
 * Dropdown 的 menu 支持 `children` 直接展开成浮层子菜单，不用自己管悬停与定位。
 */
function MenuButton({ onTransfer }: { onTransfer: (mode: TransferMode) => void }) {
  const setCommandPaletteOpen = useAppStore((s) => s.setCommandPaletteOpen)
  const selectActivity = useAppStore((s) => s.selectActivity)
  const openScriptsSection = useAppStore((s) => s.openScriptsSection)
  const setSshDialog = useAppStore((s) => s.setSshDialog)
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen)
  const [open, setOpen] = useState(false)

  const hint = 'ml-auto pl-3 text-xs text-muted-foreground'
  const icon = 'size-3.5 text-muted-foreground'
  /** 执行后关闭菜单 */
  const run = (fn: () => void) => () => {
    setOpen(false)
    fn()
  }

  const items: MenuProps['items'] = [
    {
      key: 'command-palette',
      icon: <CommandIcon className={icon} />,
      label: (
        <span className="flex w-full items-center gap-2">
          命令面板
          <span className={hint}>Ctrl+Shift+P</span>
        </span>
      )
    },
    { key: 'manage-scripts', icon: <ListPlus className={icon} />, label: '管理脚本' },
    { key: 'plugins', icon: <Boxes className={icon} />, label: '插件管理' },
    { key: 'add-host', icon: <Plus className={icon} />, label: '添加主机' },
    { type: 'divider' },
    {
      key: 'transfer',
      icon: <ArrowRightLeft className={icon} />,
      label: '导入 / 导出',
      children: [
        { key: 'export', icon: <FileUp className={icon} />, label: '导出数据…' },
        { key: 'import', icon: <FileDown className={icon} />, label: '导入数据…' }
      ]
    },
    { type: 'divider' },
    {
      key: 'settings',
      icon: <Settings className={icon} />,
      label: (
        <span className="flex w-full items-center gap-2">
          设置
          <span className={hint}>Ctrl+Alt+S</span>
        </span>
      )
    }
  ]

  const onClick: MenuProps['onClick'] = ({ key }) => {
    // 子菜单项自己开对话框：Dropdown 受控打开，得手动收起菜单
    if (key === 'export' || key === 'import') {
      setOpen(false)
      onTransfer(key)
      return
    }
    if (key === 'command-palette') run(() => setCommandPaletteOpen(true))()
    else if (key === 'manage-scripts') run(openScriptsSection)()
    else if (key === 'plugins') run(() => selectActivity(PLUGINS_ACTIVITY_ID))()
    else if (key === 'add-host') run(() => setSshDialog(true, null))()
    else if (key === 'settings') run(() => setSettingsOpen(true))()
  }

  return (
    <Dropdown
      open={open}
      onOpenChange={setOpen}
      trigger={['click']}
      placement="topLeft"
      /*
       * 对齐用的类名**必须挂在 Dropdown 上**，不能写进 `menu`：
       * antd 渲染 Dropdown 的菜单时是 `{...menu, classNames: {...}}`（dropdown.js），
       * 写在 menu 里的 classNames 会被整块覆盖掉。
       * - root → 浮层容器（一级菜单的祖先）
       * - item / itemTitle / itemContent → 条目、子菜单标题与文案区；
       *   Dropdown 会把同一份再塞进 `subMenu`，所以二级菜单也覆盖到。
       */
      classNames={{
        root: 'status-menu',
        item: 'status-menu-item',
        itemTitle: 'status-menu-item',
        itemContent: 'status-menu-content'
      }}
      menu={{ items, onClick, style: { minWidth: 216 } }}
    >
      <Button
        type="text"
        title="菜单"
        icon={<Menu className="size-4" />}
        className={STATUS_ITEM_CLASS}
      />
    </Dropdown>
  )
}
