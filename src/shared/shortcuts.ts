import type { AppShortcutAction, ShortcutConfig } from './types'

/** 每个快捷键动作的可读元信息（主进程与渲染进程共用，保证标签一致） */
export interface ShortcutActionMeta {
  action: AppShortcutAction
  label: string
  /** 缺省 accelerator；空字符串表示默认禁用 */
  defaultAccelerator: string
}

/**
 * 可配置的动作清单。新增动作时在此登记，并在渲染端 onShortcut 分发处接线即可。
 * 默认 accelerator 全部使用 `CommandOrControl` 以跨平台（mac=⌘、Win/Linux=Ctrl）。
 */
export const SHORTCUT_ACTIONS: ShortcutActionMeta[] = [
  { action: 'new-session', label: '新建终端', defaultAccelerator: 'CommandOrControl+Alt+T' },
  { action: 'open-command-palette', label: '打开命令面板', defaultAccelerator: 'CommandOrControl+Shift+P' },
  { action: 'open-settings', label: '打开设置', defaultAccelerator: 'CommandOrControl+Alt+S' },
  { action: 'open-scripts', label: '打开脚本页', defaultAccelerator: 'CommandOrControl+Alt+K' },
  { action: 'toggle-ai-panel', label: '切换当前终端页面的 AI 助手', defaultAccelerator: '' }
]

/** 缺省快捷键（首次启动 / 恢复默认时使用） */
export const DEFAULT_SHORTCUTS: ShortcutConfig[] = SHORTCUT_ACTIONS.map((a) => ({
  action: a.action,
  accelerator: a.defaultAccelerator
}))

export function shortcutLabel(action: AppShortcutAction): string {
  return SHORTCUT_ACTIONS.find((a) => a.action === action)?.label ?? action
}

/**
 * 把 Electron accelerator 转成当前平台可读的展示文本。
 * mac 用符号（⌘⌥⇧），Win/Linux 用文字（Ctrl+Alt+Shift）。
 */
export function formatShortcutForPlatform(accelerator: string, platform: string): string {
  if (!accelerator) return ''
  const isMac = platform === 'darwin'
  const parts = accelerator.split('+').map((p) => p.trim())
  const mapped = parts.map((p) => {
    switch (p) {
      case 'CommandOrControl':
      case 'CmdOrCtrl':
        return isMac ? '⌘' : 'Ctrl'
      case 'Cmd':
      case 'Command':
        return '⌘'
      case 'Ctrl':
        return isMac ? '⌃' : 'Ctrl'
      case 'Alt':
        return isMac ? '⌥' : 'Alt'
      case 'Option':
        return '⌥'
      case 'Shift':
        return isMac ? '⇧' : 'Shift'
      case 'Super':
        return isMac ? '⌃' : 'Win'
      default:
        return p
    }
  })
  return isMac ? mapped.join('') : mapped.join('+')
}

/**
 * 找出存在冲突（相同非空的 accelerator 被多个动作占用）的动作集合。
 * 返回每个动作是否冲突，便于在 UI 中逐行高亮。
 */
export function findShortcutConflicts(shortcuts: ShortcutConfig[]): Set<AppShortcutAction> {
  const count = new Map<string, number>()
  for (const s of shortcuts) {
    if (!s.accelerator) continue
    count.set(s.accelerator, (count.get(s.accelerator) ?? 0) + 1)
  }
  const conflicted = new Set<AppShortcutAction>()
  for (const s of shortcuts) {
    if (s.accelerator && (count.get(s.accelerator) ?? 0) > 1) conflicted.add(s.action)
  }
  return conflicted
}
