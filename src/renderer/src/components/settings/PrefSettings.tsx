import { Monitor, Moon, Sun } from 'lucide-react'
import type { ThemeMode } from '@shared/types'
import { useAppStore } from '@/stores/app-store'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { useEffect, useState } from 'react'
import { cn } from 'cn'

const THEME_OPTIONS: Array<{ value: ThemeMode; label: string; icon: typeof Sun }> = [
  { value: 'system', label: '跟随系统', icon: Monitor },
  { value: 'light', label: '亮色', icon: Sun },
  { value: 'dark', label: '暗色', icon: Moon }
]

export function PrefSettings() {
  const preferences = useAppStore((s) => s.preferences)
  const setTheme = useAppStore((s) => s.setTheme)
  const aiSettings = useAppStore((s) => s.aiSettings)
  const saveAiSettings = useAppStore((s) => s.saveAiSettings)
  const [systemPrompt, setSystemPrompt] = useState(aiSettings.systemPrompt ?? '')

  useEffect(() => {
    setSystemPrompt(aiSettings.systemPrompt ?? '')
    // 仅在打开设置时同步一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="space-y-4">
      <div className="rounded-md border border-border px-3 py-3">
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
                  'flex flex-col items-center gap-1.5 rounded-md border px-2 py-3 text-xs transition-colors',
                  active
                    ? 'border-primary bg-primary/10 text-foreground'
                    : 'border-border text-muted-foreground hover:bg-secondary hover:text-foreground'
                )}
              >
                <Icon className="size-4" />
                {label}
              </button>
            )
          })}
        </div>
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="system-prompt">自定义系统提示词（留空使用默认）</Label>
        <Textarea
          id="system-prompt"
          rows={7}
          className="text-xs"
          placeholder="默认：运维助手角色设定，包含安全操作约束等。"
          value={systemPrompt}
          onChange={(e) => setSystemPrompt(e.target.value)}
          onBlur={() => void saveAiSettings({ systemPrompt: systemPrompt.trim() || undefined })}
        />
      </div>
    </div>
  )
}
