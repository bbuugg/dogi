import { Bot, Keyboard, SlidersHorizontal, TerminalSquare } from 'lucide-react'
import { Modal } from 'antd'
import { useAppStore } from '@/stores/app-store'
import { cn } from 'cn'
import { AiConfigSettings } from '@/components/settings/AiConfigSettings'
import { TerminalSettings } from '@/components/settings/TerminalSettings'
import { PrefSettings } from '@/components/settings/PrefSettings'
import { ShortcutSettings } from '@/components/settings/ShortcutSettings'

type SettingsTab = 'ai' | 'terminal' | 'prefs' | 'shortcuts'

const MENU: Array<{
  value: SettingsTab
  label: string
  desc: string
  icon: typeof Bot
}> = [
  { value: 'prefs', label: '偏好', desc: '应用主题', icon: SlidersHorizontal },
  { value: 'terminal', label: '终端', desc: '配色与外观', icon: TerminalSquare },
  { value: 'shortcuts', label: '快捷键', desc: '全局快捷键设置', icon: Keyboard },
  { value: 'ai', label: 'AI 配置', desc: '模型、MCP 服务与提示词', icon: Bot },
]

export function SettingsDialog() {
  const settingsOpen = useAppStore((s) => s.ui.settingsOpen)
  const settingsTab = useAppStore((s) => s.ui.settingsTab) as SettingsTab
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen)

  return (
    <Modal
      open={settingsOpen}
      onCancel={() => setSettingsOpen(false)}
      title="设置"
      footer={null}
      centered
      width={880}
      destroyOnHidden
      // 弹窗高度固定在 62vh：header 由 antd 固定，body 收内容并内部滚动（无滚动条）
      styles={{
        container: { height: '62vh', minHeight: 380, display: 'flex', flexDirection: 'column' },
        body: { flex: 1, minHeight: 0, padding: 0 }
      }}
      classNames={{ body: 'no-scrollbar' }}
    >
      <div className="flex h-full min-h-0">
        {/* 左侧菜单 */}
        <nav className="no-scrollbar w-44 shrink-0 space-y-1 overflow-y-auto border-r border-border py-3">
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
        <div className="no-scrollbar min-w-0 flex-1 overflow-y-auto p-5">
          {settingsTab === 'ai' && <AiConfigSettings />}
          {settingsTab === 'terminal' && <TerminalSettings />}
          {settingsTab === 'prefs' && <PrefSettings />}
          {settingsTab === 'shortcuts' && <ShortcutSettings />}
        </div>
      </div>
    </Modal>
  )
}
