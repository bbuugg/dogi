import { Monitor, Pencil, Plus, Server, Settings, Sparkles, Trash2 } from 'lucide-react'
import { useAppStore } from '@/stores/app-store'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { useEffect, useState } from 'react'
import type { AppInfo } from '@shared/types'

export function Sidebar() {
  const profiles = useAppStore((s) => s.profiles)
  const sessions = useAppStore((s) => s.sessions)
  const aiPanelOpen = useAppStore((s) => s.ui.aiPanelOpen)
  const createLocalSession = useAppStore((s) => s.createLocalSession)
  const connectSsh = useAppStore((s) => s.connectSsh)
  const setSshDialog = useAppStore((s) => s.setSshDialog)
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen)
  const setAiPanelOpen = useAppStore((s) => s.setAiPanelOpen)
  const refreshProfiles = useAppStore((s) => s.refreshProfiles)
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null)

  useEffect(() => {
    void window.api.app.info().then(setAppInfo)
  }, [])

  const handleDeleteProfile = async (id: string, name: string) => {
    if (!window.confirm(`确定删除 SSH 配置「${name}」吗？`)) return
    await window.api.ssh.remove(id)
    await refreshProfiles()
  }

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-border bg-sidebar">
      <div className="flex items-center gap-2 px-4 py-3">
        <div className="flex size-7 items-center justify-center rounded-md bg-sidebar-primary text-sidebar-primary-foreground">
          <TerminalGlyph />
        </div>
        <div className="flex-1">
          <div className="text-sm font-semibold">OpsDesk</div>
          <div className="text-[10px] text-muted-foreground">AI 运维终端</div>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          title={aiPanelOpen ? '隐藏 AI 助手' : '显示 AI 助手'}
          onClick={() => setAiPanelOpen(!aiPanelOpen)}
        >
          <Sparkles className={`size-4 ${aiPanelOpen ? 'text-primary' : ''}`} />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          title="设置"
          onClick={() => setSettingsOpen(true)}
        >
          <Settings className="size-4" />
        </Button>
      </div>
      <Separator />

      <div className="flex-1 overflow-y-auto p-2">
        {/* 本地终端 */}
        <div className="mb-1 flex items-center justify-between px-2 py-1">
          <span className="text-[11px] font-medium text-muted-foreground">本地终端</span>
        </div>
        <Button
          variant="secondary"
          size="sm"
          className="mb-4 w-full justify-start gap-2"
          onClick={() => void createLocalSession()}
        >
          <Plus className="size-4" /> 新建本地终端
        </Button>

        {/* SSH 连接 */}
        <div className="mb-1 flex items-center justify-between px-2 py-1">
          <span className="text-[11px] font-medium text-muted-foreground">
            SSH 连接 ({profiles.length})
          </span>
          <button
            className="text-muted-foreground transition-colors hover:text-foreground"
            title="新建 SSH 连接"
            onClick={() => setSshDialog(true, null)}
          >
            <Plus className="size-3.5" />
          </button>
        </div>
        <div className="space-y-0.5">
          {profiles.length === 0 && (
            <div className="px-2 py-3 text-center text-xs text-muted-foreground">
              还没有 SSH 连接
              <br />
              点击右上角 + 添加
            </div>
          )}
          {profiles.map((profile) => {
            const connectedCount = sessions.filter(
              (s) => s.profileId === profile.id
            ).length
            return (
              <div
                key={profile.id}
                className="group flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-sidebar-accent"
                onClick={() => void connectSsh(profile)}
                title={`连接 ${profile.username}@${profile.host}`}
              >
                <Server className="size-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs font-medium">{profile.name}</div>
                  <div className="truncate text-[10px] text-muted-foreground">
                    {profile.username}@{profile.host}:{profile.port}
                  </div>
                </div>
                {connectedCount > 0 && (
                  <Badge variant="secondary" className="h-4 px-1 text-[9px]">
                    {connectedCount}
                  </Badge>
                )}
                <div className="hidden shrink-0 items-center gap-0.5 group-hover:flex">
                  <button
                    className="rounded p-1 text-muted-foreground hover:bg-background hover:text-foreground"
                    title="编辑"
                    onClick={(e) => {
                      e.stopPropagation()
                      setSshDialog(true, profile)
                    }}
                  >
                    <Pencil className="size-3" />
                  </button>
                  <button
                    className="rounded p-1 text-muted-foreground hover:bg-background hover:text-destructive"
                    title="删除"
                    onClick={(e) => {
                      e.stopPropagation()
                      void handleDeleteProfile(profile.id, profile.name)
                    }}
                  >
                    <Trash2 className="size-3" />
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      </div>

      <Separator />
      <div className="flex items-center gap-1.5 px-4 py-2 text-[10px] text-muted-foreground">
        <Monitor className="size-3" />
        Electron {appInfo?.electron ?? '-'} · v{appInfo?.version ?? '-'}
      </div>
    </aside>
  )
}

function TerminalGlyph() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" y1="19" x2="20" y2="19" />
    </svg>
  )
}
