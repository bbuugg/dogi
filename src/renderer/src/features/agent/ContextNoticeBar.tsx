import { Gauge } from 'lucide-react'
import type { ContextCompression } from '@shared/types'
import { cn } from 'cn'

function fmt(n: number): string {
  return n.toLocaleString()
}

/**
 * 消息列顶部的「上下文已压缩」提示条（sticky）。**只放通知，不放统计** ——
 * 会话累计 token 已经收进输入框的上下文圆环（`ContextRing` 详情里的「会话累计」段），
 * 与 fishwork 一致：顶部这条是「刚刚发生了什么」的一次性提示，圆环才是「随时想瞄一眼」的常驻面板。
 *
 * 为什么是 sticky 而不是消息流里的一行：它是「关于整段会话」而不是「关于某轮」的元信息，
 * 贴在消息列表顶部滚走就看不到了。
 *
 * ⚠️ 不要在这里加回累计 token：它每轮都在变，粘在顶部会一直晃，
 * 且与圆环里的同一份数据重复（迁移时正是这个重复）。
 */
export function ContextNoticeBar({
  notice,
  className
}: {
  /** 最近一次压缩通知（自动压缩与手动压缩都会写它）；没有就整条不渲染 */
  notice?: ContextCompression
  className?: string
}) {
  if (!notice) return null
  return (
    <div className={cn('mb-3', className)}>
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
    </div>
  )
}
