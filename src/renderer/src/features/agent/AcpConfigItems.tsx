/**
 * ACP 会话的工具行：**agent 广告出来的会话配置项**。
 *
 * ACP 把「这个会话用什么」统一表达成 `configOptions`（`session/new` / `session/load`
 * 时取回，`config_option_update` 时刷新）。模型只是其中 `category: 'model'` 的那一项，
 * 实际常见的还有思考档位（`thought_level`）、各类开关（boolean）… 凡是 agent 广告了、
 * 又不是模型 / 档位的，都在这里列出来，让用户看到并能切。
 *
 * 三条纪律：
 * - **一切切换都走 `session/set_config_option`，不重建会话** —— 重建会丢 agent 侧上下文。
 * - **不认识的就照原样展示**：协议允许 `category` 缺失或未知，展示只依赖 `name`，
 *   下发只依赖 `id`，所以第三方自定义项天然能用。
 * - **乐观更新**：点完立刻改本地 `acpStates` 里的当前值（agent 的
 *   `config_option_update` 回来会再校正一次），否则下发走 IPC 的那几百毫秒里
 *   控件会弹回旧值，看着像没生效。
 */
import { Select, Switch } from 'antd'
import { cn } from 'cn'
import type { AcpConfigOption } from '@shared/types'

export interface AcpConfigItemsProps {
  /** agent 广告出来的配置项（调用方已滤掉模型项与档位项） */
  options: AcpConfigOption[]
  /** 下发一个配置项（`session/set_config_option`） */
  onChange: (optionId: string, value: string | boolean) => void
  /** 正在建 agent 侧会话：此时还没有这些配置项，渲染成占位提示 */
  preparing?: boolean
  className?: string
}

export function AcpConfigItems({
  options,
  onChange,
  preparing = false,
  className
}: AcpConfigItemsProps) {
  if (options.length === 0) {
    // 有正在建的会话就说明白在等什么；agent 压根没广告就一句带过（不是故障）
    if (!preparing) return null
    return (
      <div className={cn('px-2 pb-1 text-[11px] text-muted-foreground/70', className)}>
        正在连接 Agent，正在获取它的会话配置…
      </div>
    )
  }
  return (
    <div className={cn('flex flex-wrap items-center gap-x-3 gap-y-1 px-2 pb-1', className)}>
      {options.map((option) => (
        <ConfigItem key={option.id} option={option} onChange={onChange} />
      ))}
    </div>
  )
}

function ConfigItem({
  option,
  onChange
}: {
  option: AcpConfigOption
  onChange: (optionId: string, value: string | boolean) => void
}) {
  if (option.type === 'boolean') {
    return (
      <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Switch
          size="small"
          checked={option.currentValue === true}
          onChange={(checked) => onChange(option.id, checked)}
        />
        <span className="truncate">{option.name}</span>
      </label>
    )
  }
  return (
    <span className="flex items-center gap-1 text-xs text-muted-foreground">
      <span className="shrink-0 truncate">{option.name}</span>
      {/* 宽度交给外层 div —— antd 自己的 width:100% 会吃掉组件上的宽度类（见 6.5 第 21 条） */}
      <div className="w-32 min-w-0">
        <Select
          size="small"
          variant="borderless"
          placement="topLeft"
          className="bare-select w-full"
          value={typeof option.currentValue === 'string' ? option.currentValue : undefined}
          // 用 label 渲染候选名（agent 给的 value 可能是内部 id）
          options={option.options.map((o) => ({ value: o.value, label: o.name }))}
          popupMatchSelectWidth={false}
          onChange={(value) => onChange(option.id, value as string)}
          labelRender={(opt) => <span className="block truncate">{opt.label}</span>}
        />
      </div>
    </span>
  )
}
