/**
 * 设置页的「胶囊单选」：工具权限 / 自动折叠 / 明暗 / 默认终端 / 背景质感 / 背景显示方式共用。
 *
 * 用 Radix `ToggleGroup`（`type="single"`）替掉手写的 `role="radiogroup"` + `role="radio"`
 * 按钮：单选语义（radiogroup / radio / aria-checked）、方向键切换与 roving tabindex 都由
 * 原语负责，选中态改由 `data-[state=on]` 驱动，调用方不用再自己比较值。
 *
 * 间距用默认的 `spacing={2}`（8px）：这些都是「一颗一颗独立的胶囊」，不是首尾相接的分段
 * 控件 —— 分段控件见 `features/api/Segmented.tsx`（`spacing={0}`，相邻项共享边框）。
 */
import type { ReactNode } from 'react'
import { ToggleGroup, ToggleGroupItem } from '@fizz/ui/toggle-group'
import { cn } from '@fizz/agent-kit/shared/lib/utils'
import { useT } from '@fizz/agent-kit/shared/lib/language'

export interface ChoiceChipOption<T extends string> {
  value: T
  label: ReactNode
  /** 悬停提示（有些档位光看标签说不清） */
  title?: string
}

export function ChoiceChips<T extends string>({
  value,
  onChange,
  options,
  ariaLabel,
  className
}: {
  value: T
  onChange: (value: T) => void
  options: ReadonlyArray<ChoiceChipOption<T>>
  ariaLabel: string
  className?: string
}) {
  const tr = useT()
  return (
    <ToggleGroup
      type="single"
      variant="outline"
      value={value}
      onValueChange={(next) => {
        // 再点一次选中的那项时 Radix 会回调空串：单选组必须始终有一项，忽略即可
        if (next) onChange(next as T)
      }}
      aria-label={ariaLabel}
      className={cn('flex-wrap', className)}
    >
      {options.map((option) => (
        <ToggleGroupItem
          key={option.value}
          value={option.value}
          title={typeof option.title === 'string' ? tr(option.title) : option.title}
          className={cn(
            // 形状照旧：比 Toggle 默认的小一号，且保留各自独立的边框
            'h-auto shrink-0 gap-1.5 rounded-md border-border/60 px-3 py-1.5 text-xs font-normal transition-colors',
            'text-muted-foreground hover:text-foreground',
            // 未选中项悬停不铺底色；选中项悬停保持选中底色（Toggle 默认 hover:bg-muted）
            'data-[state=off]:hover:bg-transparent',
            'data-[state=on]:border-primary/60 data-[state=on]:bg-secondary data-[state=on]:text-foreground',
            'data-[state=on]:hover:bg-secondary'
          )}
        >
          {typeof option.label === 'string' ? tr(option.label) : option.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}
