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
    // 用 Ctrl/Cmd+`（单反引号）：Ctrl/Cmd+Shift+` 在笔记编辑器里被 Typora 风格的行内代码
    // 占用了（应用内快捷键在捕获阶段监听 window，会抢在编辑器前面吃掉按键，两者不能同键）。
    defaultAccelerator: 'CommandOrControl+`'
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

// ---------- 笔记编辑器（Milkdown / Crepe）内的快捷键 ----------
// 这一组键由编辑器自己的 keymap 处理、只在正文聚焦时生效，**不属于**上面那套可配置的
// 应用内快捷键（拿应用层的改键机制去接管会把编辑器搞乱）。本清单是唯一数据源：
// 「?」帮助浮层与设置页都从这里渲染；`key` 同时被 `features/notes/MilkdownEditor.tsx`
// 映射到具体命令。

/** 「?」浮层与设置页共用的一条编辑器快捷键 */
export interface EditorShortcut {
  /** 分组标题 */
  group: string
  label: string
  /** Milkdown/prosemirror 键名（`Mod-` = Mac ⌘、其它平台 Ctrl）；给了它就用于注册与展示 */
  key?: string
  /** 编辑器内置键的说明文本（不走键名注册），支持 {mod} / {alt} / {shift} 占位符 */
  keys?: string
}

/** prosemirror 键名里的修饰键 → accelerator 里的写法 */
const EDITOR_KEY_MODIFIERS: Record<string, string> = {
  mod: 'CommandOrControl',
  cmd: 'CommandOrControl',
  command: 'CommandOrControl',
  meta: 'CommandOrControl',
  ctrl: 'Ctrl',
  control: 'Ctrl',
  alt: 'Alt',
  option: 'Alt',
  shift: 'Shift'
}

/**
 * 把 prosemirror 键名（``Mod-Shift-` ``）转成 Electron accelerator（``CommandOrControl+Shift+` ``），
 * 再由 `formatShortcutForPlatform` 按平台渲染。**仅用于展示**，不要拿它去注册按键。
 *
 * 切分方式与 prosemirror-keymap 的 `normalizeKeyName` 一致：末尾那段是主键，前面的都是修饰键
 * （注意 `Mod--` 这种主键本身是连字符的情况，靠 `(?!$)` 保住最后一段）。
 */
export function editorKeyToAccelerator(key: string): string {
  const parts = key.split(/-(?!$)/)
  const main = parts[parts.length - 1] ?? ''
  const mods: string[] = []
  for (const raw of parts.slice(0, -1)) {
    const mod = EDITOR_KEY_MODIFIERS[raw.toLowerCase()]
    if (mod && !mods.includes(mod)) mods.push(mod)
  }
  // 展示时单字母主键统一大写，读起来才像按键；注册用的键名仍写小写字母
  const name = /^[a-z]$/i.test(main) ? main.toUpperCase() : main
  return [...mods, name].join('+')
}

/** 把一条编辑器快捷键渲染成当前平台可读的按键文本（Mac 用 ⌘⌥⇧，其它平台用 Ctrl/Alt/Shift） */
export function formatEditorShortcut(item: EditorShortcut, platform: string): string {
  if (item.key) return formatShortcutForPlatform(editorKeyToAccelerator(item.key), platform)
  const isMac = platform === 'darwin'
  return (item.keys ?? '')
    .replace(/\{mod\}/g, isMac ? '⌘' : 'Ctrl')
    .replace(/\{alt\}/g, isMac ? '⌥' : 'Alt')
    .replace(/\{shift\}/g, isMac ? '⇧' : 'Shift')
}

/**
 * 笔记编辑器快捷键清单（键位对齐 Typora 官方快捷键表）。
 *
 * 只列 Typora 官方**有**的键位；`key` 那几条约等于 Milkdown 默认之外的补充绑定，
 * 具体命令在 `MilkdownEditor.tsx` 的 `TYPORA_KEYMAP` 里一一对应。
 */
export const EDITOR_SHORTCUTS: EditorShortcut[] = [
  { group: '行内格式', label: '加粗', key: 'Mod-b' },
  { group: '行内格式', label: '斜体', key: 'Mod-i' },
  { group: '行内格式', label: '删除线', key: 'Alt-Shift-5' },
  // 行内代码是 non-inclusive mark：必须先选中文字再按，光按键不打字（与 VS Code 一致）
  { group: '行内格式', label: '行内代码（先选中文字）', key: 'Mod-Shift-`' },
  { group: '行内格式', label: '超链接', key: 'Mod-k' },

  { group: '段落与块', label: '标题 1–6', keys: '{mod}+1 … {mod}+6' },
  { group: '段落与块', label: '变回正文', key: 'Mod-0' },
  { group: '段落与块', label: '提升标题级别', key: 'Mod-=' },
  { group: '段落与块', label: '降低标题级别', key: 'Mod--' },
  { group: '段落与块', label: '引用', key: 'Mod-Shift-q' },
  { group: '段落与块', label: '代码块', key: 'Mod-Shift-k' },

  { group: '列表与表格', label: '无序列表', key: 'Mod-Shift-]' },
  { group: '列表与表格', label: '有序列表', key: 'Mod-Shift-[' },
  { group: '列表与表格', label: '表格', key: 'Mod-t' },
  { group: '列表与表格', label: '图片', key: 'Mod-Shift-i' },
  { group: '列表与表格', label: '数学块', key: 'Mod-Shift-m' },

  { group: '其它', label: '列表缩进', keys: 'Tab' },
  { group: '其它', label: '减少列表缩进', keys: '{shift}+Tab' },
  { group: '其它', label: '软换行（行内换行）', keys: '{shift}+Enter' },
  { group: '其它', label: '撤销', key: 'Mod-z' },
  { group: '其它', label: '重做', key: 'Mod-y' }
]

/** 按 `group` 切好的清单（保持上面的先后顺序），供设置页与「?」浮层按分组渲染 */
export const EDITOR_SHORTCUT_GROUPS: Array<{ name: string; items: EditorShortcut[] }> =
  EDITOR_SHORTCUTS.reduce<Array<{ name: string; items: EditorShortcut[] }>>((groups, item) => {
    const last = groups[groups.length - 1]
    if (last?.name === item.group) last.items.push(item)
    else groups.push({ name: item.group, items: [item] })
    return groups
  }, [])

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
