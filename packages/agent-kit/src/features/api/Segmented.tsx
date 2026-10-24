/**
 * 分段控件（横向 radio）：目前只剩 WS 日志筛选在用。
 *
 * 用 Radix `ToggleGroup`（`variant="outline"` + `spacing={0}`）让相邻段共享边框。
 *
 * ⚠️ 切换**面板**的地方一律用 `@fizz/ui/tabs` 的 shadcn `Tabs`，不要用这里：
 *
 * - `ApiPage` 那三处（请求头 / 参数 / 请求体、请求体形态、响应体 / 响应头）；
 * - 「导入 OpenAPI / Swagger」弹窗的来源切换（从文件 / 从 URL）。
 *
 * 理由是**语义**：ToggleGroup 在 DOM 里是 `role="radiogroup"` + 单选按钮，读屏念的是
 * 「单选按钮，已选中」；Tabs 才给得到「触发器 ↔ 面板」同源的无障碍关系
 * （`aria-controls` / `aria-labelledby`），念的是「从文件，标签页 1/2」。
 * 这里留下的是「选一个筛选条件、内容不变」的场景，分段控件仍更贴切。
 */
import { ToggleGroup, ToggleGroupItem } from '@fizz/ui/toggle-group'
import { cn } from '@fizz/agent-kit/shared/lib/utils'

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  className
}: {
  options: ReadonlyArray<{ value: T; label: string }>
  value: T
  onChange: (value: T) => void
  className?: string
}) {
  return (
    <ToggleGroup
      type="single"
      variant="outline"
      size="sm"
      spacing={0}
      value={value}
      onValueChange={(v) => {
        if (v) onChange(v as T)
      }}
      className={cn('w-fit shrink-0', className)}
    >
      {options.map((o) => (
        <ToggleGroupItem key={o.value} value={o.value} className="grow basis-0">
          {o.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}