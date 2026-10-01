import { Clock, Pencil, SendHorizontal, Trash2 } from 'lucide-react'
import { cn } from 'cn'
import { useAppStore, type QueuedAgentMessage } from '@/stores/app-store'

/**
 * 待发送队列：会话进行中用户继续发的消息排在这里，作为**输入框卡片的 header**
 * 渲染在同一张卡里（底部分隔线把它与 textarea 隔开，浑然一体），见 AgentPage 的输入区。
 *
 * 行为对齐 fishwork 的 `QueuedMessages`：
 * - 本轮**自然结束**后由 `pumpAgentQueue` 按顺序依次发出（报错 / 用户手动停止则不接续，
 *   队列留着等用户自己处理）；
 * - 每条支持「现在发」（摘出这条立刻开新一轮，只在空闲时可用）、「编辑」（写回输入框 +
 *   移出队列，让用户接着改再发，与「重发」同一心智）与「删除」。
 *
 * 队列只在内存里（和输入框里没发出去的草稿同一性质），切会话互不干扰。
 */
export function QueuedAgentMessages({
  conversationId,
  onEdit
}: {
  conversationId: string
  /** 点「编辑」：把这条的内容回填到输入框（调用方负责从队列里删掉它并聚焦） */
  onEdit: (text: string) => void
}) {
  const items = useAppStore((s) => s.agentQueues[conversationId])
  const streaming = useAppStore((s) => s.agentRuns[conversationId]?.streaming ?? false)
  const sendQueuedMessage = useAppStore((s) => s.sendQueuedAgentMessage)
  const removeQueuedMessage = useAppStore((s) => s.removeQueuedAgentMessage)

  if (!items?.length) return null

  return (
    <div className="border-b border-border/70 px-3 py-2" data-queue>
      <div className="mb-1 flex items-center gap-1.5 text-xs text-muted-foreground">
        <Clock className="size-3.5 shrink-0" />
        <span>
          待发送 · {items.length} 条
          {streaming ? '（本轮结束后依次执行）' : '（已停止，可挑一条现在就发）'}
        </span>
      </div>
      <div className="flex flex-col gap-0.5">
        {items.map((item) => (
          <QueuedRow
            key={item.id}
            item={item}
            streaming={streaming}
            onSend={() => void sendQueuedMessage(item.id, conversationId)}
            onEdit={() => {
              removeQueuedMessage(item.id, conversationId)
              onEdit(item.text)
            }}
            onRemove={() => removeQueuedMessage(item.id, conversationId)}
          />
        ))}
      </div>
    </div>
  )
}

function QueuedRow({
  item,
  streaming,
  onSend,
  onEdit,
  onRemove
}: {
  item: QueuedAgentMessage
  streaming: boolean
  onSend: () => void
  onEdit: () => void
  onRemove: () => void
}) {
  return (
    // items-start：多行文本时按钮贴首行（与 fishwork 一致），不跟着折行居中
    <div className="group/queue flex items-start gap-2 rounded px-1 py-1 transition-colors hover:bg-foreground/5">
      <p className="line-clamp-3 min-w-0 flex-1 break-words whitespace-pre-wrap text-sm text-muted-foreground">
        {item.text}
      </p>
      <button
        type="button"
        disabled={streaming}
        title={streaming ? '对话进行中，本轮结束后会自动发送' : '立刻发送这一条'}
        aria-label="发送这一条"
        onClick={onSend}
        className={cn(
          'shrink-0 rounded p-1 transition-colors',
          streaming
            ? 'cursor-not-allowed text-muted-foreground/50'
            : 'text-muted-foreground hover:bg-foreground/10 hover:text-foreground'
        )}
      >
        <SendHorizontal className="size-3.5" />
      </button>
      <button
        type="button"
        title="编辑并写回输入框"
        aria-label="编辑并写回输入框"
        onClick={onEdit}
        className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
      >
        <Pencil className="size-3.5" />
      </button>
      <button
        type="button"
        title="删除"
        aria-label="删除"
        onClick={onRemove}
        className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
      >
        <Trash2 className="size-3.5" />
      </button>
    </div>
  )
}
