/**
 * 独立设置窗口的内容体（desktop 的 `?window=settings`）。
 *
 * 与 `SettingsDialog`（web / 应用内弹窗）的区别只有「怎么出现」：这里是整窗铺满，
 * 没有 Dialog 那层壳，所以自己包一份 `AppProvider` + `TooltipProvider`。
 * 本体走 `SettingsShell`（`platform="desktop"` + 恒两栏），与 web 弹窗同一份菜单过滤
 * 与表单实现，两边不会漂。
 *
 * 快捷键配置由壳持有 —— 应用内那套在 `AppShell`，这里没有全局快捷键分发器，
 * 所以就地用 `loadShortcuts/saveShortcuts` 自己管，录制态无需通知任何人。
 * 落盘走 `saveShortcuts` 的 `storage` 事件，主窗口那边会自己重读（`useShortcuts`）。
 */
import { useEffect, useState } from 'react'
import { TooltipProvider } from '@fizz/ui/tooltip'
import { AppProvider } from '@fizz/agent-kit/shell/app-provider'
import { useAppContext } from '@fizz/agent-kit/shared/hooks/use-app-context'
import { SettingsShell } from '@fizz/agent-kit/features/settings/SettingsShell'
import { loadShortcuts, saveShortcuts, type AgentShortcutConfig } from '@fizz/agent-kit/shared/lib/shortcuts'
import type { DesktopSettingsTab } from '../../shared/window'

export function SettingsWindow({ initialTab }: { initialTab?: DesktopSettingsTab }) {
  return (
    <TooltipProvider>
      <AppProvider>
        <SettingsSurface initialTab={initialTab} />
      </AppProvider>
    </TooltipProvider>
  )
}

function SettingsSurface({ initialTab }: { initialTab?: DesktopSettingsTab }) {
  const { app } = useAppContext()
  const [shortcuts, setShortcuts] = useState<AgentShortcutConfig[]>(() => loadShortcuts())
  /**
   * 「主窗口请求切分组」的落点。选中分组是面板自己的 state（`SettingsShell` 里的
   * `DesktopSettingsPanel`），`initialTab` 只在挂载时生效 —— 所以收到请求就用 `key`
   * 把整块外壳重挂一次（等价于关掉再打开，这是弹窗时代的行为）。
   * `seq` 让「同一个分组连点两次」也能生效。
   */
  const [request, setRequest] = useState<{ tab?: DesktopSettingsTab; seq: number }>({
    tab: initialTab,
    seq: 0
  })
  useEffect(
    () =>
      window.fizzWindow.onSettingsTab((tab) => {
        setRequest((prev) => ({ tab, seq: prev.seq + 1 }))
      }),
    []
  )

  return (
    <SettingsShell
      key={`${request.tab ?? 'general'}#${request.seq}`}
      platform="desktop"
      // 整窗铺满，没有「窄屏」这回事（主进程那边限了最小宽度）→ 恒两栏
      form="two-column"
      initialTab={request.tab}
      app={app}
      shortcuts={shortcuts}
      onSaveShortcuts={(next) => {
        setShortcuts(next)
        saveShortcuts(next)
      }}
      onShortcutRecordingChange={() => undefined}
      className="h-full"
    />
  )
}
