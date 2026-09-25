/**
 * 工作区快捷功能入口：顶栏右侧的一个下拉按钮（与终端 / 打开那些按钮排在一起），
 * 菜单里是 `<工作区>/.dogi/workspace.json` 配好的快捷功能，点一下执行
 * （打开链接 / 跑命令 / 打开路径），最后一项进管理弹窗做增删改。
 *
 * 没有配置时下拉里只有一条「添加快捷功能…」，入口本身不占额外空间 ——
 * 刻意不做成独立的一栏，避免顶栏多出一条常驻空白。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, Dropdown, Tooltip, message } from 'antd'
import type { MenuProps } from 'antd'
import { Settings2, Zap } from 'lucide-react'
import { useAppStore } from '@/stores/app-store'
import { QuickActionsDialog } from '@/features/agent/QuickActionsDialog'
import { QUICK_ACTION_ICONS, runQuickAction } from '@/features/agent/quick-action'
import type { AgentWorkspace } from '@shared/types'

/** 管理项的固定 key（快捷功能的 key 是 action.id，不会撞上） */
const MANAGE_KEY = '__manage__'

export function WorkspaceQuickActions({
  workspace,
  onRunCommand
}: {
  workspace: AgentWorkspace
  /** 在工作区目录的内嵌终端里执行命令（由 AgentPage 提供） */
  onRunCommand: (command: string) => Promise<void>
}) {
  const snapshot = useAppStore((s) => s.workspaceConfigs[workspace.id])
  const loadWorkspaceConfig = useAppStore((s) => s.loadWorkspaceConfig)
  const [manageOpen, setManageOpen] = useState(false)
  /** 执行中标记：挡住连续点击（菜单点完就收，不需要再给按钮做过场动画） */
  const runningRef = useRef(false)

  const actions = snapshot?.config.quickActions ?? []

  // 按工作区懒加载（store 里有缓存就直接用）；切换工作区时会重新取
  useEffect(() => {
    void loadWorkspaceConfig(workspace.id)
  }, [workspace.id, loadWorkspaceConfig])

  const run = useCallback(
    async (id: string) => {
      if (runningRef.current) return
      const action = actions.find((a) => a.id === id)
      if (!action) return
      runningRef.current = true
      try {
        const error = await runQuickAction(action, {
          workspacePath: workspace.path,
          runCommand: onRunCommand
        })
        // 成功不提示：浏览器 / 终端 / 资源管理器本身就是反馈
        if (error) message.error(`「${action.label}」执行失败：${error}`)
      } finally {
        runningRef.current = false
      }
    },
    [actions, workspace.path, onRunCommand]
  )

  // Dropdown 菜单里的 divider 是支持的（antd 6 只有 Select options 不再支持 type:'divider'）
  const menuItems: MenuProps['items'] = [
    ...actions.map((action) => {
      const Icon = QUICK_ACTION_ICONS[action.kind]
      return {
        key: action.id,
        icon: <Icon className="size-3.5" />,
        label: action.label
      }
    }),
    ...(actions.length > 0 ? [{ type: 'divider' as const }] : []),
    {
      key: MANAGE_KEY,
      icon: <Settings2 className="size-3.5" />,
      label: actions.length > 0 ? '管理快捷功能…' : '添加快捷功能…'
    }
  ]

  const handleClick: MenuProps['onClick'] = ({ key, domEvent }) => {
    domEvent.stopPropagation()
    if (key === MANAGE_KEY) {
      setManageOpen(true)
      return
    }
    void run(key)
  }

  return (
    <>
      <Tooltip title="快捷功能">
        <Dropdown
          trigger={['click']}
          placement="bottomRight"
          menu={{ items: menuItems, onClick: handleClick, style: { minWidth: 180 } }}
        >
          <Button
            type="text"
            className="px-1.5 text-muted-foreground"
            icon={<Zap className="size-4" />}
            aria-label="快捷功能"
          />
        </Dropdown>
      </Tooltip>
      <QuickActionsDialog
        workspaceId={workspace.id}
        open={manageOpen}
        onClose={() => setManageOpen(false)}
      />
    </>
  )
}
