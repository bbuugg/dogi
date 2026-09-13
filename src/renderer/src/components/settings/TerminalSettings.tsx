import { Check } from 'lucide-react'
import type { TerminalThemeName } from '@shared/types'
import { useAppStore } from '@/stores/app-store'
import { useIsDarkTheme } from '@/lib/theme'
import { TERMINAL_THEMES, resolveTerminalTheme } from '@/lib/terminal-themes'
import { cn } from 'cn'

export function TerminalSettings() {
  const terminalTheme = useAppStore((s) => s.preferences.terminalTheme)
  const setTerminalTheme = useAppStore((s) => s.setTerminalTheme)
  const isDark = useIsDarkTheme()

  return (
    <div className="space-y-4">
      <div className="rounded-md border border-border px-3 py-3">
        <div className="text-sm font-medium">终端配色</div>
        <p className="mt-1 mb-3 text-[11px] leading-4 text-muted-foreground">
          选择终端的配色方案，切换后立即对所有终端会话生效。
        </p>
        <div className="grid grid-cols-2 gap-2">
          {TERMINAL_THEMES.map((preset) => {
            const active = terminalTheme === preset.id
            const theme = resolveTerminalTheme(preset.id, isDark)
            const swatch: string[] = [
              theme.background ?? '#000',
              theme.red ?? '#000',
              theme.green ?? '#000',
              theme.yellow ?? '#000',
              theme.blue ?? '#000'
            ]
            return (
              <button
                key={preset.id}
                type="button"
                onClick={() => void setTerminalTheme(preset.id as TerminalThemeName)}
                className={cn(
                  'flex items-center gap-2 rounded-md border px-2.5 py-2 text-left text-xs transition-colors',
                  active
                    ? 'border-primary bg-primary/10 text-foreground'
                    : 'border-border text-muted-foreground hover:bg-secondary hover:text-foreground'
                )}
              >
                <span
                  className="flex size-9 shrink-0 items-center justify-center gap-0.5 rounded border border-border/60"
                  style={{ background: swatch[0] }}
                >
                  {swatch.slice(1).map((color, i) => (
                    <span
                      key={i}
                      className="size-2 rounded-full"
                      style={{ background: color }}
                    />
                  ))}
                </span>
                <span className="min-w-0 flex-1 truncate">{preset.label}</span>
                {active && <Check className="size-3.5 shrink-0 text-primary" />}
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}
