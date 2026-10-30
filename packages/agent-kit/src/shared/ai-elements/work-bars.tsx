/**
 * 「这一段还在干活」的小标记：三根竖条错峰伸缩（像电平表在跳）。
 *
 * 为什么不是一颗 loader 转圈（`Loader2` / `Loader`）：那个圈在任何一个产品里都长一样，
 * 塞进一行灰字里只剩「有个东西在转」，看完不知道在转什么。三根条的形状本身就和文字
 * 区分得开（细长 vs 横排字），错峰相位让「在动」不需要读字就看得出来；单根只有 2px 宽，
 * 安静，不跟同一行文字的扫光抢注意力。
 *
 * ⚠️ **槽位与 lucide 图标同宽同高（`size-4`，16px）**：它和同列的扳手 / 脑（`size-4`）
 * 是互斥的两个档位 —— 这一组在跑时是竖条，等模型下一步时换成类型图标。盒子小一档
 * （原来是 `size-3.5`）的话，两档切换时名字起点会横跳 2px，而且 11px 的条阵在一排
 * 16px 图标里明显矮一截（看着像「小一号的图标」，不是同一个视觉规格）。
 * 条本身 12px 高、居中留在 16px 盒里，`scaleY` 最大到 1 也不会溢出。
 *
 * ⚠️ **落地后整个节点移除**（`TurnStepGroup` 里用 `active &&`）：历史消息里不该留一排
 * 还在跳的条。
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
        'inline-flex size-4 shrink-0 items-center justify-center gap-[1.5px]',
        className
      )}
    >
      {BARS.map((bar) => (
        <span
          key={bar.delay}
          className={cn('h-3 rounded-[1px] bg-current animate-work-bar', bar.width, bar.delay)}
        />
      ))}
    </span>
  )
}
