"use client"

/**
 * 日期 + 时间选择器（**24 小时制**）：日历选日，右侧两列滚动选「时 / 分」。
 *
 * ## 出处与改动
 *
 * 提取自 [rudrodip/shadcn-date-time-picker](https://github.com/rudrodip/shadcn-date-time-picker)
 * 的 `src/components/date-n-time/date-time-picker-24h.tsx`，按本仓库的约定重写：
 *
 * - **改成受控**：`value` / `onChange` 由调用方持有。上游那份把 `date` 存在组件内部，
 *   放进表单里根本读不到用户选了什么（只适合当 demo）；
 * - **不引 `date-fns`**：本仓库没这条依赖（`node_modules` 里那份是别的包的传递依赖），
 *   为了格式化成 `YYYY-MM-DD HH:mm` 而给每个前端摊一份格式化库不划算 —— 显示走手写补零；
 * - 图标统一用 `lucide-react`（上游用 `@radix-ui/react-icons`，本仓库没有）；
 * - 时 / 分两列用**普通可滚 div**，不用 `ScrollArea`：这里只有一个纵向滚动、
 *   还要在打开时把选中项滚进视野，Radix 那层内部 viewport 反而要多绕一步；
 * - 修掉上游两个坑：
 *   1. `hours.reverse()` 在渲染期间**原地反转**数组（同一份数据被反复反转）；
 *   2. 没选日期时点「时 / 分」**什么都不发生**（用户先点时间就以为控件坏了）——
 *      这里退回「今天」。
 *
 * ## 为什么不用 `datetime-local`
 *
 * 原生控件的日历面板由浏览器画、样式跟不了主题，而且秒 / 时区格式各平台不一（Chromium 与
 * WebKit 长得完全是两个东西）。定时任务这种「要精确到几点几分」的表单，用它经常是
 * 「点开是一个陌生系统弹窗」。
 */
import * as React from "react"
import { Calendar as CalendarIcon } from "lucide-react"
import { zhCN } from "react-day-picker/locale"
import { cn } from "cn"
import { Button } from "./button"
import { Calendar } from "./calendar"
import { Popover, PopoverContent, PopoverTrigger } from "./popover"

