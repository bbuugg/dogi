/**
 * 设置 → 快捷键（从根应用 `ShortcutSettings.tsx` 迁移到 shadcn）：
 * 列出所有可配置动作，点击进入录制（捕获下一次按键组合），Esc 取消、
 * Backspace/Delete 清除绑定；冲突的组合逐行高亮；支持一键恢复默认。
 *
 * 配置的持久化与分发都在宿主 AgentApp —— 这里通过 props 读写，
 * 录制期间用 onRecordingChange 通知宿主暂停全局快捷键分发。
 */
import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, RotateCcw } from 'lucide-react'
import { Button } from '@fizz/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@fizz/ui/dialog'
import { cn } from '@fizz/agent-kit/shared/lib/utils'
import {
  AGENT_SHORTCUT_ACTIONS,
  acceleratorFromEvent,
  findShortcutConflicts,
  formatShortcut,
  isUsableAccelerator,
  shortcutLabel,
  type AgentShortcutAction,
  type AgentShortcutConfig
} from '@fizz/agent-kit/shared/lib/shortcuts'
import { getAgentHost } from '@fizz/agent-client/host'
import { useT } from '@fizz/agent-kit/shared/lib/language'

/** 改键待确认：录制到新组合（或清除）不直接落盘，先弹二次确认；reset = 恢复默认 */
type PendingChange =
  | { kind: 'change'; action: AgentShortcutAction; accelerator: string }
  | { kind: 'reset' }

