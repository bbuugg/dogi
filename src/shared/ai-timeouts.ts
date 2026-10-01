/**
 * AI 超时的**缺省值**与设置页的**可选档位**（主进程与渲染端共用一份，避免两处对不上）。
 *
 * 统一语义：`0` = 不限时；缺省值（用户没设过时生效的那个）标在选项文案里。
 * 具体实现与理由见 `main/services/ai/timeouts.ts`，用户可在「设置 → AI → 超时」覆盖。
 */

/** 审批等待的缺省值：不限时（超时是静默的，比挂着一轮更让人困惑） */
export const DEFAULT_CONFIRM_TIMEOUT_MS = 0

/** 模型请求「首个内容块」的缺省超时：5 分钟（与 Node fetch 自身的响应头超时持平） */
export const DEFAULT_MODEL_TIMEOUT_MS = 5 * 60 * 1000

/** Agent 单轮对话允许的最大工具调用步数（AI SDK 的 `maxSteps`） */
export const DEFAULT_MAX_STEPS = 500

/** 模型请求失败后的缺省自动重试次数 */
export const DEFAULT_MAX_RETRIES = 2

/** 「不重试」在设置里的取值（`0` = 不自动重试） */
export const NO_RETRY = 0

/**
 * 取生效的「模型请求自动重试次数」。
 *
 * `0 = 不重试`；其余按非负整数四舍五入。缺省 = `DEFAULT_MAX_RETRIES`。
 *
 * ⚠️ 重试**不再交给 mastra 的 `modelSettings.maxRetries`**（那条路只在 SDK 内部静默重试，
 * 界面上看不到任何迹象）。现在由主进程自己按这个次数重试，每次重试都发一条 `retry` 事件，
 * 界面据此显示「第 N 次重试」。只对**可重试的网络类错误**生效；失败的那一次尝试若
 * 已经执行过工具就不再重试（重试 = 从头再跑一轮，会重复命令 / 写文件等副作用）。
 */
export function resolveMaxRetries(override?: number): number {
  const n = override ?? DEFAULT_MAX_RETRIES
  return Math.max(0, Math.round(n))
}

/**
 * 审批等待的可选档位（确认模式下等用户点「允许 / 拒绝」的时长）。
 *
 * 档位而不是自由输入：这个值给错（比如 3 秒）的后果是「审批卡刚弹就没」，
 * 而它没有任何需要精细调节的场景。
 */
export const CONFIRM_TIMEOUT_OPTIONS: Array<{ value: number; label: string }> = [
  { value: 0, label: '不限时（默认）' },
  { value: 60_000, label: '1 分钟' },
  { value: 5 * 60_000, label: '5 分钟' },
  { value: 10 * 60_000, label: '10 分钟' },
  { value: 30 * 60_000, label: '30 分钟' },
  { value: 60 * 60_000, label: '1 小时' },
  { value: 2 * 60 * 60_000, label: '2 小时' }
]

/** 模型请求超时的可选档位（等模型吐出第一个内容块的时长） */
export const MODEL_TIMEOUT_OPTIONS: Array<{ value: number; label: string }> = [
  { value: 0, label: '不限时' },
  { value: 30_000, label: '30 秒' },
  { value: 60_000, label: '1 分钟' },
  { value: 5 * 60_000, label: '5 分钟（默认）' },
  { value: 10 * 60_000, label: '10 分钟' },
  { value: 30 * 60_000, label: '30 分钟' }
]
