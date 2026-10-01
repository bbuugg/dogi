import { Gauge } from 'lucide-react'
import type { ContextCompression, ConversationUsage } from '@shared/types'
import { cn } from 'cn'

function fmt(n: number): string {
  return n.toLocaleString()
}

/**
 * 会话头部的两条 sticky 提示条：**会话累计 token** + **上下文已压缩**。与 fishwork 同款。
 *
 * 为什么是 sticky 而不是消息流里的一行：这两条都是「关于整段会话」而不是「关于某轮」的元信息，
 * 贴在消息列表顶部滚走就看不到了；累计 token 是用户随时想瞄一眼的东西。
 *
 * 累计值**现算**（`sumUsage`）而不是存一份字段：压缩不改历史，历史是唯一真源，
 * 另存累计值就多出一个可能与消息对不上的副本。
 */
export function ConversationUsageBar({
  usage,
  notice,
  className
}: {
  usage: ConversationUsage | null
  notice?: ContextCompression
  className?: string
}) {
  if (!usage && !notice) return null
  return (
    <div className={cn('mb-3 flex flex-col gap-2', className)}>
      {usage && (
        <div className="sticky top-0 z-10 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border bg-background/80 px-3 py-1.5 text-xs text-muted-foreground backdrop-blur">
          <span className="inline-flex items-center gap-1 font-medium text-foreground">
            <Gauge className="size-3.5" />
            会话累计
          </span>
          <span>输入 {fmt(usage.inputTokens)}</span>
          <span>输出 {fmt(usage.outputTokens)}</span>
          <span className="font-medium text-foreground">合计 {fmt(usage.totalTokens)}</span>
          {!!usage.reasoningTokens && <span>思考 {fmt(usage.reasoningTokens)}</span>}
          {!!usage.cachedInputTokens && <span>缓存 {fmt(usage.cachedInputTokens)}</span>}
        </div>
      )}
      {notice && (
        <div className="sticky top-0 z-10 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border bg-background/80 px-3 py-1.5 text-xs text-muted-foreground backdrop-blur">
          <span className="inline-flex items-center gap-1 font-medium text-foreground">
            <Gauge className="size-3.5" />
            上下文已压缩
          </span>
          <span>压缩前 {fmt(notice.beforeTokens)} token</span>
          <span>→ 压缩后 {fmt(notice.afterTokens)} token</span>
          <span>
            摘要了 {notice.summarizedTurns} 轮，保留 {notice.keptTurns} 轮
          </span>
          {notice.truncated && (
            // 摘要请求失败时的降级：旧轮是被**丢弃**而不是摘要，如实说明，否则用户会以为细节还在
            <span className="text-destructive">摘要失败，旧轮已截断丢弃</span>
          )}
        </div>
      )}
    </div>
  )
}