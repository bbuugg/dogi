import { Check, Monitor, Moon, Sun } from 'lucide-react'
import type { ThemeMode } from '@shared/types'
import { useAppStore } from '@/stores/app-store'
import { COLOR_THEMES } from '@/shared/lib/color-themes'
import { ColorPicker, Switch } from 'antd'
import { cn } from 'cn'

const THEME_OPTIONS: Array<{ value: ThemeMode; label: string; icon: typeof Sun }> = [
  { value: 'system', label: '跟随系统', icon: Monitor },
  { value: 'light', label: '亮色', icon: Sun },
  { value: 'dark', label: '暗色', icon: Moon }
]

/** 配色色板的统一样式（预设与自定义色块共用） */
const TILE_CLASS = 'flex items-center gap-2 rounded-md px-2.5 py-2 text-xs transition-colors'
const TILE_ACTIVE_CLASS = 'bg-primary/10 text-foreground'
const TILE_IDLE_CLASS = 'text-muted-foreground hover:bg-secondary hover:text-foreground'

export function PrefSettings() {
  const preferences = useAppStore((s) => s.preferences)
  const setTheme = useAppStore((s) => s.setTheme)
  const setColorTheme = useAppStore((s) => s.setColorTheme)
  const minimizeToTray = useAppStore((s) => s.preferences.minimizeToTray)
  const setMinimizeToTray = useAppStore((s) => s.setMinimizeToTray)
  const confirmCloseTab = useAppStore((s) => s.preferences.confirmCloseTab)
  const setConfirmCloseTab = useAppStore((s) => s.setConfirmCloseTab)
  const customColor = preferences.customColor
  const customActive = preferences.colorTheme === 'custom'

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-4 rounded-md">
        <div>
          <label htmlFor="minimize-to-tray" className="font-medium text-foreground">
            关闭时最小化到系统托盘
          </label>
          <p className="mt-1 text-xs leading-4 text-muted-foreground">
            关闭主窗口时隐藏到系统托盘继续运行，从托盘图标右键菜单中选择「退出」才真正关闭程序。
          </p>
        </div>
        <Switch
          id="minimize-to-tray"
          checked={minimizeToTray}
          onChange={(v) => void setMinimizeToTray(v)}
        />
      </div>

      <div className="flex items-start justify-between gap-4 rounded-md">
        <div>
          <label htmlFor="confirm-close-tab" className="font-medium text-foreground">
            关闭标签前二次确认
          </label>
          <p className="mt-1 text-xs leading-4 text-muted-foreground">
            关闭标签或整个面板组时先弹确认框。在确认框里勾选「以后都不再提示」会自动关掉这个开关，
            需要时再从这里打开。
          </p>
        </div>
        <Switch
          id="confirm-close-tab"
          checked={confirmCloseTab}
          onChange={(v) => void setConfirmCloseTab(v)}
        />
      </div>

      <div className="rounded-md">
        <div className="text-sm font-medium">明暗主题</div>
        <p className="mt-1 mb-2.5 text-[11px] leading-4 text-muted-foreground">
          「跟随系统」随 Windows 深浅色自动切换。
        </p>
        <div className="grid grid-cols-3 gap-1" role="radiogroup" aria-label="明暗主题">
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
          界面强调色（按钮、选中态、焦点框等），选择后立即生效。想要预设之外的颜色，点「自定义」用取色器任选。
          终端配色请到左侧「终端」中单独设置。
        </p>
        <div className="grid grid-cols-3 gap-1" role="radiogroup" aria-label="配色方案">
          {COLOR_THEMES.map((preset) => {
            const active = preferences.colorTheme === preset.id
            return (
              <button
                key={preset.id}
                role="radio"
                aria-checked={active}
                title={preset.label}
                onClick={() => void setColorTheme(preset.id)}
                className={cn(TILE_CLASS, active ? TILE_ACTIVE_CLASS : TILE_IDLE_CLASS)}
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
          {/* 自定义：取色器直接以这块色板为触发器，选中后走 custom 配色 */}
          <ColorPicker
            value={customColor}
            disabledAlpha
            onChangeComplete={(color) => void setColorTheme('custom', color.toHexString())}
          >
            <button
              type="button"
              role="radio"
              aria-checked={customActive}
              title="自定义强调色"
              className={cn(TILE_CLASS, customActive ? TILE_ACTIVE_CLASS : TILE_IDLE_CLASS)}
            >
              <span
                className="size-4 shrink-0 rounded-full border border-border/60"
                style={{ background: customColor }}
              />
              <span className="min-w-0 flex-1 truncate text-left">自定义</span>
              {customActive && <Check className="size-3.5 shrink-0 text-primary" />}
            </button>
          </ColorPicker>
        </div>
      </div>
    </div>
  )
}
