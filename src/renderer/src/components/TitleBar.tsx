import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Copy, Minus, PanelLeftClose, PanelLeftOpen, Square, X } from 'lucide-react'
import { cn } from 'cn'
import { useAppStore } from '@/stores/app-store'
import { Button } from '@/components/ui/button'
import appIcon from '@/assets/app-icon.png'

/**
 * 自定义标题栏（跨 Win/mac/Linux）：
 * - 整条为拖拽区域（app-drag），交互元素用 app-no-drag 排除
 * - macOS：隐藏系统标题栏但保留交通灯（hiddenInset），左侧留出交通灯位置，不渲染自绘控制按钮
 * - Windows / Linux：右侧自绘最小化 / 最大化(还原) / 关闭按钮
 */
export function TitleBar() {
  const platform = window.api.app.platform
  const isMac = platform === 'darwin'
  const [maximized, setMaximized] = useState(false)
  const sidebarCollapsed = useAppStore((s) => s.ui.sidebarCollapsed)
  const setSidebarCollapsed = useAppStore((s) => s.setSidebarCollapsed)

  useEffect(() => {
    void window.api.window.isMaximized().then(setMaximized)
    return window.api.window.onMaximizedChange(setMaximized)
  }, [])

  const sidebarToggle = (
    <Button
      variant="ghost"
      size="icon"
      className="size-8"
      title={sidebarCollapsed ? '展开侧边栏' : '折叠侧边栏'}
      onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
    >
      {sidebarCollapsed ? (
        <PanelLeftOpen className="size-4" />
      ) : (
        <PanelLeftClose className="size-4" />
      )}
    </Button>
  )

  return (
    <header className="app-drag flex h-9 shrink-0 items-stretch bg-background">
      {isMac ? (
        <>
          <div className="w-[76px] shrink-0" />
          <div className="app-no-drag flex shrink-0 items-center pl-1">{sidebarToggle}</div>
        </>
      ) : (
        <div className="app-no-drag flex w-36 shrink-0 items-center gap-2 pl-3">
          <img src={appIcon} alt="OpsDesk" className="size-5" draggable={false} />
          <span className="text-xs font-semibold">OpsDesk</span>
          {sidebarToggle}
        </div>
      )}

      <div className="flex min-w-0 flex-1 items-end" />

      {!isMac && (
        <div className="app-no-drag flex items-stretch">
          <TitleBarButton title="最小化" onClick={() => void window.api.window.minimize()}>
            <Minus className="size-3.5" />
          </TitleBarButton>
          <TitleBarButton
            title={maximized ? '还原' : '最大化'}
            onClick={() => void window.api.window.toggleMaximize()}
          >
            {maximized ? <Copy className="size-3" /> : <Square className="size-3" />}
          </TitleBarButton>
          <TitleBarButton
            title="关闭"
            destructive
            onClick={() => void window.api.window.close()}
          >
            <X className="size-3.5" />
          </TitleBarButton>
        </div>
      )}
    </header>
  )
}

function TitleBarButton({
  title,
  destructive,
  onClick,
  children
}: {
  title: string
  destructive?: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={cn(
        'flex w-11 items-center justify-center text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground',
        destructive && 'hover:bg-destructive hover:text-destructive-foreground'
      )}
    >
      {children}
    </button>
  )
}