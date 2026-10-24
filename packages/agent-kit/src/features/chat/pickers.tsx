/**
 * 输入行里那两颗 pill 的**受控版**：工作区、MCP。
 *
 * 从 `ChatPanel` 里抽出来，是因为「定时任务」表单也要同一套控件（用户明确要求：把创建
 * 会话里的权限 / 模型 / 工作区 / MCP / 需求框复用到定时任务上）。那边没有 `AgentApp`，
 * 只能吃 `value` + `onChange`，所以这里**只做展示与交互**，数据从 props 进。
 *
 * `ChatPanel` 里的 `WorkspaceSelect` / `McpSelect` 现在是薄壳：把 `app` 里的数据灌进来，
 * 再加自己的副作用（切档回空会话、添加项目）。样式与结构只有这一份实现 —— 别再在
 * 别处手写一份 `CHAT_PILL`，两处一漂看着就是两个功能。
 *
 * 权限 / 模型那两颗本来就已经是受控的（`composer.tsx` 的 `PermissionPill` /
 * `ModelPill`），直接复用，不在这里再包一层。
 */
import type { AgentWorkspace } from '@fizz/contracts/agent-api'
import {
  BROWSER_CHANNELS,
  BROWSER_CHANNEL_LABELS,
  type BrowserChannel,
  type BrowserChannelProbe,
  type BrowserSettings
} from '@fizz/contracts'
import type { McpServerConfig } from '@fizz/mcp/types'
import { mcpServerSummary } from '@fizz/mcp/types'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@fizz/ui/dropdown-menu'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@fizz/ui/select'
import { Check, ChevronDown, FolderOpen, Globe, Power, Wrench } from 'lucide-react'
import { CHAT_ICON_PILL, CHAT_PILL } from '@fizz/agent-kit/features/chat/composer'
import { IconTip } from '@fizz/agent-kit/shared/components/IconTip'
import { cn } from '@fizz/agent-kit/shared/lib/utils'
import { useT } from '@fizz/agent-kit/shared/lib/language'
import { t } from '@fizz/i18n'

/**
 * 「未指定工作区」在 Select 里的替身值 —— **只在渲染层存在**，不落库、不进请求。
 *
 * Radix Select 不接受空字符串值，而「没选工作区」在状态里就是 `null`；这一层把它映射成
 * 一个哨兵字符串，`onChange` 时再换回 `null`。别把它传出去。
 */
const NO_WORKSPACE_VALUE = '__no_workspace__'

export interface WorkspacePillProps {
  /** 选中的工作区 id；`null` = 不用现成工作区（真正落地时自动建一个临时目录） */
  value: string | null
  /** 可选项：**由调用方筛好**（临时工作区不该出现在下拉里，见 ChatPanel） */
  workspaces: AgentWorkspace[]
  onChange: (id: string | null) => void
  /** 「不选」那一项的文案：聊天是「未指定工作区」，定时任务是「每次运行自动创建」 */
  emptyLabel?: string
  /** 触发器悬停说明（讲清「不选」到底会发生什么） */
  title?: string
  /** 列表尾部的动作项（选择文件夹 / 从 Git 导入），点中走 `onAction`、不改变 value */
  actions?: { value: string; label: string }[]
  onAction?: (value: string) => void
  disabled?: boolean
}

/**
 * 工作区 pill：一个下拉选「这条消息 / 这次运行落在哪个工作区」。
 *
 * 聊天里它挂在输入卡片**下面**、只在空会话出现；定时任务表单里它是普通的一颗 pill。
 * 两者语义一致：**`null` 不是一种归属**，只是「还没选」—— 真正的落地动作（建临时
 * 工作区）在服务端，前端只负责把这个意图送出去。
 */
