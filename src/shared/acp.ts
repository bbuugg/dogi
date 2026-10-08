/**
 * ACP agent 风格标记（`AcpAgentType`）的展示文案 —— 主进程与渲染端共用一份。
 *
 * 为什么要有它：设置页的列表徽标（`AcpAgentSettings`）与会话标题旁的徽标
 * （`AgentPage`）要显示同一套文案，两处各写一份迟早会漂。纯常量 + 纯函数，
 * 不引 electron / DOM（`src/shared` 的纪律）。
 *
 * ⚠️ 这些文案**只影响界面标识**，不改变行为（原因见 `AcpAgentType` 的说明）。
 */
import type { AcpAgentType } from './types'

/** 短标签：徽标、下拉选项共用（下拉的说明放在下面那组里） */
export const ACP_AGENT_TYPE_LABELS: Record<AcpAgentType, string> = {
  generic: '通用',
  opencode: 'opencode',
  pi: 'pi'
}

/**
 * 设置页「类型」下拉的选项。
 *
 * 说明文案刻意写「标识」而不是「显示哪块 UI」：dogi 的会话 UI 由 agent 上报的
 * `configOptions.category` 驱动，与这里选什么无关（见 `AcpAgentType`）。
 */
export const ACP_AGENT_TYPE_OPTIONS: Array<{ value: AcpAgentType; label: string }> = [
  { value: 'generic', label: '通用（不额外标识）' },
  { value: 'opencode', label: 'opencode' },
  { value: 'pi', label: 'pi' }
]

/**
 * 徽标文案：**只给非 generic 的**（通用是默认值，每处都挂一枚「通用」徽标等于没标）。
 *
 * 返回 `null` 时调用方直接不渲染徽标 —— 省得每个调用点各判一次。
 */
export function acpAgentTypeLabel(type: AcpAgentType | undefined): string | null {
  if (!type || type === 'generic') return null
  return ACP_AGENT_TYPE_LABELS[type]
}
