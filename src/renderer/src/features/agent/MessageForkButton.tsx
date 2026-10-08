import { useState } from 'react'
import { Popconfirm, Tooltip } from 'antd'
import { GitBranch } from 'lucide-react'
import { cn } from 'cn'

/**
 * 对话消息的「从此签出」按钮（Agent 页面）。
 *
 * 语义：**以这条消息为终点**复制一份会话历史，造出一条新会话（原会话一字不动），
 * 于是可以在同一个问题上换条路重走一遍（与 fishwork 的签出叉子一致）。
 * 与「编辑重发」的区别：那个改的是原会话（删掉之后的消息），这个只新建、不破坏。
 *
 * 只有图标、没有文字，说明放在 tooltip 里。显隐由外层控制（消息 hover 才出现）。
 *
 * 用 Popconfirm 而不是点一下就走：签出会**切换当前会话**（原会话的滚动位置、
 * 输入到一半的草稿都留在那边），误触的代价比复制大，值得多一次点击。
 * 确认框打开时把 tooltip 收掉（title 置空）：两个浮层叠在一起会打架。
 */
export function MessageForkButton({
  onConfirm,
  className
}: {
  onConfirm: () => void
  className?: string
}) {
  const [confirmOpen, setConfirmOpen] = useState(false)
  const tip = '从此签出：以这条消息为终点创建分支会话'

  return (
    <Popconfirm
      open={confirmOpen}
      onOpenChange={setConfirmOpen}
      title="从此签出？"
      description="会以这条消息为终点复制一份历史到新会话（原会话不受影响），并切换到新会话。"
      okText="签出"
      cancelText="取消"
      onConfirm={onConfirm}
    >
      <Tooltip title={confirmOpen ? '' : tip}>
        <button
          type="button"
          aria-label={tip}
          className={cn(
            'inline-flex items-center justify-center rounded p-1',
            'text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground',
            className
          )}
        >
          <GitBranch className="size-4" />
        </button>
      </Tooltip>
    </Popconfirm>
  )
}