/** `YYYY-MM-DD HH:mm`（本地时区；与表单里原来的 `datetime-local` 串同构，只是去掉 `T`） */
function formatDateTime(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours()
  )}:${pad(date.getMinutes())}`
}

export interface DateTimePickerProps {
  /** 当前值；`undefined` / `null` = 还没选 */
  value?: Date | null
  /** 选好 / 清除时回调（清除给 `undefined`） */
  onChange: (value: Date | undefined) => void
  /** 没有值时的占位文案 */
  placeholder?: string
  /** 挂到触发按钮上，配合 `<Label htmlFor>` 使用 */
  id?: string
  disabled?: boolean
  className?: string
  /**
   * 分钟的步进（默认 5）。定时任务不需要精确到 1 分钟；真要精确就传 1。
   */
  minuteStep?: number
  /** 日历语言，默认中文（本仓库界面只有中文；要换语言再传 `react-day-picker/locale` 里的条目） */
  locale?: React.ComponentProps<typeof Calendar>["locale"]
}

export function DateTimePicker({
  value,
  onChange,
  placeholder = "选择日期与时间",
  id,
  disabled,
  className,
  minuteStep = 5,
  locale = zhCN
}: DateTimePickerProps) {
  const [open, setOpen] = React.useState(false)
  /** 两列的滚动容器：打开时把选中项滚到可视范围内 */
  const hourRef = React.useRef<HTMLDivElement>(null)
  const minuteRef = React.useRef<HTMLDivElement>(null)

  const selected = value ?? undefined
  const hours = React.useMemo(() => Array.from({ length: 24 }, (_, i) => i), [])
  const minutes = React.useMemo(
    () => Array.from({ length: Math.ceil(60 / minuteStep) }, (_, i) => i * minuteStep),
    [minuteStep]
  )

  // 打开时把「时 / 分」两列滚到当前值（否则选 18:00 得自己滚半屏找）
  React.useEffect(() => {
    if (!open) return
    for (const el of [hourRef.current, minuteRef.current]) {
      const active = el?.querySelector<HTMLElement>('[data-active="true"]')
      if (!el || !active) continue
      el.scrollTop = active.offsetTop - el.clientHeight / 2 + active.offsetHeight / 2
    }
  }, [open])

  /** 选日：保留已选的时间；没选过时间就从 00:00 开始（点完能看见具体时刻，不会“半天没反应”） */
  function selectDay(day: Date | undefined): void {
    if (!day) return
    const next = new Date(day)
    if (selected) {
      next.setHours(selected.getHours(), selected.getMinutes(), 0, 0)
    } else {
      next.setHours(0, 0, 0, 0)
    }
    onChange(next)
  }

  /** 选时 / 分：还没选日期就用今天（上游这里直接 return，用户会以为控件坏了） */
  function selectTime(part: "hour" | "minute", amount: number): void {
    const next = selected ? new Date(selected) : new Date()
    next.setSeconds(0, 0)
    if (part === "hour") next.setHours(amount)
    else next.setMinutes(amount)
    onChange(next)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          // ⚠️ 这个控件会被放进 `<form>`（定时任务表单），Button 默认 type 是 submit ——
          // 不写死 button 的话点开选择器会直接把整个表单提交了
          type="button"
          id={id}
          variant="outline"
          disabled={disabled}
          data-empty={!selected}
          className={cn(
            "w-full justify-start text-left font-normal data-[empty=true]:text-muted-foreground",
            className
          )}
        >
          <CalendarIcon className="mr-2 size-4 shrink-0" />
          {selected ? formatDateTime(selected) : placeholder}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto gap-0 p-0">
        <div className="flex">
          <Calendar
            mode="single"
            selected={selected}
            onSelect={selectDay}
            autoFocus
            locale={locale}
            // 只看当前月，不铺相邻月的日期：右边就是时 / 分列，多一排更容易点错
            showOutsideDays={false}
          />
          <div className="flex h-[276px] shrink-0 gap-0.5 border-l border-border/60 p-1">
            {(
              [
                { key: "hour" as const, ref: hourRef, values: hours, step: 1 },
                { key: "minute" as const, ref: minuteRef, values: minutes, step: minuteStep }
              ]
            ).map(({ key, ref, values, step }) => (
              <div
                key={key}
                ref={ref}
                // 两列都能独立滚动；`overscroll-contain` 防止滚到底把整个弹层 / 页面带动
                className="w-12 overflow-y-auto overscroll-contain [scrollbar-width:thin]"
                role="listbox"
                aria-label={key === "hour" ? "小时" : "分钟"}
              >
                {values.map((amount) => {
                  const active =
                    key === "hour"
                      ? selected?.getHours() === amount
                      : // 分钟列是步进刻度：落在 0-4 分之间时高亮 0
                        selected !== undefined &&
                        Math.floor(selected.getMinutes() / step) * step === amount
                  return (
                    <Button
                      key={amount}
                      type="button"
                      size="sm"
                      variant={active ? "default" : "ghost"}
                      role="option"
                      aria-selected={active}
                      data-active={active}
                      onClick={() => selectTime(key, amount)}
                      className="h-7 w-full shrink-0 justify-center px-0 font-normal tabular-nums"
                    >
                      {String(amount).padStart(2, "0")}
                    </Button>
                  )
                })}
              </div>
            ))}
          </div>
        </div>
        {selected && (
          <div className="flex items-center justify-between gap-2 border-t border-border/60 p-1">
            <span className="pl-2 text-xs text-muted-foreground">{formatDateTime(selected)}</span>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7"
              onClick={() => {
                onChange(undefined)
                setOpen(false)
              }}
            >
              清除
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