export function WorkspacePill({
  value,
  workspaces,
  onChange,
  // 默认值在调用时求值：`t()` 读当前语言，切成英文后父级重渲染就会跟着变
  emptyLabel = t('未指定工作区'),
  title = t('工作区：Agent 只能读写这个目录里的东西'),
  actions,
  onAction,
  disabled
}: WorkspacePillProps) {
  // 订阅语言（默认值里的 t() 只在本组件重渲染时才会重算）
  useT()
  const current = value ? workspaces.find((workspace) => workspace.id === value) : undefined
  // 选中的那个已经不在清单里（被删 / 临时工作区没传进来）→ 退回「不选」，别显示成一个 id
  const selectValue = current ? current.id : NO_WORKSPACE_VALUE
  const label = current?.name ?? emptyLabel

  return (
    <Select
      value={selectValue}
      disabled={disabled}
      onValueChange={(next) => {
        if (next === selectValue) return
        if (actions?.some((action) => action.value === next)) {
          onAction?.(next)
          return
        }
        onChange(next === NO_WORKSPACE_VALUE ? null : next)
      }}
    >
      <SelectTrigger
        className={CHAT_PILL}
        // 贴输入卡片外面：与卡片内的权限 pill 同一层视觉，仍不露默认箭头（自己画一枚小的）
        icon={false}
        aria-label={t('工作区')}
        title={title}
      >
        <FolderOpen className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate">{label}</span>
        <ChevronDown className="size-3 shrink-0 text-muted-foreground/70" />
      </SelectTrigger>
      {/* 一般贴在输入框下方，所以向下弹（Radix 会在贴底时自动翻转） */}
      <SelectContent position="popper" side="bottom" align="start" sideOffset={6}>
        <SelectItem value={NO_WORKSPACE_VALUE}>{emptyLabel}</SelectItem>
        {workspaces.map((workspace) => (
          <SelectItem key={workspace.id} value={workspace.id}>
            {workspace.name}
          </SelectItem>
        ))}
        {(actions ?? []).map((action) => (
          <SelectItem key={action.value} value={action.value} className="text-primary">
            {action.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

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

export interface BrowserPillProps {
  /** 当前偏好（开关 + 来源） */
  value: BrowserSettings
  /** 各来源的探测结果；`undefined` 项 = 还没探测过（不标「未检测到」，免假警报） */
  detected: BrowserChannelProbe[]
  /** 落一次改动（只给变化的字段，调用方自己合并） */
  onChange: (patch: Partial<BrowserSettings>) => void
}

/**
 * 浏览器工具开关 pill（受控版）：**开关本身也收进菜单里**，不额外挂第二颗「来源」pill。
 *
 * 两颗并排时（按钮开关 + 来源）有三种状态要靠两个位置的视觉去拼，且「来源」那颗在关闭时
 * 还占着位（宽度随开关变化 → 一排 pill 左右跳）。合成一颗后：要改开关或改渠道都点它。
 *
 * 触发器**只放图标**（与旁边的 MCP 那颗同款 `CHAT_ICON_PILL`）：字（含当前渠道）会被
 * 这一排 pill 的宽度挤来挤去，收进 tooltip 与下拉里更稳。开关状态由**图标颜色**表达
 * （开 = 主题色，关 = 灰），不用底色 —— 工具条上这些按钮 hover 都不许出现背景块。
 *
 * 浏览器工具**跑在服务端**（`browser_*` 由 server 侧装配、用的是服务端那台机器的
 * Chromium / Edge / Chrome），所以它同样适用于无人值守的定时任务 —— 定时任务表单里
 * 也摆这一颗（与聊天里同一份实现，见 `TriggerEditDialog`）。
 */
export function BrowserPill({ value, detected, onChange }: BrowserPillProps) {
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
      {/* 与同排的 MCP / 模型 / 权限 pill 统一口径：向上弹 + 6px 间距 + 8px 碰撞留白 */}
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

export interface McpPillProps {
  /** 设置 → MCP 里配好的清单（空 = 整颗 pill 不渲染：没有可选的东西就别占位置） */
  servers: McpServerConfig[]
  /** 已选中的 server id */
  value: string[]
  onChange: (ids: string[]) => void
}

/**
 * MCP pill：多选下拉，触发器只放图标 + 数量角标。
 *
 * 只认**当前还存在**的 server：设置里删掉某个之后，本地那份清单要等下一次 WS 推送才清掉，
 * 在那之前直接按它算数量会显示「MCP · 2」却只剩一个可选 —— 看着像 bug。
 * 服务端 `setConversationTarget` 也会剔除已删除的 id，两边一致。
 */
export function McpPill({ servers, value, onChange }: McpPillProps) {
  useT()
  if (servers.length === 0) return null

  const selected = value.filter((id) => servers.some((server) => server.id === id))
  const count = selected.length

  const toggle = (id: string, on: boolean): void => {
    onChange(on ? [...selected, id] : selected.filter((x) => x !== id))
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {/* 触发器只放图标：已选数量收成右上角小角标（0 个不显示），选了哪些进 tooltip */}
        <button
          type="button"
          aria-label={
            count > 0 ? t('选择 MCP（已选 {count} 个）', { count }) : t('选择 MCP')
          }
          className={cn(CHAT_ICON_PILL, 'relative')}
        >
          <Wrench className="size-3.5 shrink-0 text-muted-foreground" />
          {count > 0 && (
            <span
              className="pointer-events-none absolute -top-0.5 -right-0.5 min-w-3.5 rounded-full bg-primary px-0.5 text-center text-[0.5625rem] leading-3.5 font-medium text-primary-foreground tabular-nums"
              aria-hidden
            >
              {count}
            </span>
          )}
        </button>
      </DropdownMenuTrigger>
      {/* 与两个 Select / 模型菜单同款：向上弹 + 6px 间距（触发器贴着窗口底部） */}
      <DropdownMenuContent
        side="top"
        align="start"
        sideOffset={6}
        collisionPadding={8}
        className="min-w-56"
      >
        <DropdownMenuLabel className="px-2 py-1.5 text-xs font-normal text-muted-foreground">
          {t('选择 MCP')}
        </DropdownMenuLabel>
        {servers.map((server) => (
          <DropdownMenuCheckboxItem
            key={server.id}
            checked={selected.includes(server.id)}
            // 受控：勾选状态由外部清单决定，回车 / 点左侧方块都走同一个 toggle。
            // `preventDefault` 是关键 —— 否则 Radix 选中后立刻关闭菜单，多选根本没法连点。
            onCheckedChange={(v) => toggle(server.id, v === true)}
            onSelect={(e) => e.preventDefault()}
            title={mcpServerSummary(server)}
          >
            <span className="truncate">{server.name}</span>
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
