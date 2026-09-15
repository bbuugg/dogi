import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { useAppStore } from '@/stores/app-store'
import type { AppInfo } from '@shared/types'
import { Command as CommandIcon, Monitor, Pencil, Plus, Server, Trash2 } from 'lucide-react'
import { ChevronDown } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { useEffect, useState } from 'react'

export function Sidebar() {
  const profiles = useAppStore((s) => s.profiles)
  const sessions = useAppStore((s) => s.sessions)
  const connectSsh = useAppStore((s) => s.connectSsh)
  const setSshDialog = useAppStore((s) => s.setSshDialog)
  const setCommandPaletteOpen = useAppStore((s) => s.setCommandPaletteOpen)
  const sidebarWidth = useAppStore((s) => s.ui.sidebarWidth)
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
    <aside
      className="select-none flex shrink-0 flex-col bg-sidebar"
      style={{ width: sidebarWidth }}
    >
      <div className="flex-1 overflow-y-auto p-2">
        {/* 本地终端 */}
        <div className="mb-1 flex items-center justify-between px-2 py-1">
          <span className="text-[11px] font-medium text-muted-foreground">本地终端</span>
        </div>
        <NewTerminalMenu />

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

        {/* 全部功能入口（脚本管理、主机、设置等都在命令面板里） */}
        <div className="mt-3">
          <Button
            variant="secondary"
            size="sm"
            className="mb-1 w-full justify-start gap-2"
            title="脚本、主机、设置等全部功能的统一入口"
            onClick={() => setCommandPaletteOpen(true)}
          >
            <CommandIcon className="size-4" /> 命令面板 (Ctrl+Shift+P)
          </Button>
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

/** 新建终端：默认 shell 直接新建，下拉可选择具体 shell（在当前激活组开标签） */
function NewTerminalMenu() {
  const createLocalSession = useAppStore((s) => s.createLocalSession)
  const shells = useAppStore((s) => s.shells)
  const localShell = useAppStore((s) => s.preferences.localShell)
  const effectiveShellId = localShell || 'default'

  return (
    <div className="mb-4 flex">
      <Button
        variant="secondary"
        size="sm"
        className="flex-1 justify-start gap-2 rounded-r-none"
        onClick={() => void createLocalSession()}
      >
        <Plus className="size-4" /> 新建本地终端
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="secondary"
            size="sm"
            className="rounded-l-none border-l border-border/60 px-2"
            title="选择 shell 新建终端"
          >
            <ChevronDown className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-40">
          {shells?.shells.map((shell) => (
            <DropdownMenuItem
              key={shell.id}
              onClick={() => void createLocalSession(shell.id)}
            >
              <span className="flex-1">{shell.name}</span>
              {shell.id === effectiveShellId && (
                <span className="text-[10px] text-muted-foreground">默认</span>
              )}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

