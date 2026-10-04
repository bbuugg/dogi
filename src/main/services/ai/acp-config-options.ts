/**
 * ACP 会话配置项的纯逻辑（**不含 electron**，可脱离 Electron 跑真源码做验证）。
 *
 * 两件事：
 * - `extractConfigOptions` / `extractModelOption`：把 agent 广告的 `configOptions`
 *   （`session/new` / `session/load` 的响应，或 `config_option_update` 的通知）收成本应用的
 *   `AcpConfigOption[]`。**不按 `category` 白名单挑** —— 协议明确要求「缺失或未知的 category
 *   必须优雅处理」，第三方自定义项天然可用；这里只认结构（select / boolean）+ `id`。
 * - `usageUpdateToEvent`：把 `session/update` 的 `usage_update`（`{ used, size }`）映射成
 *   `context-usage` 流事件。⚠️ 它**不**折进 `usage`：那个是「这一轮的账」（会话累计要加总），
 *   这个是「此刻挂在 agent 窗口里的 token」（重复上报同一水位，加总会离谱）。
 */
import type { AcpConfigOption, AcpModelList, AgentStreamEvent } from '@shared/types'

/** 协议里的 select 候选项：单条 `{ value, name }` 或分组 `{ options: [...] }` */
type RawSelectOption = { value?: unknown; name?: unknown; options?: unknown }

interface RawConfigOption {
  id?: unknown
  name?: unknown
  category?: unknown
  type?: unknown
  currentValue?: unknown
  options?: unknown
}

function toName(value: unknown, fallback: string): string {
  return typeof value === 'string' && value ? value : fallback
}

/** 把 select 的候选项拍平（分组结构在这里展开，渲染端与下发都只见扁平列表） */
function flattenOptions(raw: unknown): Array<{ value: string; name: string }> {
  if (!Array.isArray(raw)) return []
  const out: Array<{ value: string; name: string }> = []
  for (const item of raw as RawSelectOption[]) {
    if (typeof item?.value === 'string') {
      out.push({ value: item.value, name: toName(item.name, item.value) })
      continue
    }
    const inner = Array.isArray(item?.options) ? (item.options as RawSelectOption[]) : []
    for (const v of inner) {
      if (typeof v?.value !== 'string') continue
      out.push({ value: v.value, name: toName(v.name, v.value) })
    }
  }
  return out
}

/**
 * 收下整组会话配置项。
 *
 * 认不出来的条目**直接丢掉**（而不是塞个半成品进去）：渲染端会照 `options` 渲染下拉，
 * 一条候选项都没有的下拉点了打不开，比不显示更让人困惑。
 */
export function extractConfigOptions(
  configOptions: Array<unknown> | null | undefined
): AcpConfigOption[] {
  const out: AcpConfigOption[] = []
  for (const raw of (configOptions ?? []) as RawConfigOption[]) {
    if (typeof raw?.id !== 'string' || !raw.id) continue
    const base = {
      id: raw.id,
      name: toName(raw.name, raw.id),
      ...(typeof raw.category === 'string' ? { category: raw.category } : {})
    }
    if (raw.type === 'select') {
      const options = flattenOptions(raw.options)
      if (options.length === 0) continue
      out.push({
        ...base,
        type: 'select',
        currentValue: typeof raw.currentValue === 'string' ? raw.currentValue : '',
        options
      })
    } else if (raw.type === 'boolean') {
      out.push({ ...base, type: 'boolean', currentValue: raw.currentValue === true, options: [] })
    }
  }
  return out
}

/** 取「模型选择项」（`category: 'model'` 的 select）——会话页模型下拉的合法候选来源之一 */
export function extractModelOption(
  configOptions: Array<unknown> | null | undefined
): AcpModelList | null {
  const option = extractConfigOptions(configOptions).find(
    (o) => o.category === 'model' && o.type === 'select'
  )
  if (!option || typeof option.currentValue !== 'string') return null
  return { optionId: option.id, currentValue: option.currentValue, models: option.options }
}

/**
 * `usage_update` → 上下文水位事件。
 *
 * 非数字 / 缺失时返回 null（不给一个 0 冒充「上游报的 0」—— 圆环会因此显示「没占过」）。
 */
export function usageUpdateToEvent(update: {
  sessionUpdate: string
  used?: unknown
  size?: unknown
}): AgentStreamEvent | null {
  if (update.sessionUpdate !== 'usage_update') return null
  const used = typeof update.used === 'number' ? update.used : null
  const size = typeof update.size === 'number' ? update.size : null
  if (used === null || size === null) return null
  return { type: 'context-usage', used, budget: size }
}