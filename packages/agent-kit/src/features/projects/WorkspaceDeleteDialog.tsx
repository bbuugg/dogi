/**
 * 「移除工作区」二次确认弹窗（侧栏行尾垃圾桶 + 设置 →「工作区」+ 「管理工作区」弹窗共用一份）。
 *
 * 为什么不跟列表里其它删除一样用「点两次就地确认」（模型 / MCP / 会话仍是那套手感）：
 * 删工作区在服务端是**级联删除** —— `domain.deleteWorkspace` 会把它**整棵 worktree 子树**
 * 连同下面所有会话 / 定时任务 / 流程一起清掉（工作区没了，这些就成了永远看不到的
 * 孤儿数据），破坏面比删单个条目大得多。所以这里用独立弹窗把「连带删什么、什么不会动」
 * 写清楚，而不是只让按钮变个色。
 *
 * 对 worktree 项目多一个「同时删除 git worktree」复选：默认不勾（只摘记录，磁盘不动），
 * 勾上则服务端跑 `git worktree remove --force` 把 `<项目>/.worktree/<标识>` 目录删掉。
 * 分支不删 —— 改动提交还找得回来，用户后悔了能重新挂上。
 */
import { useState } from 'react'
import { Button } from '@fizz/ui/button'
import { Checkbox } from '@fizz/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@fizz/ui/dialog'
import type { AgentWorkspace, WorkspaceDeleteInput } from '@fizz/contracts/agent-api'
import { useT } from '@fizz/agent-kit/shared/lib/language'

export function WorkspaceDeleteDialog({
  workspace,
  onCancel,
  onConfirm
}: {
  /** 待移除的工作区；null = 关着 */
  workspace: AgentWorkspace | null
  onCancel: () => void
  onConfirm: (workspace: AgentWorkspace, options: WorkspaceDeleteInput) => void
}) {
  const tr = useT()
  const [deleteWorktree, setDeleteWorktree] = useState(false)

  // 勾选状态随弹窗一起归零（在关闭/确认的回调里重置，而不是靠 effect 同步：
  // 上一条勾了「删目录」，下一条普通项目不能继承这个危险意图）
  const close = (): void => {
    setDeleteWorktree(false)
    onCancel()
  }

  // 只有 worktree 项目才谈得上删 git worktree 目录；普通项目勾了服务端也会拒
  const canDeleteWorktree = !!workspace?.isWorktree

  return (
    <Dialog
      open={workspace !== null}
      onOpenChange={(open) => {
        if (!open) close()
      }}
    >
      {/* 关掉只收起、不清状态：误点遮罩 / Esc 退回后还能再点一次确认，不必重新找那个图标 */}
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{tr('移除工作区？')}</DialogTitle>
          <DialogDescription>
            {tr('「{name}」及其全部会话都会被移除，它下面的 worktree 工作区、定时任务也会一起清掉；{files}', {
              name: workspace?.name ?? '',
              files: canDeleteWorktree ? tr('磁盘上的文件默认不会动。') : tr('磁盘上的文件不会动。')
            })}
          </DialogDescription>
        </DialogHeader>

        {canDeleteWorktree && (
          <label className="flex cursor-pointer items-start gap-2 rounded-md border border-border/70 px-3 py-2 text-xs">
            <Checkbox
              checked={deleteWorktree}
              onCheckedChange={(checked) => setDeleteWorktree(checked === true)}
              className="mt-0.5"
            />
            <span>
              <span className="block font-medium">{tr('同时删除 git worktree')}</span>
              <span className="block text-muted-foreground">
                {tr('连目录一起删掉（{path}），未提交的改动会丢；分支保留。', { path: workspace?.path ?? '' })}
              </span>
            </span>
          </label>
        )}

        <DialogFooter className="pt-1">
          <Button size="sm" variant="ghost" onClick={close}>
            {tr('取消')}
          </Button>
          <Button
            size="sm"
            variant="destructive"
            onClick={() => {
              if (!workspace) return
              setDeleteWorktree(false)
              onConfirm(workspace, { deleteWorktree })
            }}
          >
            {tr('移除')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}