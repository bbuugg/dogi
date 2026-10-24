/**
 * 「正在输入」小气泡：三个错峰上浮的点 + 轻微呼吸的气泡轮廓。
 *
 * 侧栏会话在跑时行首的图标。以前用 `Loader2` 转圈，转圈是**匀速机械**的，在一屏
 * 十几行会话里闪得人眼累，而且看不出「是在打字 / 在跑工具」。这个气泡与消息气泡
 * 同形（圆角 + 尾巴），语义对得上「正在说话」。
 *
 * 动画走全局 CSS 变量里的 --animate-typing-*（见 app/globals.css 的 @keyframes），
 * 组件本身只摆 DOM。三点错峰用 inline `animationDelay`：CSS 里没法按序号生成，
 * 硬写三条规则也行，但延迟这种纯数值放这里更好读。
 *
 * 尺寸：默认 size-4（与侧栏其它行首图标一致），内部用 em 排布，跟着 className 缩放。
 */
import { useT } from '@fizz/agent-kit/shared/lib/language'

export function TypingBubble({ className }: { className?: string }) {
  const tr = useT()
  return (
    <span
      className={
        'relative inline-flex size-4 shrink-0 items-center justify-center gap-[0.09em] ' +
        'rounded-[0.3em] bg-primary/12 text-primary ' +
        'animate-typing-bubble ' +
        (className ?? '')
      }
      role="status"
      aria-label={tr('正在运行')}
    >
      {/* 小尾巴：贴在左下角，让它更像一枚左对齐的消息气泡 */}
      <span className="absolute -bottom-[0.1em] left-[0.18em] size-[0.28em] rotate-45 rounded-[0.05em] bg-primary/12" />
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="size-[0.2em] rounded-full bg-current animate-typing-dot"
          style={{ animationDelay: `${i * 0.15}s` }}
        />
      ))}
    </span>
  )
}