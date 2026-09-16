import { useEffect, useState } from 'react'
import { AlertTriangle, RotateCcw } from 'lucide-react'
import type { AppShortcutAction } from '@shared/types'
import {
  SHORTCUT_ACTIONS,
  findShortcutConflicts,
  formatShortcutForPlatform,
  shortcutLabel
} from '@shared/shortcuts'
import { useAppStore } from '@/stores/app-store'
import { toast } from 'sonner'
import { cn } from 'cn'
import { Button } from '@/components/ui/button'

/** 把一次键盘事件转成 Electron accelerator（跨平台用 CommandOrControl） */
function eventToAccelerator(e: KeyboardEvent): string | null {
  const mods: string[] = []
  if (e.metaKey || e.ctrlKey) mods.push('CommandOrControl')
  if (e.altKey) mods.push('Alt')
  if (e.shiftKey) mods.push('Shift')
  const key = keyFromEvent(e)
  if (!key) return null
  return [...mods, key].join('+')
}

function keyFromEvent(e: KeyboardEvent): string | null {
  const code = e.code
  let m: RegExpMatchArray | null
  if ((m = code.match(/^Key([A-Z])$/))) return m[1]
  if ((m = code.match(/^Digit([0-9])$/))) return m[1]
  if ((m = code.match(/^Numpad([0-9])$/))) return m[1]
  if ((m = code.match(/^F([0-9]{1,2})$/))) return code
  const map: Record<string, string> = {
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    Space: 'Space',
    Enter: 'Enter',
    Tab: 'Tab',
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

export function ShortcutSettings() {
  const shortcuts = useAppStore((s) => s.shortcuts)
  const saveShortcuts = useAppStore((s) => s.saveShortcuts)
  const platform = window.api.app.platform
  const [recording, setRecording] = useState<AppShortcutAction | null>(null)

  // 进入/退出录制时挂起系统级快捷键，避免已注册的全局快捷键（如 Ctrl+Alt+T）
  // 抢先触发动作、干扰录制。退出时无论成功/取消/改选都恢复注册。
  useEffect(() => {
    if (!recording) return
    void window.api.shortcuts.setCapture(true)
    return () => {
      void window.api.shortcuts.setCapture(false)
    }
  }, [recording])

  // 捕获模式：监听全局 keydown，组成 accelerator 后写入并退出捕获。
  // 直接读 store 最新状态，避免闭包拿到过期的 shortcuts。
  useEffect(() => {
    if (!recording) return
    const handler = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (e.code === 'Escape') {
        setRecording(null)
        return
      }
      if (e.code === 'Backspace' || e.code === 'Delete') {
        const cur = useAppStore.getState().shortcuts
        void useAppStore
          .getState()
          .saveShortcuts(cur.map((s) => (s.action === recording ? { ...s, accelerator: '' } : s)))
          .then(() => toast(`已清除「${shortcutLabel(recording)}」快捷键`))
        setRecording(null)
        return
      }
      const acc = eventToAccelerator(e)
      if (acc) {
        const cur = useAppStore.getState().shortcuts
        void useAppStore
          .getState()
          .saveShortcuts(cur.map((s) => (s.action === recording ? { ...s, accelerator: acc } : s)))
          .then(() =>
            toast.success(
              `「${shortcutLabel(recording)}」已设为 ${formatShortcutForPlatform(acc, window.api.app.platform)}`
            )
          )
        setRecording(null)
      }
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [recording])

  const conflicts = findShortcutConflicts(shortcuts)
  const conflictList = SHORTCUT_ACTIONS.filter((a) => conflicts.has(a.action))

  return (
    <div className="space-y-4">
      <p className="text-[11px] leading-4 text-muted-foreground">
        全局快捷键：即使窗口最小化或隐藏到系统托盘，按下后也会立即显示在前台并执行对应操作。
        含 <code className="rounded bg-secondary px-1">CommandOrControl</code> 的组合在 Mac 上为 ⌘、Windows/Linux 上为 Ctrl。
      </p>

      {conflictList.length > 0 && (
        <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[12px] text-destructive">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <span>
            存在冲突的快捷键（同一组合被多个动作占用，仅其中一个会生效）：
            <span className="ml-1 font-medium">
              {conflictList.map((a) => shortcutLabel(a.action)).join('、')}
            </span>
          </span>
        </div>
      )}

      <div className="divide-y divide-border/60 rounded-md border border-border/60">
        {SHORTCUT_ACTIONS.map((meta) => {
          const cfg = shortcuts.find((s) => s.action === meta.action)
          const accelerator = cfg?.accelerator ?? ''
          const isRecording = recording === meta.action
          const isConflict = conflicts.has(meta.action)
          const display = formatShortcutForPlatform(accelerator, platform)
          return (
            <div
              key={meta.action}
              className={cn(
                'flex items-center justify-between gap-4 px-3 py-2.5',
                isConflict && 'bg-destructive/5'
              )}
            >
              <div className="min-w-0">
                <div className="text-[13px] font-medium">{meta.label}</div>
                <div
                  className={cn(
                    'mt-0.5 text-[11px]',
                    isConflict ? 'text-destructive' : 'text-muted-foreground'
                  )}
                >
                  {isConflict
                    ? '该组合与其它动作冲突'
                    : accelerator
                      ? '全局生效（系统级）'
                      : '未绑定：该动作被禁用'}
                </div>
              </div>
              <Button
                type="button"
                variant="ghost"
                onClick={() => setRecording(isRecording ? null : meta.action)}
                title={accelerator || undefined}
                className={cn(
                  'shrink-0 rounded-md border px-3 py-1.5 text-[12px] font-medium tabular-nums transition-colors',
                  isRecording
                    ? 'bg-primary/10 text-primary'
                    : isConflict
                      ? 'text-destructive'
                      : 'text-foreground hover:bg-secondary'
                )}
              >
                {isRecording ? '按下按键组合…（Esc 取消）' : display || '点击设置'}
              </Button>
            </div>
          )
        })}
      </div>

      <div className="flex justify-end">
        <button
          type="button"
          onClick={() =>
            void saveShortcuts(
              SHORTCUT_ACTIONS.map((a) => ({ action: a.action, accelerator: a.defaultAccelerator }))
            ).then(() => toast.success('已恢复默认快捷键'))
          }
          className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-[12px] text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
        >
          <RotateCcw className="size-3.5" />
          恢复默认
        </button>
      </div>
    </div>
  )
}
