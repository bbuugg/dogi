/**
 * 确认卡的裁决选项（三端共享的纯逻辑；类型见 `@shared/types` 的 `ConfirmDecision`）。
 *
 * 内置工具（工作区 Agent / 终端助手）恒为四档；ACP 按 agent 在
 * `session/request_permission` 里广告的 `option.kind` 收窄 ——
 * 硬塞一个 agent 不认的 option 会被静默丢弃（见 `acp-agent.ts` 的 handlePermission）。
 *
 * 放在 shared 而不是各端各写一份：文案必须一致（同一个「总是允许」在 Agent 页与终端助手
 * 面板上不能长得不一样），而且 ACP 的 kind 与我们的档位同名，映射逻辑只该有一处。
 */
import type { ConfirmDecision, ConfirmOption } from './types'

/** 内置工具的四档（顺序即界面上的展示顺序：先放行、后拒绝） */
export const BUILTIN_CONFIRM_OPTIONS: ConfirmOption[] = [
  { value: 'allow_once', label: '允许一次' },
  { value: 'allow_always', label: '总是允许' },
  { value: 'reject_once', label: '拒绝' },
  { value: 'reject_always', label: '总是拒绝' }
]

/** 四档 → 展示文案（日志 / 提示用；找不到时回落到原值，方便排查） */
export const CONFIRM_DECISION_LABELS: Record<ConfirmDecision, string> = {
  allow_once: '允许一次',
  allow_always: '总是允许',
  reject_once: '拒绝',
  reject_always: '总是拒绝'
}

/**
 * 把 ACP 广告的 option.kind 列表收窄成可用档位。
 *
 * ACP 的 kind 取值与我们的档位同名（`allow_once` / `allow_always` / `reject_once` /
 * `reject_always`），所以直接按名字过滤；未知 kind 忽略。结果至少保留「放行 + 拒绝」各一档
 * —— agent 只广告 `allow_once` / `reject_once` 时界面上就只有这两颗按钮。
 */
export function confirmOptionsFromAcpKinds(kinds: string[]): ConfirmOption[] {
  const set = new Set(kinds)
  const picked = BUILTIN_CONFIRM_OPTIONS.filter((o) => set.has(o.value))
  return picked.length ? picked : BUILTIN_CONFIRM_OPTIONS
}

/** 是否放行（两个 `allow_*` 档） */
export function isAllowDecision(decision: ConfirmDecision): boolean {
  return decision === 'allow_once' || decision === 'allow_always'
}
