import { Monitor, Moon, Sun } from 'lucide-react'
import type { ThemeMode } from '@shared/types'
import { useAppStore } from '@/stores/app-store'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { cn } from 'cn'

const THEME_OPTIONS: Array<{ value: ThemeMode; label: string; icon: typeof Sun }> = [
  { value: 'system', label: '跟随系统', icon: Monitor },
  { value: 'light', label: '亮色', icon: Sun },
  { value: 'dark', label: '暗色', icon: Moon }
]

export function PrefSettings() {
  const preferences = useAppStore((s) => s.preferences)
  const setTheme = useAppStore((s) => s.setTheme)
  const minimizeToTray = useAppStore((s) => s.preferences.minimizeToTray)
  const setMinimizeToTray = useAppStore((s) => s.setMinimizeToTray)

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-4 rounded-md">
        <div>
          <Label htmlFor="minimize-to-tray">关闭时最小化到系统托盘</Label>
          <p className="mt-1 text-[11px] leading-4 text-muted-foreground">
            关闭主窗口时隐藏到系统托盘继续运行，从托盘图标右键菜单中选择「退出」才真正关闭程序。
          </p>
        </div>
        <Switch
          id="minimize-to-tray"
          checked={minimizeToTray}
          onCheckedChange={(v) => void setMinimizeToTray(v)}
        />
      </div>

      <div className="rounded-md">
        <Label>主题</Label>
        <p className="mt-1 mb-2.5 text-[11px] leading-4 text-muted-foreground">
          「跟随系统」随 Windows 深浅色自动切换。终端配色请在左侧「终端」中单独设置。
        </p>
        <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="主题模式">
          {THEME_OPTIONS.map(({ value, label, icon: Icon }) => {
            const active = preferences.theme === value
            return (
              <button
                key={value}
                role="radio"
                aria-checked={active}
                onClick={() => void setTheme(value)}
                className={cn(
                  'flex flex-col items-center gap-1.5 rounded-md px-2 py-3 text-xs transition-colors',
                  active
                    ? 'bg-primary/10 text-foreground'
                    : 'text-muted-foreground hover:bg-secondary hover:text-foreground'
                )}
              >
                <Icon className="size-4" />
                {label}
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}
