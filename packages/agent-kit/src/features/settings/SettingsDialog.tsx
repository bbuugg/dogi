/**
 * 设置弹窗（web 的应用内弹窗）。
 *
 * 内容本体是**两套互不干扰的导航壳**，按视口挑一个 —— 不是让一个组件内部到处断点：
 * - 宽屏 → `DesktopSettingsPanel`：左菜单常驻 + 右内容，两栏同时在场；
 * - 窄屏（手机浏览器）→ `MobileSettingsPanel`：菜单 / 详情两级。弹窗里没地方放宿主
 *   标题栏，二级页的返回行由面板自绘。
 *
 * 选择发生在**壳的边界**（这里换组件），两个面板内部都没有 `max-md:` / `useIsMobile()`
 * 分支 —— 各自只写自己那种形态，改一边不会牵动另一边。
 */
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@fizz/ui/dialog'
import { useIsMobile } from '@fizz/agent-kit/shared/hooks/useIsMobile'
import type { AgentApp } from '@fizz/agent-kit/shared/hooks/useAgentApp'
import type { AgentShortcutConfig } from '@fizz/agent-kit/shared/lib/shortcuts'
import { DesktopSettingsPanel } from '@fizz/agent-kit/features/settings/DesktopSettingsPanel'
import { MobileSettingsPanel } from '@fizz/agent-kit/features/settings/MobileSettingsPanel'
import { useT } from '@fizz/agent-kit/shared/lib/language'

export function SettingsDialog({
  app,
  open,
  onOpenChange,
  shortcuts,
  onSaveShortcuts,
  onShortcutRecordingChange,
  initialTab
}: {
  app: AgentApp
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 快捷键配置：宿主持有与分发，这里只读写 */
  shortcuts: AgentShortcutConfig[]
  onSaveShortcuts: (shortcuts: AgentShortcutConfig[]) => void
  onShortcutRecordingChange: (recording: boolean) => void
  /** 打开时落在哪个分组（模型选择下拉的设置入口用）；不给 = 通用 */
  initialTab?: 'models' | 'acp'
}) {
  const tr = useT()
  const isMobile = useIsMobile()
  const common = { app, shortcuts, onSaveShortcuts, onShortcutRecordingChange, initialTab }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/*
        手机（<768px）：撑到 88dvh + 改成纵向 flex —— 两级导航（分组菜单 ↔ 单项内容）
        才有足够高度。`max-md:h-auto` 是把「手机上不要那个固定高度」写明白。
        `max-md:p-4`：手机上横向每一像素都值钱。
        宽度写成一条 `min(56rem, calc(100% - 2rem))`：`sm:max-w-4xl`（=56rem）在 640~896px
        这几档会顶掉基础类的 `max-w-[calc(100%-2rem)]`，弹窗直接贴着屏幕两边（既有行为）。
        用 min() 之后「最大 56rem」与「两边各留 16px」同时成立。
      */}
      <DialogContent
        onOpenAutoFocus={(e) => e.preventDefault()}
        className="overflow-hidden sm:max-w-[min(56rem,calc(100%-2rem))] max-md:flex max-md:h-[88dvh] max-md:flex-col max-md:p-4">
        <DialogHeader>
          <DialogTitle>{tr('设置')}</DialogTitle>
        </DialogHeader>

        {isMobile ? (
          <MobileSettingsPanel {...common} className="h-auto" />
        ) : (
          <DesktopSettingsPanel {...common} className="h-[60dvh]" />
        )}
      </DialogContent>
    </Dialog>
  )
}
