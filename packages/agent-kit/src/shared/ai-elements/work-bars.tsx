/**
 * 「这一段还在干活」的小标记：三根竖条错峰伸缩（像电平表在跳）。
 *
 * 为什么不是一颗 loader 转圈（`Loader2` / `Loader`）：那个圈在任何一个产品里都长一样，
 * 塞进一行灰字里只剩「有个东西在转」，看完不知道在转什么。三根条的形状本身就和文字
 * 区分得开（细长 vs 横排字），错峰相位让「在动」不需要读字就看得出来；尺寸压在 14px 内、
 * 只有 2px 宽，安静，不跟同一行文字的扫光抢注意力。
 *
 * ⚠️ 尺寸固定 `size-3.5`（14px），**落地后整个节点移除**（`TurnStepGroup` 里用 `active &&`）：
 * 历史消息里不该留一排还在跳的条。
 * ⚠️ `aria-hidden`：状态已经由同一行的文字说清楚，屏读器再念一遍图标没有意义。
 */
import { cn } from '@fizz/agent-kit/shared/lib/utils'

/**
 * 三根条：中间那根略宽一点，相位差 180ms —— 三根同步伸缩会看成一块方砖在喘气，
 * 错开才像「有东西正在被加工」。
 *
 * 延迟用任意值类而不是 inline style：与 `theme.css` 里「动画全走令牌 / 工具类」的口径一致。
 */
const BARS = [
  { width: 'w-[2px]', delay: '[animation-delay:0ms]' },
  { width: 'w-[2.5px]', delay: '[animation-delay:180ms]' },
  { width: 'w-[2px]', delay: '[animation-delay:360ms]' }
]

export function WorkBars({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        'inline-flex size-3.5 shrink-0 items-center justify-center gap-[1.5px]',
        className
      )}
    >
      {BARS.map((bar) => (
        <span
          key={bar.delay}
          className={cn('h-[11px] rounded-[1px] bg-current animate-work-bar', bar.width, bar.delay)}
        />
      ))}
    </span>
  )
}
