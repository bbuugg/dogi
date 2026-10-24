/**
 * 「另起一条会话、落在哪个工作区」的**共用弹窗壳** —— 「从此签出」（`ForkDialog`）与
 * 「转为内置 Agent 会话」（`ConvertAcpDialog`）都用它。
 *
 * 两者要做的选择完全一样：**在当前工作区分叉**，还是**新建 worktree 并签出**；差别只在
 * 标题 / 说明 / 按钮文案与提交动作（由调用方给）。把这份壳收在这里，两处的交互、标识校验、
 * 忙碌态、错误回显就不会各写一套走样。
 *
 * - 「在当前工作区分叉」：新会话与原会话同在一个工作区，读写同一份代码；
 * - 「新建 worktree 并签出」：先在**源会话所属**项目下建 `<项目>/.worktree/<标识>`
 *   （目录即标识、分支 `worktree/<标识>`），新工作区登记成 worktree 项目后再把新会话挂进去。
 *   标识必填（与服务端同一把正则校验），项目名选填。
 *
 * 提交约定：`onSubmit` **resolve = 成功**（关弹窗），**throw = 失败**（留在原地并显示 message）。
 * 具体原因通常也已写进全局错误条，这里再显示一份供用户就地改完重试。
 */
import { useState, type ReactNode } from 'react'
import { WORKTREE_IDENTIFIER_RE } from '@fizz/contracts/agent-api'
import { Button } from '@fizz/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@fizz/ui/dialog'
import { Input } from '@fizz/ui/input'
import { Label } from '@fizz/ui/label'
import { RadioGroup, RadioGroupItem } from '@fizz/ui/radio-group'

/** 分叉目标：worktree 模式带标识（+ 可选名称）；共享工作区模式为 undefined */
export interface BranchTarget {
  worktreeIdentifier: string
  worktreeName?: string
}

export function BranchTargetDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  busyLabel,
  onSubmit
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: ReactNode
  /** 确认按钮文案（忙碌时用 `busyLabel`） */
  confirmLabel: string
  busyLabel: string
  onSubmit: (target: BranchTarget | undefined) => Promise<void>
}) {
  const [mode, setMode] = useState<'workspace' | 'worktree'>('workspace')
  const [identifier, setIdentifier] = useState('')
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const close = (): void => {
    onOpenChange(false)
    setError(null)
    setBusy(false)
  }

  const submit = async (): Promise<void> => {
    if (busy) return
    let target: BranchTarget | undefined
    if (mode === 'worktree') {
      const id = identifier.trim()
      if (!WORKTREE_IDENTIFIER_RE.test(id)) {
        setError('标识只能包含字母、数字、-、_、.，且以字母或数字开头')
        return
      }
      target = { worktreeIdentifier: id, worktreeName: name.trim() || undefined }
    }
    setBusy(true)
    setError(null)
    try {
      await onSubmit(target)
      close()
    } catch (err) {
      // store 已把错误写进全局错误条；这里再显示一份，弹窗不关（用户改完重试）
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) close()
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <RadioGroup
          value={mode}
          onValueChange={(v) => setMode(v as 'workspace' | 'worktree')}
          className="gap-3"
        >
          <div className="flex items-start gap-2">
            <RadioGroupItem value="workspace" id="branch-mode-workspace" className="mt-0.5" />
            <div className="min-w-0">
              <Label htmlFor="branch-mode-workspace" className="cursor-pointer font-normal">
                在当前工作区分叉
              </Label>
              <p className="text-xs text-muted-foreground">
                新会话与原会话共用同一个工作区，读写同一份代码。
              </p>
            </div>
          </div>
          <div className="flex items-start gap-2">
            <RadioGroupItem value="worktree" id="branch-mode-worktree" className="mt-0.5" />
            <div className="min-w-0 flex-1">
              <Label htmlFor="branch-mode-worktree" className="cursor-pointer font-normal">
                新建 worktree 并签出
              </Label>
              <p className="text-xs text-muted-foreground">
                先从项目拉一个独立工作树（新分支），新会话在里面干活，互不影响。
              </p>
              {mode === 'worktree' && (
                <div className="mt-2 space-y-2">
                  <div className="space-y-1">
                    <Label htmlFor="branch-worktree-identifier" className="text-xs">
                      worktree 标识（目录 .worktree/标识，分支 worktree/标识）
                    </Label>
                    <Input
                      id="branch-worktree-identifier"
                      value={identifier}
                      onChange={(e) => setIdentifier(e.target.value)}
                      placeholder="例如 fix-login"
                      autoFocus
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="branch-worktree-name" className="text-xs">
                      项目名（选填，留空用标识）
                    </Label>
                    <Input
                      id="branch-worktree-name"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="修复登录流程"
                    />
                  </div>
                </div>
              )}
            </div>
          </div>
        </RadioGroup>

        {error && <p className="text-xs text-destructive">{error}</p>}

        <DialogFooter>
          <Button variant="ghost" onClick={close} disabled={busy}>
            取消
          </Button>
          <Button onClick={() => void submit()} disabled={busy}>
            {busy ? busyLabel : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}