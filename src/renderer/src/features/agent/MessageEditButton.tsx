import { Tooltip } from 'antd'
import { Pencil } from 'lucide-react'
import { cn } from 'cn'

/**
 * 用户消息的「编辑并重发」按钮（Agent 页面用）。
 *
 * 只有图标、没有文字，说明放在 tooltip 里。显隐由外层控制（消息 hover 才出现）。
 *
 * 点了不是就地编辑气泡，而是**把这条的内容灌进底部输入框**并进入编辑态 ——
 * 大输入框才有模型/权限这些控件，也才能用 Enter 发送。
 * 重发时会**先删掉这条及其之后的全部消息**再发送（见 store 的 `resendAgentMessage`），
 * 否则同一句话会在历史里出现两遍、模型会看到自相矛盾的上下文。
 */
export function MessageEditButton({
  onEdit,
  className
}: {
  onEdit: () => void
  className?: string
}) {
  const tip = '编辑并重新发送'
  return (
    <Tooltip title={tip}>
      <button
        type="button"
        aria-label={tip}
        onClick={onEdit}
        className={cn(
          'inline-flex items-center justify-center rounded p-1',
          'text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground',
          className
        )}
      >
        <Pencil className="size-3" />
      </button>
    </Tooltip>
  )
}
