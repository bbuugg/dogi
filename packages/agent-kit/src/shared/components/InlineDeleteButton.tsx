'use client'
/**
 * 统一的「两步删除」按钮：
 *
 * - 平时是行尾一个半透明的垃圾桶图标（hover 所在行才浮现，手机常显）；
 * - 第一次点 → 变成**浅红色小方框**（红字 + 10% 红底 + 勾），提示「再点一次确认删除」；
 * - 第二次点 → 真正执行 `onConfirm`。
 *
 * 反悔方式由调用方决定（通常是：点开别的东西、或鼠标移开该行时把 `armed` 复位），
 * 本组件只负责「点击切换 armed / 二次点击确认」这一层，不持有业务状态，方便
 * 会话、流程两处复用同一套交互（见 `features/chat/AgentSidebar.tsx`）。
 */
import type { ReactNode } from 'react'
import { Check, Trash2 } from 'lucide-react'
import { IconTip } from '@fizz/agent-kit/shared/components/IconTip'
import { cn } from '@fizz/agent-kit/shared/lib/utils'

export function InlineDeleteButton({
  armed,
  onArm,
  onConfirm,
  title,
  label = '删除',
  className
}: {
  /** 是否已进入「二次确认」态（由调用方按 id 维护） */
  armed: boolean
  /** 第一次点击：进入二次确认态 */
  onArm: () => void
  /** 第二次点击：真正删除 */
  onConfirm: () => void
  /** 条目名称，仅用于 tooltip / aria-label */
  title: string
  /**
   * 动作词，默认「删除」。
   *
   * 存在的意义只有一处：「已归档」区里删的是**回收站里的东西**，说「删除」会让人以为
   * 还能找回来 —— 那里要写「彻底删除」。措辞不同就足以让人多点一下确认，正是二次确认
   * 该干的事。
   */
  label?: string
  className?: string
}): ReactNode {
  return (
    <IconTip label={armed ? `再点一次确认${label} ${title}` : `${label} ${title}`}>
      <button
        type="button"
        aria-label={armed ? `确认${label} ${title}` : `${label} ${title}`}
        onClick={(e) => {
          e.stopPropagation()
          if (!armed) onArm()
          else onConfirm()
        }}
        className={cn(
          'inline-flex shrink-0 items-center justify-center rounded p-0.5 transition-colors',
          armed
            ? 'bg-destructive/10 text-destructive opacity-100 hover:bg-destructive/20'
            : 'opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100 max-md:opacity-100',
          className
        )}
      >
        {armed ? <Check className="size-3.5" /> : <Trash2 className="size-3.5" />}
      </button>
    </IconTip>
  )
}
