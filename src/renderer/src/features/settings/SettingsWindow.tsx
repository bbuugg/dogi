import {
  Bot,
  Cpu,
  Keyboard,
  MessageSquareText,
  Palette,
  Plug,
  Sparkles,
  TerminalSquare,
  Timer,
  X,
  type LucideIcon
} from 'lucide-react'
import { useState } from 'react'
import { PrefSettings } from './PrefSettings'
import { TerminalSettings } from './TerminalSettings'
import { ShortcutSettings } from './ShortcutSettings'
import { ModelSettings } from './ModelSettings'
import { AcpAgentSettings } from './AcpAgentSettings'
import { McpSettings } from './McpSettings'
import { SkillsSettings } from './SkillsSettings'
import { SystemPromptSettings } from './SystemPromptSettings'
import { TimeoutSettings } from './TimeoutSettings'
import { cn } from 'cn'

type SettingsTab =
  | 'prefs'
  | 'shortcuts'
  | 'terminal'
  | 'models'
  | 'acp'
  | 'mcp'
  | 'skills'
  | 'timeouts'
  | 'prompt'

const ALL_TABS: SettingsTab[] = [
  'prefs',
  'shortcuts',
  'terminal',
  'models',
  'acp',
  'mcp',
  'skills',
  'timeouts',
  'prompt'
]

/** 分组菜单：按「用户想干什么」分组，不按内部模块（参考 fishwork 设置） */
const GROUPS: Array<{
  title: string
  items: Array<{ value: SettingsTab; label: string; icon: LucideIcon }>
}> = [
  {
    title: '基础',
    items: [
      { value: 'prefs', label: '偏好', icon: Palette },
      { value: 'shortcuts', label: '快捷键', icon: Keyboard }
    ]
  },
  {
    title: '终端',
    items: [{ value: 'terminal', label: '终端', icon: TerminalSquare }]
  },
  {
    title: 'AI',
    items: [
      { value: 'models', label: '模型配置', icon: Cpu },
      { value: 'acp', label: 'ACP agent', icon: Bot },
      { value: 'mcp', label: 'MCP 服务', icon: Plug },
      { value: 'skills', label: '技能', icon: Sparkles },
      { value: 'timeouts', label: '超时', icon: Timer },
      { value: 'prompt', label: '系统提示词', icon: MessageSquareText }
    ]
  }
]

/** 历史深链兼容：原「AI 配置」整页在拆分成子项后落到模型配置 */
const LEGACY: Record<string, SettingsTab> = { ai: 'models' }

/**
 * 独立设置窗口的全页内容（由 main/index.ts 的 `?window=settings` 加载）。
 *
 * 不再用 Modal，而是整窗铺满：左侧分组菜单 + 右侧内容区。顶部是带关闭按钮的
 * 自绘标题栏（与 `?window=settings` 同步隐藏了系统标题栏），标题栏为拖拽区。
 * 初始展示的标签页由查询参数 `tab` 决定（命令面板 / 各处「设置：XX」会带上）。
 */
export function SettingsWindow() {
  const [tab, setTab] = useState<SettingsTab>(() => {
    const q = new URLSearchParams(location.search).get('tab')
    if (q && (ALL_TABS as string[]).includes(q)) return q as SettingsTab
    if (q && LEGACY[q]) return LEGACY[q]
    return 'prefs'
  })
  const isMac = window.api.app.platform === 'darwin'

  return (
    <div className="flex h-screen w-screen flex-col overflow-clip bg-sidebar text-foreground">
      {/* 自绘标题栏：整条可拖拽，右侧（非 mac）放关闭按钮 */}
      <header className="app-drag flex h-9 shrink-0 items-center px-3 bg-sidebar">
        <span className="text-xs font-semibold">设置</span>
        <div className="flex-1" />
        {!isMac && (
          <button
            type="button"
            title="关闭"
            onClick={() => void window.api.window.closeSettings()}
            className="app-no-drag -mr-1 flex size-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-destructive hover:text-destructive-foreground"
          >
            <X className="size-4" />
          </button>
        )}
      </header>

      <div className="flex min-h-0 flex-1 p-2">
        {/* 左侧分组菜单 */}
        <nav className="no-scrollbar w-48 shrink-0 space-y-4 overflow-y-auto p-2 bg-sidebar">
          {GROUPS.map((group) => (
            <div key={group.title}>
              <div className="px-2 pb-1 text-xs font-medium text-muted-foreground/70">
                {group.title}
              </div>
              <div className="space-y-1">
                {group.items.map(({ value, label, icon: Icon }) => {
                  const active = tab === value
                  return (
                    <button
                      key={value}
                      type="button"
                      onClick={() => setTab(value)}
                      className={cn(
                        'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] transition-colors',
                        active
                          ? 'bg-primary/20 text-foreground'
                          : 'text-muted-foreground hover:bg-primary/10 hover:text-foreground'
                      )}
                    >
                      <Icon className="size-4 shrink-0" />
                      <span className="min-w-0 flex-1 truncate">{label}</span>
                    </button>
                  )
                })}
              </div>
            </div>
          ))}
        </nav>

        {/* 右侧内容 */}
        <div className="no-scrollbar min-w-0 flex-1 overflow-y-auto px-4 py-3 bg-background rounded-xl">
          {tab === 'prefs' && <PrefSettings />}
          {tab === 'shortcuts' && <ShortcutSettings />}
          {tab === 'terminal' && <TerminalSettings />}
          {tab === 'models' && <ModelSettings />}
          {tab === 'acp' && <AcpAgentSettings />}
          {tab === 'mcp' && <McpSettings />}
          {tab === 'skills' && <SkillsSettings />}
          {tab === 'timeouts' && <TimeoutSettings />}
          {tab === 'prompt' && <SystemPromptSettings />}
        </div>
      </div>
    </div>
  )
}
