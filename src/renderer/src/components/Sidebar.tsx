import { useState } from 'react'
import type { SshProfile } from '@shared/types'
import { Button } from '@/components/ui/button'
import { useAppStore } from '@/stores/app-store'
import { Pencil, Plus, Server, Trash2 } from 'lucide-react'
import { ChevronDown } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/alert-dialog'

export function Sidebar() {
  const profiles = useAppStore((s) => s.profiles)
  const connectSsh = useAppStore((s) => s.connectSsh)
  const setSshDialog = useAppStore((s) => s.setSshDialog)
  const sidebarWidth = useAppStore((s) => s.ui.sidebarWidth)
  const refreshProfiles = useAppStore((s) => s.refreshProfiles)
  /** 待确认删除的 SSH 配置（非 null 时弹出确认框） */
  const [pendingDelete, setPendingDelete] = useState<SshProfile | null>(null)

  const confirmDelete = async () => {
    const target = pendingDelete
    if (!target) return
    setPendingDelete(null)
    await window.api.ssh.remove(target.id)
    await refreshProfiles()
  }

  return (
    <aside
      className="flex shrink-0 flex-col bg-sidebar"
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
            return (
              // 右键菜单：编辑 / 删除（行内不再放按钮）
              <ContextMenu key={profile.id}>
                <ContextMenuTrigger asChild>
                  <div
                    className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-sidebar-accent"
                    // 双击才连接，避免单击误触
                    onDoubleClick={() => void connectSsh(profile)}
                    title={`双击连接 ${profile.username}@${profile.host}`}
                  >
                    <Server className="size-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-xs font-medium">{profile.name}</div>
                      <div className="truncate text-[10px] text-muted-foreground">
                        {profile.username}@{profile.host}:{profile.port}
                      </div>
                    </div>
                  </div>
                </ContextMenuTrigger>
                <ContextMenuContent className="w-36">
                  <ContextMenuItem onClick={() => void connectSsh(profile)}>
                    <Server className="size-3.5" /> 连接
                  </ContextMenuItem>
                  <ContextMenuItem onClick={() => setSshDialog(true, profile)}>
                    <Pencil className="size-3.5" /> 编辑
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem variant="destructive" onClick={() => setPendingDelete(profile)}>
                    <Trash2 className="size-3.5" /> 删除
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            )
          })}
        </div>

      </div>

      {/* 删除确认（AlertDialog） */}
      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null)
        }}
      >
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>删除 SSH 连接？</AlertDialogTitle>
            <AlertDialogDescription>
              「{pendingDelete?.name}」（{pendingDelete?.username}@{pendingDelete?.host}:
              {pendingDelete?.port}）将从列表中移除，该操作不可撤销。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void confirmDelete()}>
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
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

