'use client'
/**
 * 只有图标的按钮统一套它：`children` 就是那颗按钮，`label` 是悬停提示。
 *
 * 走设计系统的 Tooltip（不用原生 `title`）—— 悬停即时、样式统一，也不会和原生提示
 * 叠成两个。无障碍名仍由按钮自己的 `aria-label` 负责，这里只管视觉提示。
 *
 * `side` 默认 `top`；贴着面板 / 窗口边缘的按钮（如面板右上角的「收起」）传 `bottom`，
 * 免得提示被裁掉。
 */
import type { ReactNode } from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@fizz/ui/tooltip'

export function IconTip({
  label,
  side = 'top',
  children
}: {
  label: ReactNode
  side?: 'top' | 'right' | 'bottom' | 'left'
  children: ReactNode
}): ReactNode {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side}>{label}</TooltipContent>
    </Tooltip>
  )
}
