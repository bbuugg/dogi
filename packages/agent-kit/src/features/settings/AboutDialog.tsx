'use client'

/**
 * 「关于」弹窗（自定义标题栏 About 菜单打开）。
 *
 * 走与设置弹窗同一套 Dialog 原语，视觉与其它弹窗一致。内容刻意保持精简：一个应用
 * 图标 + 名称 + 版本 + 一句说明。版本号的来源随宿主不同（desktop 是主进程读到的
 * `app.getVersion()`，web 没有这个概念），所以由宿主经 `version` prop 传入，这里不猜。
 */
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@fizz/ui/dialog'
import { useT } from '@fizz/agent-kit/shared/lib/language'

export function AboutDialog({
  open,
  onOpenChange,
  /** 展示用版本号；宿主没有版本概念时可省略（这时不渲染版本行） */
  version,
  /** 应用图标 URL（desktop 给 data URL）。省略则不显示图标 */
  iconUrl,
  /** 应用名（两个宿主都是 Fizz） */
  appName = 'Fizz'
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  version?: string
  iconUrl?: string
  appName?: string
}): React.ReactNode {
  const tr = useT()
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{tr('关于 {name}', { name: appName })}</DialogTitle>
          <DialogDescription className="sr-only">{tr('应用信息')}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col items-center gap-3 py-2 text-center">
          {iconUrl && <img src={iconUrl} alt="" className="size-16 rounded-2xl shadow-sm" />}
          <div className="space-y-1">
            <div className="font-heading text-lg font-medium">{appName}</div>
            {version && <div className="text-xs text-muted-foreground">{tr('版本')} {version}</div>}
          </div>
          <p className="max-w-[16rem] text-xs leading-relaxed text-muted-foreground">
            {tr('面向多工作区的 AI 编码助手：在一个窗口里管理项目、会话、终端与源代码管理。')}
          </p>
        </div>
      </DialogContent>
    </Dialog>
  )
}
