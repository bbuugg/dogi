import { TerminalSquare } from 'lucide-react'
import { useAppStore } from '@/stores/app-store'
import { TitleBar } from '@/components/TitleBar'
import { Sidebar } from '@/components/Sidebar'
import { MonitorPanel } from '@/components/MonitorPanel'
import { AiPanel } from '@/components/AiPanel'
import { SshProfileDialog } from '@/components/SshProfileDialog'
import { SettingsDialog } from '@/components/SettingsDialog'
import { PaneLayout } from '@/components/PaneLayout'
import { ScriptPalette } from '@/components/ScriptPalette'
import { ScriptsPage } from '@/components/ScriptsPage'
import { Button } from '@/components/ui/button'

function EmptyState() {
  const createLocalSession = useAppStore((s) => s.createLocalSession)
  const setSshDialog = useAppStore((s) => s.setSshDialog)
  return (
    <div className="select-none flex h-full flex-col items-center justify-center gap-4 text-muted-foreground">
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
  const aiPanelOpen = useAppStore((s) => s.ui.aiPanelOpen)
  const monitorOpen = useAppStore((s) => s.ui.monitorOpen)
  const view = useAppStore((s) => s.ui.view)

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-background text-foreground">
      <TitleBar />
      <div className="flex min-h-0 flex-1">
        <Sidebar />

        <main className="relative flex min-w-0 flex-1 flex-col">
          {monitorOpen && activeSessionId && view === 'terminal' && (
            <MonitorPanel sessionId={activeSessionId} />
          )}
          {/* 终端区常驻挂载，切到脚本页时用 hidden 保活 xterm 实例 */}
          <div className={view === 'terminal' ? 'min-h-0 flex-1' : 'hidden'}>
            {layout ? <PaneLayout layout={layout} /> : <EmptyState />}
          </div>
          {view === 'scripts' && <ScriptsPage />}
        </main>

        {aiPanelOpen && <AiPanel />}
      </div>

      <SshProfileDialog />
      <SettingsDialog />
      <ScriptPalette />
    </div>
  )
}
