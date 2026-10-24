/**
 * 「从此签出」弹窗：会话分叉的入口 —— 只是 `BranchTargetDialog` 的薄壳，把「选哪个工作区」
 * 那份共用交互（当前工作区分叉 / 新建 worktree 并签出）交给它，这里只提供文案与提交动作。
 *
 * 提交走 store 的 `forkConversation`：历史复制一份、原会话不动；worktree 模式下先建
 * `<项目>/.worktree/<标识>` 再挂进去（细节见 `BranchTargetDialog` 文件头）。
 */
import { BranchTargetDialog } from '@fizz/agent-kit/features/chat/BranchTargetDialog'
import type { AgentApp } from '@fizz/agent-kit/shared/hooks/useAgentApp'

export function ForkDialog({
  app,
  messageId,
  open,
  onOpenChange
}: {
  app: AgentApp
  /** 签出终点（含该条）；null = 弹窗关闭 */
  messageId: string | null
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <BranchTargetDialog
      open={open}
      onOpenChange={onOpenChange}
      title="从此签出"
      description="以选中的消息为终点创建分支会话：历史到这里为止，之后两边各自独立（类似 git 从这里拉一个分支）。"
      confirmLabel="签出"
      busyLabel="签出中…"
      onSubmit={async (target) => {
        if (!messageId) return
        await app.forkConversation(messageId, target)
      }}
    />
  )
}