import { useEffect } from 'react'
import { TerminalSquare } from 'lucide-react'
import { useAppStore } from '@/stores/app-store'
import { TitleBar } from '@/components/TitleBar'
import { Sidebar } from '@/components/Sidebar'
import { ActivityBar } from '@/components/ActivityBar'
import { useActiveActivity } from '@/activities'
import { MonitorBadge } from '@/components/MonitorBadge'
import { SshProfileDialog } from '@/components/SshProfileDialog'
import { SettingsDialog } from '@/components/SettingsDialog'
import { PaneLayout } from '@/components/PaneLayout'
import { CommandPalette } from '@/components/CommandPalette'
import { RunScriptDialog } from '@/components/RunScriptDialog'
import { ScriptsPage } from '@/components/ScriptsPage'
import { NotesPage } from '@/components/NotesPage'
import { StatusBar } from '@/components/StatusBar'
import { ResizeHandle } from '@/components/ResizeHandle'
import { AntdProvider } from '@/components/AntdProvider'
import { DndProvider } from 'react-dnd'
import { HTML5Backend } from 'react-dnd-html5-backend'
import { Button } from 'antd'

function EmptyState() {
  const setSshDialog = useAppStore((s) => s.setSshDialog)
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 text-muted-foreground">
      <TerminalSquare className="size-12 opacity-30" />
      <div className="text-sm">还没有打开的终端</div>
      <div className="text-xs">添加主机即可连接远程 SSH 或本地终端</div>
      <Button type="primary" icon={<TerminalSquare className="size-4" />} onClick={() => setSshDialog(true, null)}>
        添加主机
      </Button>
    </div>
  )
}

export default function App() {
  const layout = useAppStore((s) => s.layout)
  const activeSessionId = useAppStore((s) => s.activeSessionId)
  const sidebarWidth = useAppStore((s) => s.ui.sidebarWidth)
  const setSidebarWidth = useAppStore((s) => s.setSidebarWidth)
  // 导航状态只有活动栏选中项一个真源，主区域显示什么由它派生
  const { activity, sidebarVisible } = useActiveActivity()
  const view = activity.view

  /**
   * F5 / Ctrl+F5：拦截刷新（WebView2 已禁用浏览器快捷键，这里再做一层兜底），
   * 避免整窗刷新清空内存里的终端会话状态。Ctrl+R 刻意放行——bash 里是历史逆向搜索。
   * Ctrl/⌘+W：关闭当前激活的终端标签。
   * 只作用于本窗口，因此不登记进 SHORTCUT_ACTIONS——那里的条目会被注册成系统级热键，
   * 会把其它应用的 Ctrl+W 一并抢走。
   */
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'F5') {
        e.preventDefault()
        return
      }
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return
      if (e.key.toLowerCase() !== 'w') return
      const { activeSessionId: id, closeSession } = useAppStore.getState()
      if (!id) return
      e.preventDefault()
      void closeSession(id)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  return (
    <AntdProvider>
      {/* 单一 DndProvider：HostsPanel 与 PaneLayout 的拖拽共享同一 backend（react-dnd 禁止两个 HTML5 backend） */}
      <DndProvider backend={HTML5Backend}>
        {/* overflow-clip（而非 hidden）：clip 不构成滚动容器，Chrome 无法因焦点元素
            （如终端输入法组合期间被拉宽的 textarea）越界而对应用根节点做横向 scrollIntoView，
            杜绝「整个页面被推左」 */}
        <div className="flex h-screen w-screen flex-col overflow-clip bg-background text-foreground">
        <TitleBar />
        <div className="flex min-h-0 flex-1">
          {/* 活动栏常驻（不随侧边栏折叠消失），用于切换左侧功能区 */}
          <ActivityBar />
          {/* 侧边栏可折叠：外层容器宽度切换（内部保持固定宽度不回流，
              折叠时拖拽条隐藏，展开入口在标题栏） */}
          <div
            className="shrink-0 overflow-hidden"
            style={{ width: sidebarVisible ? sidebarWidth : 0 }}
          >
            <Sidebar />
          </div>
          {sidebarVisible && (
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
            {view === 'notes' && <NotesPage />}
          </main>
        </div>

        {/* 底部功能条（类 VS Code 状态栏），整宽；监控指标条常驻左侧 */}
        <StatusBar>{view === 'terminal' && <MonitorBadge sessionId={activeSessionId} />}</StatusBar>

        <SshProfileDialog />
        <SettingsDialog />
        <CommandPalette />
        <RunScriptDialog />
        </div>
      </DndProvider>
    </AntdProvider>
  )
}
