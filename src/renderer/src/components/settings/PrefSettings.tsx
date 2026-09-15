import { Check, Monitor, Moon, Sun } from 'lucide-react'
import type { ThemeMode } from '@shared/types'
import { useAppStore } from '@/stores/app-store'
import { COLOR_THEMES } from '@/lib/color-themes'
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
  const setColorTheme = useAppStore((s) => s.setColorTheme)
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
        <div className="text-sm font-medium">明暗主题</div>
        <p className="mt-1 mb-2.5 text-[11px] leading-4 text-muted-foreground">
          「跟随系统」随 Windows 深浅色自动切换。
        </p>
        <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="明暗主题">
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

      <div className="rounded-md">
        <div className="text-sm font-medium">配色</div>
        <p className="mt-1 mb-2.5 text-[11px] leading-4 text-muted-foreground">
          界面强调色（按钮、选中态、焦点框等），选择后立即生效。终端配色请到左侧「终端」中单独设置。
        </p>
        <div className="grid grid-cols-4 gap-2" role="radiogroup" aria-label="配色方案">
          {COLOR_THEMES.map((preset) => {
            const active = preferences.colorTheme === preset.id
            return (
              <button
                key={preset.id}
                role="radio"
                aria-checked={active}
                title={preset.label}
                onClick={() => void setColorTheme(preset.id)}
                className={cn(
                  'flex items-center gap-2 rounded-md px-2.5 py-2 text-xs transition-colors',
                  active
                    ? 'bg-primary/10 text-foreground'
                    : 'text-muted-foreground hover:bg-secondary hover:text-foreground'
                )}
              >
                <span
                  className="size-4 shrink-0 rounded-full border border-border/60"
                  style={{ background: preset.swatch }}
                />
                <span className="min-w-0 flex-1 truncate text-left">{preset.label}</span>
                {active && <Check className="size-3.5 shrink-0 text-primary" />}
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}