export function ShortcutsTab({
  shortcuts,
  onSave,
  onRecordingChange
}: {
  shortcuts: AgentShortcutConfig[]
  onSave: (shortcuts: AgentShortcutConfig[]) => void
  /** 录制开始 / 结束：宿主据此挂起 / 恢复全局快捷键分发 */
  onRecordingChange: (recording: boolean) => void
}) {
  const tr = useT()
  const [recording, setRecording] = useState<AgentShortcutAction | null>(null)
  /** 录制被拒（裸字母等）时在对应行下方的行内提示 */
  const [warning, setWarning] = useState<string | null>(null)
  /** 改键待确认：录制到新组合（或清除）/ 恢复默认，先弹二次确认再 onSave */
  const [pending, setPending] = useState<PendingChange | null>(null)

  // 录制期间挂起宿主的全局分发：否则按下的组合既被录进去、又把动作执行一遍
  useEffect(() => {
    if (!recording) return
    onRecordingChange(true)
    return () => onRecordingChange(false)
  }, [recording, onRecordingChange])

  // 桌面端语音输入暂时不可用（宿主缺语音服务）：这一行不列出，免得用户看到一个
  // 按下去没有任何反应的绑定。web 端完整展示、可改键。
  const shortcutActions = useMemo(
    () =>
      getAgentHost().capabilities.voice
        ? AGENT_SHORTCUT_ACTIONS
        : AGENT_SHORTCUT_ACTIONS.filter((a) => a.action !== 'voice-input'),
    []
  )

  // 捕获模式：window keydown 组成 accelerator 后写入并退出录制
  useEffect(() => {
    if (!recording) return
    const handler = (e: KeyboardEvent): void => {
      e.preventDefault()
      e.stopPropagation()
      if (e.code === 'Escape') {
        setRecording(null)
        return
      }
      if (e.code === 'Backspace' || e.code === 'Delete') {
        // 清除也是一次修改，先弹二次确认再落盘
        setPending({ kind: 'change', action: recording, accelerator: '' })
        setWarning(null)
        setRecording(null)
        return
      }
      const acc = acceleratorFromEvent(e)
      if (!acc) return
      // 裸字母 / 数字在应用内匹配下会把该键整个吃掉，不收，提示重录
      if (!isUsableAccelerator(acc)) {
        setWarning(tr('请至少带上 Ctrl 或 Alt（F1–F12 这类功能键可以单独使用）'))
        return
      }
      // 录到合法组合：不直接保存，先弹二次确认
      setPending({ kind: 'change', action: recording, accelerator: acc })
      setWarning(null)
      setRecording(null)
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [recording])

  const conflicts = findShortcutConflicts(shortcuts)
  const conflictList = shortcutActions.filter((a) => conflicts.has(a.action))

  return (
    <div className="space-y-4">
      <p className="text-xs leading-4 text-muted-foreground">
        {tr('仅应用在前台时生效，')}<span className="font-medium">{tr('不占用系统级热键')}</span>{tr('。')}
        <code className="mx-1 rounded bg-secondary px-1">CommandOrControl</code>
        {tr('在 Mac 为 ⌘、其他平台为 Ctrl；Esc 取消录制，Backspace / Delete 清除。')}
      </p>

      {conflictList.length > 0 && (
        <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[0.75rem] text-destructive">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <span>
            {tr('存在冲突的快捷键（同一组合被多个动作占用，仅其中一个会生效）：')}
            <span className="ml-1 font-medium">
              {conflictList.map((a) => shortcutLabel(a.action)).join('、')}
            </span>
          </span>
        </div>
      )}

      <div className="divide-y divide-border/60 rounded-md border border-border/60">
        {shortcutActions.map((meta) => {
          const cfg = shortcuts.find((s) => s.action === meta.action)
          const accelerator = cfg?.accelerator ?? ''
          const isRecording = recording === meta.action
          const isConflict = conflicts.has(meta.action)
          const display = formatShortcut(accelerator)
          return (
            <div
              key={meta.action}
              className={cn(
                'flex items-center justify-between gap-4 px-3 py-2.5',
                isConflict && 'bg-destructive/5'
              )}
            >
              <div className="min-w-0">
                <div className="text-[0.8125rem] font-medium">{tr(meta.label)}</div>
                <div
                  className={cn(
                    'mt-0.5 text-xs',
                    isRecording
                      ? 'text-primary'
                      : isConflict
                        ? 'text-destructive'
                        : warning && isRecording
                          ? 'text-destructive'
                          : 'text-muted-foreground'
                  )}
                >
                  {isRecording
                    ? (warning ?? tr('按下按键组合…（Esc 取消）'))
                    : isConflict
                      ? tr('该组合与其它动作冲突')
                      : accelerator
                        ? tr('应用内生效（窗口在前台时）')
                        : tr('未绑定：该动作被禁用')}
                </div>
              </div>
              <Button
                onClick={() => {
                  setWarning(null)
                  setRecording(isRecording ? null : meta.action)
                }}
                title={accelerator || undefined}
                variant={isRecording ? 'default' : 'outline'}
                className={cn(
                  'shrink-0 px-3 text-[0.75rem] font-medium tabular-nums',
                  isConflict && !isRecording && 'border-destructive/50 text-destructive'
                )}
              >
                {isRecording ? tr('按下按键组合…（Esc 取消）') : display || tr('点击设置')}
              </Button>
            </div>
          )
        })}
      </div>

      <div className="flex justify-end">
        <Button variant="ghost" size="sm" onClick={() => setPending({ kind: 'reset' })}>
          <RotateCcw className="size-3.5" />
          {tr('恢复默认')}
        </Button>
      </div>

      <Dialog open={pending !== null} onOpenChange={(open) => { if (!open) setPending(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{pending?.kind === 'reset' ? tr('恢复默认快捷键') : tr('确认修改快捷键')}</DialogTitle>
            <DialogDescription>
              {pending?.kind === 'reset'
                ? tr('将所有快捷键恢复为默认值？')
                : pending && pending.kind === 'change'
                  ? pending.accelerator
                    ? tr('将「{action}」的快捷键设置为「{key}」？', { action: shortcutLabel(pending.action), key: formatShortcut(pending.accelerator) })
                    : tr('清除「{action}」的快捷键？该动作将被禁用。', { action: shortcutLabel(pending.action) })
                  : ''}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPending(null)}>
              {tr('取消')}
            </Button>
            <Button
              onClick={() => {
                if (pending?.kind === 'reset') {
                  onSave(shortcutActions.map((a) => ({ action: a.action, accelerator: a.defaultAccelerator })))
                } else if (pending && pending.kind === 'change') {
                  onSave(shortcuts.map((s) => (s.action === pending.action ? { ...s, accelerator: pending.accelerator } : s)))
                }
                setWarning(null)
                setPending(null)
              }}
            >
              {tr('确认')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
