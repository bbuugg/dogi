import type { AppShortcutAction, ShortcutConfig } from './types'

/** 每个快捷键动作的可读元信息（主进程与渲染进程共用，保证标签一致） */
export interface ShortcutActionMeta {
  action: AppShortcutAction
  label: string
  /** 缺省 accelerator；空字符串表示默认禁用 */
  defaultAccelerator: string
}

/**
 * 可配置的动作清单。新增动作时在此登记，并在渲染端 `runShortcutAction` 分发处接线即可。
 * 默认 accelerator 全部使用 `CommandOrControl` 以跨平台（mac=⌘、Win/Linux=Ctrl）。
 *
 * 注意这些是**应用内**快捷键：由渲染端在 window 上监听 keydown 匹配（见 `findShortcutByEvent`），
 * 不走 Electron 的 globalShortcut，因此不会占用系统级热键。
 */
export const SHORTCUT_ACTIONS: ShortcutActionMeta[] = [
  { action: 'new-session', label: '新建终端', defaultAccelerator: 'CommandOrControl+Alt+T' },
  { action: 'open-command-palette', label: '打开命令面板', defaultAccelerator: 'CommandOrControl+Shift+P' },
  { action: 'open-settings', label: '打开设置', defaultAccelerator: 'CommandOrControl+Alt+S' },
  {
    action: 'toggle-agent-terminal',
    label: '开关 AI Agent 终端',
    // 终端类应用里 Ctrl/Cmd+Shift+` 已经成了「开关内嵌终端」的事实标准（VS Code 同款）
    defaultAccelerator: 'CommandOrControl+Shift+`'
  },
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
    const key = normalizeAccelerator(s.accelerator)
    count.set(key, (count.get(key) ?? 0) + 1)
  }
  const conflicted = new Set<AppShortcutAction>()
  for (const s of shortcuts) {
    if (s.accelerator && (count.get(normalizeAccelerator(s.accelerator)) ?? 0) > 1) {
      conflicted.add(s.action)
    }
  }
  return conflicted
}

// ---------- 应用内快捷键的匹配 ----------
// 快捷键不再是系统级 globalShortcut（会占用系统热键），改由渲染端在 window 上监听 keydown
// 自己匹配，所以「把按键事件转成 accelerator」和「比较 accelerator」这套逻辑要放在共享层：
// 设置页录制时用它生成 accelerator，运行时分发时用同一套逻辑比较，两边不可能对不上。

/**
 * 参与匹配的按键事件（结构化类型，不依赖 DOM 的 KeyboardEvent）。
 *
 * 共享层同时被主进程（`lib: ["ES2023"]`，没有 DOM）与渲染端编译，
 * 所以这里不能用 `KeyboardEvent` —— 真实的 KeyboardEvent 结构上满足它，可直接传进来。
 */
export interface KeyComboEvent {
  /** 物理键位，如 KeyA / Digit1 / F5 / ArrowUp */
  code: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  shiftKey: boolean
}

/** 把 `KeyboardEvent.code` 转成 accelerator 里的键名（认不出返回 null） */
export function keyFromEventCode(code: string): string | null {
  let m: RegExpMatchArray | null
  if ((m = code.match(/^Key([A-Z])$/))) return m[1]
  if ((m = code.match(/^Digit([0-9])$/))) return m[1]
  if ((m = code.match(/^Numpad([0-9])$/))) return m[1]
  if (/^F([0-9]{1,2})$/.test(code)) return code
  const map: Record<string, string> = {
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    Space: 'Space',
    Enter: 'Enter',
    Tab: 'Tab',
    // 反引号：`Ctrl/Cmd+Shift+``（AI Agent 终端开关默认键）。用 code 而不是 key，
    // 所以 Shift 下的 `~` 也照样认成反引号
    Backquote: '`',
    Backspace: 'Backspace',
    Delete: 'Delete',
    Home: 'Home',
    End: 'End',
    PageUp: 'PageUp',
    PageDown: 'PageDown',
    Insert: 'Insert'
  }
  return map[code] ?? null
}

/** 把一次按键事件转成 accelerator（跨平台用 CommandOrControl）；认不出返回 null */
export function acceleratorFromEvent(e: KeyComboEvent): string | null {
  const mods: string[] = []
  if (e.metaKey || e.ctrlKey) mods.push('CommandOrControl')
  if (e.altKey) mods.push('Alt')
  if (e.shiftKey) mods.push('Shift')
  const key = keyFromEventCode(e.code)
  if (!key) return null
  return [...mods, key].join('+')
}

/**
 * 把 accelerator 归一化成可比较的规范形式：`mod+alt+shift+键`。
 *
 * 需要归一是因为同一个组合有多种合法写法（`CommandOrControl` / `CmdOrCtrl` / `Ctrl`，
 * `Alt` / `Option`），而比较时必须一视同仁。`CommandOrControl` 与 `Ctrl`/`Cmd`
 * 统一成 `mod` 是刻意的：本应用只生成 `CommandOrControl`，这样 Mac 上的 ⌘ 与
 * 手写配置里的 Ctrl 才能落到同一个槽位。
 */
export function normalizeAccelerator(accelerator: string): string {
  const mods = new Set<string>()
  let key = ''
  for (const raw of accelerator.split('+')) {
    const p = raw.trim()
    if (!p) continue
    switch (p.toLowerCase()) {
      case 'commandorcontrol':
      case 'cmdorctrl':
      case 'command':
      case 'cmd':
      case 'control':
      case 'ctrl':
      case 'meta':
      case 'super':
        mods.add('mod')
        break
      case 'alt':
      case 'option':
        mods.add('alt')
        break
      case 'shift':
        mods.add('shift')
        break
      default:
        key = p.toUpperCase()
    }
  }
  const parts: string[] = []
  if (mods.has('mod')) parts.push('mod')
  if (mods.has('alt')) parts.push('alt')
  if (mods.has('shift')) parts.push('shift')
  if (key) parts.push(key)
  return parts.join('+')
}

/**
 * 这个 accelerator 是否适合作为**应用内**快捷键。
 *
 * 纯字母 / 数字组合（既没有 Ctrl/Alt，也不是功能键）不能用：应用内匹配是「命中就吃掉这个按键」，
 * 绑一个裸字母会让它在终端、编辑器里彻底打不出来。
 * （以前走系统级 globalShortcut 时这类组合本来就注册不上，所以没有这个问题；
 * 改成应用内匹配后必须自己挡住。）
 * 空字符串表示「禁用」，视为合法。
 */
export function isUsableAccelerator(accelerator: string): boolean {
  if (!accelerator.trim()) return true
  const parts = normalizeAccelerator(accelerator).split('+')
  const key = parts[parts.length - 1] ?? ''
  // 功能键可以不带修饰键（F5 之类）；其余必须带 Ctrl/Alt
  if (/^F([0-9]{1,2})$/.test(key)) return true
  return parts.includes('mod') || parts.includes('alt')
}

/**
 * 找出某个按键事件命中的快捷键配置（未命中返回 null）。
 * 空 accelerator 表示该动作被禁用；不适合作应用内快捷键的组合（裸字母等）也直接跳过。
 */
export function findShortcutByEvent(
  shortcuts: ShortcutConfig[],
  e: KeyComboEvent
): ShortcutConfig | null {
  const acc = acceleratorFromEvent(e)
  if (!acc) return null
  const target = normalizeAccelerator(acc)
  return (
    shortcuts.find(
      (s) =>
        s.accelerator &&
        isUsableAccelerator(s.accelerator) &&
        normalizeAccelerator(s.accelerator) === target
    ) ?? null
  )
}
