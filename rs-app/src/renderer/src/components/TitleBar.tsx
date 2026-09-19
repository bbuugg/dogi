import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Copy, Minus, Square, X } from 'lucide-react'
import { cn } from 'cn'
import appIcon from '@/assets/app-icon.png'

/**
 * 自定义标题栏（跨 Win/mac/Linux）：
 * - 整条为 Tauri 拖拽区域（data-tauri-drag-region），交互元素不挂该属性以排除拖拽
 * - macOS：隐藏系统标题栏但保留交通灯（hiddenInset），左侧留出交通灯位置，不渲染自绘控制按钮
 * - Windows / Linux：右侧自绘最小化 / 最大化(还原) / 关闭按钮
 */
export function TitleBar() {
  const platform = window.api.app.platform
  const isMac = platform === 'darwin'
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    void window.api.window.isMaximized().then(setMaximized)
    return window.api.window.onMaximizedChange(setMaximized)
  }, [])

  return (
    <header data-tauri-drag-region className="flex h-9 shrink-0 items-stretch bg-background">
      {isMac ? (
        <div data-tauri-drag-region className="w-[76px] shrink-0" />
      ) : (
        <div className="flex w-36 shrink-0 items-center gap-2 pl-3">
          <img src={appIcon} alt="OpsDesk" className="size-5" draggable={false} />
          <span className="text-xs font-semibold">OpsDesk</span>
        </div>
      )}

      <div data-tauri-drag-region className="flex min-w-0 flex-1 items-end" />

      {!isMac && (
        <div className="flex items-stretch">
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