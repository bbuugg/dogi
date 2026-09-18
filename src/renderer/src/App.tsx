import { useEffect, useState } from 'react'
import { TerminalSquare } from 'lucide-react'
import { useAppStore } from '@/stores/app-store'
import { TitleBar } from '@/components/TitleBar'
import { Sidebar } from '@/components/Sidebar'
import { MonitorBadge } from '@/components/MonitorBadge'
import { SshProfileDialog } from '@/components/SshProfileDialog'
import { SettingsDialog } from '@/components/SettingsDialog'
import { PaneLayout } from '@/components/PaneLayout'
import { CommandPalette } from '@/components/CommandPalette'
import { RunScriptDialog } from '@/components/RunScriptDialog'
import { ScriptsPage } from '@/components/ScriptsPage'
import { PluginsPage } from '@/components/PluginsPage'
import { AppToaster } from '@/components/AppToaster'
import { StatusBar } from '@/components/StatusBar'
import { ResizeHandle } from '@/components/ResizeHandle'
import { AntdProvider } from '@/components/AntdProvider'
import { Button } from '@/components/ui/button'

function EmptyState() {
  const createLocalSession = useAppStore((s) => s.createLocalSession)
  const setSshDialog = useAppStore((s) => s.setSshDialog)
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 text-muted-foreground">
      <TerminalSquare className="size-12 opacity-30" />
      <div className="text-sm">从左侧新建本地终端或连接 SSH</div>
      <div className="flex gap-2">
        <Button variant="secondary" size="sm" onClick={() => void createLocalSession()}>
          新建本地终端
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setSshDialog(true, null)}>
          添加 SSH 连接
        </Button>
      </div>
    </div>
  )
}

export default function App() {
  const layout = useAppStore((s) => s.layout)
  const activeSessionId = useAppStore((s) => s.activeSessionId)
  const view = useAppStore((s) => s.ui.view)
  const pluginView = useAppStore((s) => s.ui.pluginView)
  const plugins = useAppStore((s) => s.plugins)
  const sidebarWidth = useAppStore((s) => s.ui.sidebarWidth)
  const sidebarCollapsed = useAppStore((s) => s.ui.sidebarCollapsed)
  const setSidebarWidth = useAppStore((s) => s.setSidebarWidth)

  /**
   * 已打开过的插件视图 id：保持挂载（非激活时用 hidden 隐藏），
   * 这样切到终端/其它页再切回来，插件内部 state（表单、编辑器内容等）不会丢。
   */
  const [mountedPluginViews, setMountedPluginViews] = useState<string[]>([])

  useEffect(() => {
    const alive = new Set(plugins.map((p) => p.viewId))
    setMountedPluginViews((prev) => {
      let changed = false
      const next = prev.filter((id) => {
        const ok = alive.has(id)
        if (!ok) changed = true
        return ok
      })
      if (view === 'plugin' && pluginView && alive.has(pluginView) && !next.includes(pluginView)) {
        next.push(pluginView)
        changed = true
      }
      return changed ? next : prev
    })
  }, [plugins, view, pluginView])

  return (
    <AntdProvider>
      <div className="flex h-screen w-screen flex-col overflow-hidden bg-background text-foreground">
        <TitleBar />
        <div className="flex min-h-0 flex-1">
          {/* 侧边栏可折叠：外层容器宽度过渡实现展开/收起动画（内部保持固定宽度不回流，
              折叠时拖拽条隐藏，展开入口在标题栏） */}
          <div
            className="shrink-0 overflow-hidden transition-[width] duration-200 ease-out"
            style={{ width: sidebarCollapsed ? 0 : sidebarWidth }}
          >
            <Sidebar />
          </div>
          {!sidebarCollapsed && (
            <ResizeHandle
              width={sidebarWidth}
              min={180}
              max={480}
              onResize={setSidebarWidth}
            />
          )}

          <main className="relative flex min-w-0 flex-1 flex-col">
            {/* 终端区常驻挂载，切到脚本页时用 hidden 保活 xterm 实例 */}
            <div className={view === 'terminal' ? 'min-h-0 flex-1' : 'hidden'}>
              {layout ? <PaneLayout layout={layout} /> : <EmptyState />}
            </div>
            {view === 'scripts' && <ScriptsPage />}
            {view === 'plugins' && <PluginsPage />}
            {/* 插件视图：已打开过的保持挂载，只有激活的那个可见（切去终端再切回不丢状态） */}
            {plugins
              .filter((p) => p.viewId === pluginView || mountedPluginViews.includes(p.viewId))
              .map((p) => (
                <div
                  key={p.viewId}
                  className={
                    view === 'plugin' && pluginView === p.viewId ? 'min-h-0 flex-1' : 'hidden'
                  }
                >
                  <p.Component />
                </div>
              ))}
          </main>
        </div>

        {/* 底部功能条（类 VS Code 状态栏），整宽；监控指标条常驻左侧 */}
        <StatusBar>{view === 'terminal' && <MonitorBadge sessionId={activeSessionId} />}</StatusBar>

        <SshProfileDialog />
        <SettingsDialog />
        <CommandPalette />
        <RunScriptDialog />

        {/* 全局通知 */}
        <AppToaster />
      </div>
    </AntdProvider>
  )
}
