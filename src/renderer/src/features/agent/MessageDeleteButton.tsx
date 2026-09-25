import { useState } from 'react'
import { Popconfirm, Tooltip } from 'antd'
import { Trash2 } from 'lucide-react'
import { cn } from 'cn'

/**
 * 对话消息的删除按钮（Agent 页面与终端 AI 助手浮窗共用）。
 *
 * 只有图标、没有文字，说明放在 tooltip 里。显隐由外层控制（消息 hover 才出现）。
 *
 * 删除是「从这里重新开始」：删掉这条消息，**同时删掉它之后的全部消息**。
 * 不能只删中间一条 —— 后面的工具调用会失去对应的结果、回复会失去上文，
 * 历史交给模型时也过不了 tool-call / tool-result 的配对校验。
 * 所以确认文案里明确写出会连带删掉几条。
 *
 * 确认框打开时把 tooltip 收掉（title 置空）：两个浮层叠在一起会打架。
 */
export function MessageDeleteButton({
  count,
  onConfirm,
  className
}: {
  /** 含本条在内、会被一起删掉的消息条数 */
  count: number
  onConfirm: () => void
  className?: string
}) {
  const [confirmOpen, setConfirmOpen] = useState(false)
  const rest = count - 1
  const tip = '删除这条消息及其后的所有消息'

  return (
    <Popconfirm
      open={confirmOpen}
      onOpenChange={setConfirmOpen}
      title="删除这条消息？"
      description={
        rest > 0 ? `它之后的 ${rest} 条消息也会一起删除，不可恢复。` : '删除后不可恢复。'
      }
      okText="删除"
      cancelText="取消"
      okButtonProps={{ danger: true }}
      onConfirm={onConfirm}
    >
      <Tooltip title={confirmOpen ? '' : tip}>
        <button
          type="button"
          aria-label={tip}
          className={cn(
            'inline-flex items-center justify-center rounded p-1',
            'text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive',
            className
          )}
        >
          <Trash2 className="size-4" />
        </button>
      </Tooltip>
    </Popconfirm>
  )
}
