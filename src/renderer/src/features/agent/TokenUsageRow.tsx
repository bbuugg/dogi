import { Gauge } from 'lucide-react'
import type { TurnUsage } from '@shared/types'
import { formatCompactDuration } from '@/shared/lib/format'
import { cn } from 'cn'

function fmt(n: number): string {
  return n.toLocaleString()
}

/**
 * 一轮结束后的用量统计条：输出速度（tok/s）、输入 / 输出 / 合计 token、思考 token、
 * 缓存输入、整轮耗时。挂在助手消息下方，与 fishwork 同款。
 *
 * 耗时按量级自动换单位（`formatCompactDuration`）：秒级保留一位小数，上到分钟 / 小时
 * 就换成 `1m23s` / `1h02m` —— 长时间的一轮不会再写成「523.4s」。
 */
export function TokenUsageRow({ usage, className }: { usage: TurnUsage; className?: string }) {
  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground/70',
        className
      )}
    >
      <span className="inline-flex items-center gap-1" title="输出速度（每秒生成的 tokens）">
        <Gauge className="size-3.5" />
        {usage.tps} tok/s
      </span>
      <span>输入 {fmt(usage.inputTokens)}</span>
      <span>输出 {fmt(usage.outputTokens)}</span>
      <span>合计 {fmt(usage.totalTokens)}</span>
      {!!usage.reasoningTokens && <span>思考 {fmt(usage.reasoningTokens)}</span>}
      {!!usage.cachedInputTokens && <span>缓存 {fmt(usage.cachedInputTokens)}</span>}
      <span title="整轮耗时">{formatCompactDuration(usage.durationMs)}</span>
    </div>
  )
}
