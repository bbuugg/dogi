/**
 * 全局「菜单」按钮（三个横线）+ 它弹出的菜单。
 *
 * 渲染处**只有一处**：底部状态栏左侧（`StatusBar.tsx`）。以前它是两处（展开态侧栏底部 +
 * 活动栏底缘的 `footer`），因为「侧栏一收起菜单就没入口了」；搬到状态栏之后这条顾虑消失
 * —— 状态栏整宽常驻、不随侧栏折叠或功能区切换消失，所以只留这一份。
 *
 * 菜单主体向上弹（触发器贴着视口下缘）。
 *
 * ## 项的顺序
 *
 * 命令面板 → **导入 / 导出** → 断开连接（仅 web）→ **设置**。设置压最后：它是低频入口
 * （改模型、配 token），上面几项是随手要点的，不该被一个低频项压在最上面。
 *
 * 「导入 / 导出」是一个子菜单（导出数据… / 导入数据…），对齐 dogi 的「左下角菜单」——
 * 两件事本来就是一类（同一份数据的进出），分成两个平级入口反而像两件不相干的事。
 * 对话框由本组件自己持有（`DataTransferDialog` 就在这里渲染），不用往上提到 app-shell：
 * 它只依赖 `app`，而这个组件本来就有。
 *
 * ## 这里**没有「主题」子菜单**
 *
 * 明暗 / 配色主题 / 背景图 / 强调色全都在 设置 → 外观（`AppearanceTab`）里，三端同一份入口。
 * 菜单里再留一个「主题」子菜单等于同一件事两套入口：那边有 7 套配色 + 自定义 + 背景，
 * 这边只有明暗三档，改完还会让人以为「另一处没生效」。
 *
 * 强调色属于主题本身（每套配色各带一个招牌色），这里没有也不需要单独的强调色入口。
 */
import { useState } from 'react'
import {
  ArrowRightLeft,
  Command,
  FileDown,
  FileUp,
  LogOut,
  Menu,
  Settings
} from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger
} from '@fizz/ui/dropdown-menu'
import { Button } from '@fizz/ui/button'
import { IconTip } from '@fizz/agent-kit/shared/components/IconTip'
import { useT } from '@fizz/agent-kit/shared/lib/language'
import { DataTransferDialog, type TransferMode } from '@fizz/agent-kit/features/transfer/DataTransferDialog'
import { getAgentHost } from '@fizz/agent-client/host'
import type { AgentApp } from '@fizz/agent-kit/shared/hooks/useAgentApp'

export function SidebarMenu({
  app,
  onOpenSettings,
  onOpenCommandPalette,
  className
}: {
  app: AgentApp
  onOpenSettings: () => void
  onOpenCommandPalette: () => void
  /** 按钮的尺寸 / 颜色由调用方决定（状态栏里传底栏那套紧凑类名） */
  className?: string
}) {
  const tr = useT()
  /** 导入 / 导出对话框的模式（null = 关闭）。对话框就挂在下面，不往上提到 app-shell */
  const [transfer, setTransfer] = useState<TransferMode>(null)

  return (
    <>
      <DropdownMenu>
        <IconTip label={tr('菜单')}>
          <DropdownMenuTrigger asChild>
            <Button
              size="sm"
              variant="ghost"
              className={className ?? 'size-8! p-0!'}
              aria-label={tr('菜单')}
            >
              <Menu className="size-4.5" />
            </Button>
          </DropdownMenuTrigger>
        </IconTip>
        <DropdownMenuContent side="top" align="start" sideOffset={6} className="min-w-44">
          <DropdownMenuItem onSelect={onOpenCommandPalette}>
            <Command className="size-4" />
            {tr('命令面板')}
          </DropdownMenuItem>
          {/*
            导入 / 导出：三类数据（接口请求 / 主机 / 脚本）打包带走或导回。
            子菜单而不是两个平级项 —— 它们是同一件事的两个方向。
          */}
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <ArrowRightLeft className="size-4" />
              {tr('导入 / 导出')}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-44">
              <DropdownMenuItem onSelect={() => setTransfer('export')}>
                <FileUp className="size-4" />
                {tr('导出数据…')}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setTransfer('import')}>
                <FileDown className="size-4" />
                {tr('导入数据…')}
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          {/* 断开连接是「连接型宿主」（web）才有的概念：desktop 内置后端恒在，没有可断开的东西 */}
          {getAgentHost().canDisconnect && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={app.disconnect} className="text-muted-foreground">
                <LogOut className="size-4" />
                {tr('断开连接')}
              </DropdownMenuItem>
            </>
          )}
          {/* 「设置」压最后：它是低频入口（改模型、配 token），而上面几项是随手要点的 */}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={onOpenSettings}>
            <Settings className="size-4" />
            {tr('设置')}
          </DropdownMenuItem>
        </DropdownMenuContent>
    </DropdownMenu>
      {/*
        导入 / 导出对话框。挂在菜单外面（同级）而不是塞进 DropdownMenuContent 里 ——
        它是 modal，塞进浮层菜单里会跟着菜单一起被卸载掉（菜单选完就关）。
      */}
      <DataTransferDialog app={app} mode={transfer} onClose={() => setTransfer(null)} />
    </>
  )
}
