/**
 * 设置弹窗（web / 桌面主界面里的应用内弹窗）。
 *
 * 内核是 `SettingsShell`：它按 `platform` 过滤菜单项、按 `form` 挑导航形态。这里只剩
 * **宿主自己的那层壳** —— 弹窗多高、怎么弹出、关掉时清什么。
 *
 * ## 视口只在这里判断一次
 *
 * 「窄屏用两级、宽屏用两栏」是**弹窗这个宿主**的事实（它可能只有 90dvh 高、也可能被
 * 拖到 400px 宽），不是设置内核的事实 —— 所以判断留在这里，用 `settingsNavForm()` 算成
 * 一个 `form` 值，再顺着 `form` 同时决定高度类名（两栏要定高、两级吃 DialogContent
 * 剩下的高度）。**不要再单独写一个 `isMobile ? h-auto : h-[60dvh]`**：两个判断一旦
 * 漂开，就会出现「两栏形态套着两级的高度」。
 *
 * `platform` 取宿主的 `platform`（web 浏览器 / desktop 渲染进程）：桌面端的应用内弹窗
 * 与 web 共用这个组件，两者菜单目前一致，但语义上必须分开 —— 将来某一项只在桌面有
 * （比如「软件更新」已在 `AppUpdateSection` 里按宿主能力隐显），过滤就落在 `sections.ts`。
 */
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@fizz/ui/dialog'
import { useIsMobile } from '@fizz/agent-kit/shared/hooks/useIsMobile'
import type { AgentApp } from '@fizz/agent-kit/shared/hooks/useAgentApp'
import type { AgentShortcutConfig } from '@fizz/agent-kit/shared/lib/shortcuts'
import { SettingsShell, settingsNavForm } from '@fizz/agent-kit/features/settings/SettingsShell'
import { useT } from '@fizz/agent-kit/shared/lib/language'
import { getAgentHost } from '@fizz/agent-client/host'

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
  const form = settingsNavForm(getAgentHost().platform, isMobile)
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

        <SettingsShell
          platform={getAgentHost().platform}
          form={form}
          // 两栏要定高（DialogContent 是 grid、撑不开），两级吃剩余高度
          className={form === 'two-level' ? 'h-auto' : 'h-[60dvh]'}
          {...common}
        />
      </DialogContent>
    </Dialog>
  )
}
