import { useEffect, useState } from 'react'
import { AlertTriangle, RotateCcw } from 'lucide-react'
import type { AppShortcutAction } from '@shared/types'
import {
  SHORTCUT_ACTIONS,
  acceleratorFromEvent,
  findShortcutConflicts,
  formatShortcutForPlatform,
  isUsableAccelerator,
  shortcutLabel
} from '@shared/shortcuts'
import { useAppStore } from '@/stores/app-store'
import { Modal, Button, message } from 'antd'
import { cn } from 'cn'

export function ShortcutSettings() {
  const shortcuts = useAppStore((s) => s.shortcuts)
  const saveShortcuts = useAppStore((s) => s.saveShortcuts)
  const setShortcutRecording = useAppStore((s) => s.setShortcutRecording)
  const platform = window.api.app.platform
  const [recording, setRecording] = useState<AppShortcutAction | null>(null)

  // 进入/退出录制时挂起应用内快捷键分发：分发监听器注册得比这里早，
  // 不挂起的话按下的组合会**既被录进去、又把动作执行一遍**。
  // 退出时无论成功 / 取消 / 改选都恢复。
  useEffect(() => {
    if (!recording) return
    setShortcutRecording(true)
    return () => setShortcutRecording(false)
  }, [recording, setShortcutRecording])

  // 捕获模式：在 window 上监听 keydown，组成 accelerator 后写入并退出捕获。
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
        const action = recording
        const oldAccel = useAppStore.getState().shortcuts.find((s) => s.action === action)?.accelerator ?? ''
        setRecording(null)
        // 清除快捷键是破坏性操作，弹二次确认
        Modal.confirm({
          title: '确认清除快捷键',
          content: `确定要清除「${shortcutLabel(action)}」的快捷键${
            oldAccel ? `（当前：${formatShortcutForPlatform(oldAccel, platform)}）` : ''
          }吗？`,
          centered: true,
          okText: '清除',
          okType: 'danger',
          cancelText: '取消',
          onOk: () => {
            const cur = useAppStore.getState().shortcuts
            void useAppStore
              .getState()
              .saveShortcuts(cur.map((s) => (s.action === action ? { ...s, accelerator: '' } : s)))
              .then(() => message.info(`已清除「${shortcutLabel(action)}」快捷键`))
          }
        })
        return
      }
      const acc = acceleratorFromEvent(e)
      if (!acc) return
      // 裸字母 / 数字在应用内匹配下会把该键整个吃掉（终端里再也打不出这个字母），
      // 所以这里不收，提示用户重录而不是默默存下一个会坏事的值。
      if (!isUsableAccelerator(acc)) {
        message.warning('请至少带上 Ctrl 或 Alt（F1–F12 这类功能键可以单独使用）')
        return
      }
      const action = recording
      const oldAccel = useAppStore
        .getState()
        .shortcuts.find((s) => s.action === action)?.accelerator ?? ''
      setRecording(null)
      // 修改快捷键前弹二次确认，显示将要设的新值与旧值
      Modal.confirm({
        title: '确认修改快捷键',
        centered: true,
        content: (
          <div>
            <p>
              「{shortcutLabel(action)}」
              {oldAccel
                ? ` 当前为 ${formatShortcutForPlatform(oldAccel, platform)}`
                : ' 当前未绑定'}
              ，是否将其修改为{' '}
              <span className="font-medium">{formatShortcutForPlatform(acc, platform)}</span>？
            </p>
          </div>
        ),
        okText: '修改',
        cancelText: '取消',
        onOk: () => {
          const cur = useAppStore.getState().shortcuts
          void useAppStore
            .getState()
            .saveShortcuts(cur.map((s) => (s.action === action ? { ...s, accelerator: acc } : s)))
            .then(() =>
              message.success(
                `「${shortcutLabel(action)}」已设为 ${formatShortcutForPlatform(acc, platform)}`
              )
            )
        }
      })
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [recording, platform])

  const conflicts = findShortcutConflicts(shortcuts)
  const conflictList = SHORTCUT_ACTIONS.filter((a) => conflicts.has(a.action))

  return (
    <div className="space-y-4">
      <p className="text-xs leading-4 text-muted-foreground">
        应用内快捷键：仅在 Dogi 窗口处于前台时生效，<span className="font-medium">不占用系统级热键</span>
        ，也不会与其它程序抢组合键。含{' '}
        <code className="rounded bg-secondary px-1">CommandOrControl</code> 的组合在 Mac 上为 ⌘、Windows/Linux
        上为 Ctrl。
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
                    'mt-0.5 text-xs',
                    isConflict ? 'text-destructive' : 'text-muted-foreground'
                  )}
                >
                  {isConflict
                    ? '该组合与其它动作冲突'
                    : accelerator
                      ? '应用内生效（窗口在前台时）'
                      : '未绑定：该动作被禁用'}
                </div>
              </div>
              <Button
                onClick={() => setRecording(isRecording ? null : meta.action)}
                title={accelerator || undefined}
                color={isRecording ? 'primary' : isConflict ? 'danger' : 'default'}
                variant={isRecording ? 'filled' : 'dashed'}
                className="shrink-0 px-3 text-[12px] font-medium tabular-nums"
              >
                {isRecording ? '按下按键组合…（Esc 取消）' : display || '点击设置'}
              </Button>
            </div>
          )
        })}
      </div>

      <div className="flex justify-end">
        <Button
          size="small"
          type='text'
          icon={<RotateCcw className="size-3.5" />}
          onClick={() =>
            void saveShortcuts(
              SHORTCUT_ACTIONS.map((a) => ({ action: a.action, accelerator: a.defaultAccelerator }))
            ).then(() => message.success('已恢复默认快捷键'))
          }
        >
          恢复默认
        </Button>
      </div>
    </div>
  )
}
