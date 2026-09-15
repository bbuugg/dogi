import { Check } from 'lucide-react'
import type { TerminalThemeName } from '@shared/types'
import { useAppStore } from '@/stores/app-store'
import { useIsDarkTheme } from '@/lib/theme'
import { TERMINAL_THEMES, resolveTerminalTheme } from '@/lib/terminal-themes'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { cn } from 'cn'

export function TerminalSettings() {
  const terminalTheme = useAppStore((s) => s.preferences.terminalTheme)
  const setTerminalTheme = useAppStore((s) => s.setTerminalTheme)
  const copyOnSelect = useAppStore((s) => s.preferences.copyOnSelect)
  const setCopyOnSelect = useAppStore((s) => s.setCopyOnSelect)
  const commandPrediction = useAppStore((s) => s.preferences.commandPrediction)
  const setCommandPrediction = useAppStore((s) => s.setCommandPrediction)
  const localShell = useAppStore((s) => s.preferences.localShell)
  const setLocalShell = useAppStore((s) => s.setLocalShell)
  const shells = useAppStore((s) => s.shells)
  const isDark = useIsDarkTheme()

  const defaultShellName =
    shells?.shells.find((s) => s.id === shells.defaultId)?.name ?? '系统默认'

  return (
    <div className="space-y-5">
      <div className="rounded-md">
        <div className="text-sm font-medium">默认本地终端</div>
        <p className="mt-1 mb-3 text-[11px] leading-4 text-muted-foreground">
          新建本地终端时默认使用的 shell，可选项来自本机检测结果。点击标签栏「+」旁的下拉箭头也可临时使用其他 shell 新建。
        </p>
        <Select
          value={localShell || 'default'}
          onValueChange={(v) => void setLocalShell(v)}
        >
          <SelectTrigger className="w-56" aria-label="默认本地终端">
            <SelectValue placeholder="选择 shell" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="default">系统默认（{defaultShellName}）</SelectItem>
            {shells?.shells.map((shell) => (
              <SelectItem key={shell.id} value={shell.id}>
                {shell.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="rounded-md">
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
                  'flex items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs transition-colors',
                  active
                    ? 'bg-primary/10 text-foreground'
                    : 'text-muted-foreground hover:bg-secondary hover:text-foreground'
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

      <div className="flex items-start justify-between gap-4 rounded-md">
        <div>
          <Label htmlFor="copy-on-select">选中文本即复制</Label>
          <p className="mt-1 text-[11px] leading-4 text-muted-foreground">
            在终端里选中文本后自动复制到剪贴板，无需手动 Ctrl+C。
          </p>
        </div>
        <Switch
          id="copy-on-select"
          checked={copyOnSelect}
          onCheckedChange={(v) => void setCopyOnSelect(v)}
        />
      </div>

      <div className="flex items-start justify-between gap-4 rounded-md">
        <div>
          <Label htmlFor="command-prediction">命令预测补全</Label>
          <p className="mt-1 text-[11px] leading-4 text-muted-foreground">
            根据命令历史与常见命令，在输入时给出补全建议，按 Tab 或 → 接受，↑/↓ 切换。
          </p>
        </div>
        <Switch
          id="command-prediction"
          checked={commandPrediction}
          onCheckedChange={(v) => void setCommandPrediction(v)}
        />
      </div>
    </div>
  )
}
