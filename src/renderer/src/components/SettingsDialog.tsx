import { Bot, SlidersHorizontal, TerminalSquare } from 'lucide-react'
import { useAppStore } from '@/stores/app-store'
import { cn } from 'cn'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { AiConfigSettings } from '@/components/settings/AiConfigSettings'
import { TerminalSettings } from '@/components/settings/TerminalSettings'
import { PrefSettings } from '@/components/settings/PrefSettings'

type SettingsTab = 'ai' | 'terminal' | 'prefs'

const MENU: Array<{
  value: SettingsTab
  label: string
  desc: string
  icon: typeof Bot
}> = [
  { value: 'prefs', label: '偏好', desc: '应用主题', icon: SlidersHorizontal },
  { value: 'terminal', label: '终端', desc: '配色与外观', icon: TerminalSquare },
  { value: 'ai', label: 'AI 配置', desc: '模型、MCP 服务与提示词', icon: Bot },
]

export function SettingsDialog() {
  const settingsOpen = useAppStore((s) => s.ui.settingsOpen)
  const settingsTab = useAppStore((s) => s.ui.settingsTab) as SettingsTab
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen)

  return (
    <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
      {/* 高度必须加在这层（确定高度），内层用 flex-1 + min-h-0 撑满并内部滚动；
          若把 h-[60vh] 加到内层，会被 flex-1 的 flex-basis:0% 覆盖而失效 */}
      <DialogContent className="flex h-[60vh] max-h-[85vh] w-full max-w-[calc(100%-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl">
        <DialogHeader className="shrink-0 border-b border-border px-5 py-4">
          <DialogTitle>设置</DialogTitle>
          <DialogDescription className="text-xs">
            AI 配置、终端与偏好设置
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-1">
          {/* 左侧菜单 */}
          <nav className="w-44 shrink-0 space-y-1 overflow-y-auto border-r border-border p-3">
            {MENU.map(({ value, label, desc, icon: Icon }) => {
              const active = settingsTab === value
              return (
                <button
                  key={value}
                  type="button"
                  onClick={() => setSettingsOpen(true, value)}
                  className={cn(
                    'w-full rounded-md px-2.5 py-2 text-left transition-colors',
                    active
                      ? 'bg-secondary text-foreground'
                      : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground'
                  )}
                >
                  <span className="flex items-center gap-2 text-[13px] font-medium">
                    <Icon className="size-4 shrink-0" />
                    {label}
                  </span>
                  <span className="mt-0.5 block truncate pl-6 text-[10px] text-muted-foreground">
                    {desc}
                  </span>
                </button>
              )
            })}
          </nav>

          {/* 右侧内容 */}
          <div className="min-w-0 flex-1 overflow-y-auto p-5">
            {settingsTab === 'ai' && <AiConfigSettings />}
            {settingsTab === 'terminal' && <TerminalSettings />}
            {settingsTab === 'prefs' && <PrefSettings />}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
