import { Loader2 } from 'lucide-react'
import { cn } from 'cn'

/**
 * 「第 N 次重试」指示器（单条、自替换、带动画）。
 *
 * 用在「模型请求因网络错误失败、正在自动重试」的空档：此时半截输出已被清掉、
 * 重试后的新内容还没到。它与 `TypingDots` 占同一个位置、二者互斥（重试中显示本组件）。
 *
 * ⚠️ 调用方传 `key={attempt}` —— 次数变化时整条重建，从而**重放一遍入场动画**
 * （只在同一节点上改文本不会重新触发 CSS 动画）。因为每个会话只有一份重试状态，
 * 屏幕上任何时刻只会有这一条。
 *
 * 动画定义在 index.css（`.retry-line`），与项目其它自绘动画一致。
 */
export function RetryIndicator({ attempt, className }: { attempt: number; className?: string }) {
  return (
    <div
      className={cn('retry-line flex items-center gap-2 text-xs text-muted-foreground', className)}
      role="status"
      aria-live="polite"
    >
      <Loader2 className="size-3.5 shrink-0 animate-spin" />
      <span>第 {attempt} 次重试</span>
    </div>
  )
}
