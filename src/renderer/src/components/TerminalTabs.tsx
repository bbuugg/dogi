import { Activity, Plus, TerminalSquare, X } from 'lucide-react'
import type { SessionInfo } from '@shared/types'
import { useAppStore } from '@/stores/app-store'
import { Button } from '@/components/ui/button'
import { cn } from 'cn'

function TabItem({ session }: { session: SessionInfo }) {
  const activeSessionId = useAppStore((s) => s.activeSessionId)
  const exited = useAppStore((s) => s.exitedSessions.has(session.id))
  const setActiveSession = useAppStore((s) => s.setActiveSession)
  const closeSession = useAppStore((s) => s.closeSession)
  const active = session.id === activeSessionId

  return (
    <div
      onClick={() => setActiveSession(session.id)}
      className={`group flex h-9 max-w-52 shrink-0 cursor-pointer items-center gap-2 rounded-t-md border border-b-0 px-3 text-xs transition-colors ${
        active
          ? 'border-border bg-card text-foreground'
          : 'border-transparent bg-transparent text-muted-foreground hover:text-foreground'
      }`}
    >
      <TerminalSquare className="size-3.5 shrink-0" />
      <span className="truncate" title={session.title}>
        {session.title}
      </span>
      {exited && <span className="shrink-0 text-[10px] text-destructive">已退出</span>}
      <button
        onClick={(e) => {
          e.stopPropagation()
          void closeSession(session.id)
        }}
        className="ml-1 rounded p-0.5 opacity-0 transition-opacity hover:bg-secondary group-hover:opacity-100"
        title="关闭"
      >
        <X className="size-3" />
      </button>
    </div>
  )
}

export function TerminalTabs() {
  const sessions = useAppStore((s) => s.sessions)
  const createLocalSession = useAppStore((s) => s.createLocalSession)
  const monitorOpen = useAppStore((s) => s.ui.monitorOpen)
  const toggleMonitor = useAppStore((s) => s.toggleMonitor)

  return (
    <div className="flex h-9 shrink-0 items-end gap-1 border-b border-border bg-background px-2">
      <div className="flex flex-1 items-end gap-1 overflow-x-auto">
        {sessions.map((session) => (
          <TabItem key={session.id} session={session} />
        ))}
        {sessions.length === 0 && (
          <span className="pb-1.5 text-xs text-muted-foreground">暂无终端会话</span>
        )}
      </div>
      <Button
        variant="ghost"
        size="icon"
        className={cn('mb-0.5 size-7', monitorOpen && 'bg-secondary text-foreground')}
        title="服务器监控（CPU/内存/流量等）"
        onClick={toggleMonitor}
      >
        <Activity className="size-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="mb-0.5 size-7"
        title="新建本地终端"
        onClick={() => void createLocalSession()}
      >
        <Plus className="size-4" />
      </Button>
    </div>
  )
}
