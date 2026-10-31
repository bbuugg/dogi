/**
 * 浏览器工具开关 —— **受控版**：只吃 props，完全不知道 `AgentApp` 的存在。
 *
 * 单击开启、再点关闭。**没有来源可挑**：来源统一是 Playwright 自带的 headless shell
 * （与 `web_fetch` 的 browser 引擎、screenshot 共用同一份，见 `@fizz/tools` 的
 * `playwright-browsers.ts`）。早先那颗下拉里有「自动 / 自带 / Edge / Chrome」四项，
 * 但它回答的其实是「服务端那台机器上哪个浏览器能用」——用户既看不出差别，也基本只会
 * 选自动；来源恒定之后，开关就该退回成一个开关。装 / 卸在「设置 → 浏览器」。
 *
 * 与 `ModelPicker` / `McpPicker` 同一个分工：
 * - 本文件：渲染 + 交互，`value` / `onChange` 全从 props 进；
 * - `ComposerToolbar` 的 `BrowserToggle`（会话）：灌这个会话的偏好，改动经
 *   `saveBrowserSettings` 落回会话；
 * - `TriggerEditDialog`（定时任务）：接表单自己的局部状态，随模板落库。
 *
 * ⚠️ **浏览器没装时调用方不该渲染它**（见 `ComposerToolbar` 与 `TriggerEditDialog`）：
 * 一个点了会在下一轮报 `Executable doesn't exist` 的按钮，不如不显示。
 *
 * ⚠️ `browser_*` 跑在**服务端那台机器**上，与用户面前的窗口无关 —— 所以无人值守的
 * 定时任务照样能用，两处摆的是同一颗控件。
 */
import type { BrowserSettings } from '@fizz/contracts'
import { CHAT_ICON_PILL } from '@fizz/agent-kit/features/chat/composer'
import { IconTip } from '@fizz/agent-kit/shared/components/IconTip'
import { useT } from '@fizz/agent-kit/shared/lib/language'
import { cn } from '@fizz/agent-kit/shared/lib/utils'
import { Globe } from 'lucide-react'
import { t } from '@fizz/i18n'

export interface BrowserPickerProps {
  /** 当前偏好（实际上只剩开关有意义，`channel` 恒定 `bundled`） */
  value: BrowserSettings
  /** 落一次改动（只给变化的字段，调用方自己合并） */
  onChange: (patch: Partial<BrowserSettings>) => void
  disabled?: boolean
}

/**
 * 触发器**只放图标**（与旁边的 MCP 那颗同款 `CHAT_ICON_PILL`）：字会被这一排 pill 的
 * 宽度挤来挤去，开关状态由**图标颜色**表达（开 = 主题色，关 = 灰）。
 *
 * 不用底色：工具条上这些按钮 hover 都不许出现背景块。
 */
export function BrowserPicker({ value, onChange, disabled }: BrowserPickerProps) {
  // 订阅语言：tooltip / aria-label 都是渲染期求值的
  useT()
  return (
    <IconTip
      label={
        value.enabled
          ? t('浏览器工具：已开启（点击关闭）')
          : t('浏览器工具：已关闭（点击开启，下一轮生效）')
      }
    >
      <button
        type="button"
        disabled={disabled}
        aria-pressed={value.enabled}
        aria-label={value.enabled ? t('关闭浏览器工具') : t('开启浏览器工具')}
        onClick={() => onChange({ enabled: !value.enabled })}
        className={CHAT_ICON_PILL}
      >
        <Globe
          className={cn(
            'size-3.5 shrink-0',
            value.enabled ? 'text-primary' : 'text-muted-foreground'
          )}
        />
      </button>
    </IconTip>
  )
}
