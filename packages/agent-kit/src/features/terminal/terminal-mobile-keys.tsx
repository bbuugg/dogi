/**
 * 手机端虚拟键盘缺修饰键 / 功能键：底部快捷键条的「粘连修饰键」与按键合成。
 *
 * 从 `TerminalPanel` 拆出来的原因很单纯：这些是**纯函数 + 一个无状态按钮**，
 * 跟终端的会话生命周期、PTY、xterm 实例毫无关系。
 */
import { cn } from '@fizz/agent-kit/shared/lib/utils'

/** 手机端虚拟键盘缺修饰键 / 功能键：底部快捷键条用的「粘连」修饰键状态。 */
export type ModsState = { ctrl: boolean; alt: boolean; shift: boolean; meta: boolean }

export const NO_MODS: ModsState = { ctrl: false, alt: false, shift: false, meta: false }

/** xterm 修饰参数：1 + shift(1) + alt(2) + ctrl(4) + meta(8) */
function modParam(m: ModsState): number {
  return 1 + (m.shift ? 1 : 0) + (m.alt ? 2 : 0) + (m.ctrl ? 4 : 0) + (m.meta ? 8 : 0)
}

/** 功能键在带修饰键时的转义序列（无修饰走 xterm 默认短序列） */
export function specialSeq(token: string, m: ModsState): string {
  const p = modParam(m)
  switch (token) {
    case 'Tab':
      return m.alt ? `\x1b\t` : '\t'
    case 'Escape':
      return '\x1b'
    case 'ArrowUp':
      return p === 1 ? '\x1b[A' : `\x1b[1;${p}A`
    case 'ArrowDown':
      return p === 1 ? '\x1b[B' : `\x1b[1;${p}B`
    case 'ArrowRight':
      return p === 1 ? '\x1b[C' : `\x1b[1;${p}C`
    case 'ArrowLeft':
      return p === 1 ? '\x1b[D' : `\x1b[1;${p}D`
    case 'Home':
      return p === 1 ? '\x1b[H' : `\x1b[1;${p}H`
    case 'End':
      return p === 1 ? '\x1b[F' : `\x1b[1;${p}F`
    case 'PageUp':
      return p === 1 ? '\x1b[5~' : `\x1b[5;${p}~`
    case 'PageDown':
      return p === 1 ? '\x1b[6~' : `\x1b[6;${p}~`
    case 'Delete':
      return p === 1 ? '\x1b[3~' : `\x1b[3;${p}~`
    default:
      return ''
  }
}

/** 软键盘字符套上粘连修饰键：Ctrl 清高位成控制字符，Alt 前缀 ESC。 */
export function transformChar(data: string, m: ModsState): string {
  if (data.length !== 1) return data
  const code = data.charCodeAt(0)
  let out = data
  if (m.ctrl) out = String.fromCharCode(code & 0x1f)
  if (m.alt) out = `\x1b${out}`
  return out
}

export const hasAnyMod = (m: ModsState): boolean => m.ctrl || m.alt || m.shift || m.meta

/** 手机端底部快捷键条上的单个键（粘连修饰键高亮） */
export function MobileKey({
  label,
  active,
  onClick,
  ariaLabel
}: {
  label: string
  active?: boolean
  onClick: () => void
  ariaLabel?: string
}) {
  return (
    <button
      type="button"
      aria-label={ariaLabel ?? label}
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'flex h-8 w-full min-w-0 select-none items-center justify-center rounded border px-0.5 text-xs font-medium transition-colors',
        active
          ? 'border-primary bg-primary text-primary-foreground'
          : 'border-border bg-background text-foreground hover:bg-accent active:bg-accent/70'
      )}
    >
      {label}
    </button>
  )
}
