/**
 * 浏览器工具选择器 —— **受控版**：只吃 props，完全不知道 `AgentApp` 的存在。
 *
 * 与 `ModelPicker` / `McpPicker` 同一个分工：
 * - 本文件：渲染 + 交互，`value` / `detected` / `onChange` 全从 props 进；
 * - `ComposerToolbar` 的 `BrowserToggle`（会话）：灌这个会话的偏好与各来源探测结果，
 *   改动经 `saveBrowserSettings` 落回会话；
 * - `TriggerEditDialog`（定时任务）：接表单自己的局部状态，随模板落库。
 *
 * 从原来那个 `pickers.tsx`（已拆散成四个单文件组件）里独立出来，理由与 `McpPicker`
 * 相同：这几颗都是「这一轮装什么能力」的开关（权限 / 模型 / MCP / 浏览器），各自一个
 * 文件，样式与交互仍然只有一份。
 *
 * ## 浏览器工具跑在服务端
 *
 * `browser_*` 由 server 侧装配，用的是**服务端那台机器**的 Chromium / Edge / Chrome，
 * 不依赖用户面前的窗口 —— 所以无人值守的定时任务照样能用，两处摆的是同一颗控件。
 */
import {
  BROWSER_CHANNELS,
  BROWSER_CHANNEL_LABELS,
  type BrowserChannel,
  type BrowserChannelProbe,
  type BrowserSettings
} from '@fizz/contracts'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@fizz/ui/dropdown-menu'
import { Check, Globe, Power } from 'lucide-react'
import { CHAT_ICON_PILL } from '@fizz/agent-kit/features/chat/composer'
import { IconTip } from '@fizz/agent-kit/shared/components/IconTip'
import { cn } from '@fizz/agent-kit/shared/lib/utils'
import { useT } from '@fizz/agent-kit/shared/lib/language'
import { t } from '@fizz/i18n'

/**
 * 工具条上的短标签：契约里的全名太长（`Playwright 自带 Chromium`）会把 tooltip 撑宽。
 * 全名仍留在无障碍名（`aria-label`）与下拉项里。
 */
const CHANNEL_SHORT: Record<BrowserChannel, string> = {
  auto: '自动',
  bundled: '自带 Chromium',
  msedge: 'Edge',
  chrome: 'Chrome'
}

export interface BrowserPickerProps {
  /** 当前偏好（开关 + 来源） */
  value: BrowserSettings
  /** 各来源的探测结果；`undefined` 项 = 还没探测过（不标「未检测到」，免假警报） */
  detected: BrowserChannelProbe[]
  /** 落一次改动（只给变化的字段，调用方自己合并） */
  onChange: (patch: Partial<BrowserSettings>) => void
  disabled?: boolean
}

/**
 * 浏览器工具开关 pill：**开关本身也收进菜单里**，不额外挂第二颗「来源」pill。
 *
 * 两颗并排时（按钮开关 + 来源）有三种状态要靠两个位置的视觉去拼，且「来源」那颗在关闭时
 * 还占着位（宽度随开关变化 → 一排 pill 左右跳）。合成一颗后：要改开关或改渠道都点它。
 *
 * 触发器**只放图标**（与旁边的 MCP 那颗同款 `CHAT_ICON_PILL`）：字（含当前渠道）会被
 * 这一排 pill 的宽度挤来挤去，收进 tooltip 与下拉里更稳。开关状态由**图标颜色**表达
 * （开 = 主题色，关 = 灰），不用底色 —— 工具条上这些按钮 hover 都不许出现背景块。
 */
export function BrowserPicker({ value, detected, onChange, disabled }: BrowserPickerProps) {
  // 订阅语言：tooltip / aria-label 都是渲染期求值的
  useT()
  /** 某个来源的探测结果；`undefined` = 还没探测过 */
  const probeOf = (channel: BrowserChannel) => detected.find((d) => d.channel === channel)

  return (
    <DropdownMenu>
      <IconTip
        label={
          value.enabled
            ? t('浏览器工具：已开启（来源：{source}）', { source: t(CHANNEL_SHORT[value.channel]) })
            : t('浏览器工具：已关闭（点开开启，并可选来源）')
        }
      >
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            disabled={disabled}
            aria-label={t('浏览器工具（{state}，{channel}）', {
              state: value.enabled ? t('已开启') : t('已关闭'),
              channel: t(BROWSER_CHANNEL_LABELS[value.channel])
            })}
            className={CHAT_ICON_PILL}
          >
            <Globe
              className={cn(
                'size-3.5 shrink-0',
                value.enabled ? 'text-primary' : 'text-muted-foreground'
              )}
            />
          </button>
        </DropdownMenuTrigger>
      </IconTip>
      {/* 与同排的 MCP / 模型 / 权限 pill 统一口径：向上弹 + 6px 间距 + 8px 碰撞留白。
          表单里也向上弹 —— 方向不该因为宿主不同就翻面（见 `composer.tsx`）。 */}
      <DropdownMenuContent side="top" align="start" sideOffset={6} collisionPadding={8}>
        <DropdownMenuItem onSelect={() => onChange({ enabled: !value.enabled })}>
          <Power
            className={cn(
              'size-3.5 shrink-0',
              value.enabled ? 'text-primary' : 'text-muted-foreground'
            )}
          />
          <span className="truncate">{value.enabled ? t('关闭浏览器工具') : t('开启浏览器工具')}</span>
          <Check
            className={cn(
              'ml-auto size-3.5 shrink-0 pl-3',
              value.enabled ? 'opacity-100' : 'opacity-0'
            )}
          />
        </DropdownMenuItem>
        {/*
          来源分组：改渠道**不必先开着浏览器**（开着才有意义的选择会让「想换渠道」被
          「没开着」这一步挡住）。未开启时照常可选，改完开着就能直接用。
        */}
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="px-2 py-1.5 text-xs font-normal text-muted-foreground">
          {t('来源（改完下一轮生效）')}
        </DropdownMenuLabel>
        {BROWSER_CHANNELS.map((channel) => {
          // `auto` 没有对应的可执行文件，可用性取决于「有没有任一个具体来源」
          const probe = probeOf(channel)
          const missing =
            channel === 'auto'
              ? detected.length > 0 && !detected.some((d) => d.available)
              : probe !== undefined && !probe.available
          return (
            <DropdownMenuItem
              key={channel}
              onSelect={() => onChange({ channel })}
              title={t('浏览器来源：{channel}', { channel: t(BROWSER_CHANNEL_LABELS[channel]) })}
            >
              <Check
                className={cn(
                  'size-3.5 shrink-0',
                  value.channel === channel ? 'opacity-100' : 'opacity-0'
                )}
              />
              <span className="truncate">{t(BROWSER_CHANNEL_LABELS[channel])}</span>
              {missing && (
                <span className="ml-auto pl-3 text-xs text-muted-foreground">{t('未检测到')}</span>
              )}
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
