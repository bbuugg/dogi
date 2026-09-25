/**
 * 三点跳动指示器（参考 ainav/sdk 的 TypingDots）。
 *
 * 用在「正在生成但还没有可见内容」的空档：模型思考结束、工具刚返回、
 * 或首包还没到。有内容（正文 / 思考 / 工具横条）时不该再显示它。
 *
 * 动画定义在 index.css（`.agent-typing-dot`），与项目其它自绘动画一致。
 */
export function TypingDots({ className }: { className?: string }) {
  return (
    <div className={className ?? 'flex items-center gap-1.5 py-2'}>
      <span className="agent-typing-dot size-1.5 rounded-full bg-muted-foreground/50" />
      <span className="agent-typing-dot size-1.5 rounded-full bg-muted-foreground/50" />
      <span className="agent-typing-dot size-1.5 rounded-full bg-muted-foreground/50" />
    </div>
  )
}
