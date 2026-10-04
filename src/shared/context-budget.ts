/**
 * 上下文窗口（token）的**唯一真源**。移植自 fishwork（`packages/contracts/src/types.ts`）。
 *
 * ⚠️ 主进程（真正判断要不要压缩）与渲染端（输入框里那个用量圆环的分母）必须用**同一个**值：
 * 两端各写一份默认值的话，圆环显示「还剩 20%」而实际早就压过了，用户看到的数字就是假的。
 * 所以这些常量与解析函数放 shared，两端都从这里取（见 main/services/ai/context.ts 与 ContextRing.tsx）。
 */

/**
 * 模型没单独配窗口时的兜底值（token）。
 *
 * 与「触发阈值」是两回事：阈值是 `窗口 × COMPRESS_TRIGGER_RATIO`，见下。
 */
export const DEFAULT_CONTEXT_WINDOW = 200_000

/**
 * 自动压缩的触发比例：估算超过「窗口 × 此比例」就先把旧轮摘要掉再发。
 *
 * 留出的 20% 不是拍脑袋：它要吸收「系统提示词 + 工具 schema 的估算误差」与「本轮输出预留」
 * 两部分 —— 不可能等到把窗口真正塞满才压，那时上游已经先报 context_length_exceeded 了。
 * 前后端共用它：圆环据此画「触发线」，与真正触发压缩的阈值逐字一致。
 */
export const COMPRESS_TRIGGER_RATIO = 0.8

/**
 * 解析某个模型的上下文窗口：显式配置 > 遗留预算 > 兜底值。
 *
 * `legacyBudget` 是**老数据兼容**（`AiModelConfig.contextBudget`，改成按模型配之前是
 * 「一份配置一个数字」）：有它就按它算，而不是让老配置平白从 80k 跳到 200k ——
 * 那等于替用户改了配置。⚠️ 不要把 `contextBudget` 从类型里删掉，删了老数据里的值就成了死字段。
 *
 * 非正数 / 非有限数一律当「没配」—— 手改坏的 JSON 不该让阈值变成 0 或 NaN
 * （那会让每一轮都触发压缩）。
 */
export function resolveContextWindow(
  contextWindows: Record<string, number> | undefined,
  modelId: string | undefined,
  legacyBudget?: number
): number {
  const raw = modelId ? contextWindows?.[modelId] : undefined
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return Math.floor(raw)
  return positiveOr(legacyBudget, DEFAULT_CONTEXT_WINDOW)
}

/** 正的有限数取整，否则用兜底值 */
function positiveOr(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback
}

/** 窗口 → 「200k / 1M」这类短标签（设置页模型行与圆环详情共用） */
export function formatContextWindow(tokens: number): string {
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000
    return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`
  }
  if (tokens >= 1000) {
    const thousands = tokens / 1000
    return `${Number.isInteger(thousands) ? thousands : thousands.toFixed(1)}k`
  }
  return String(tokens)
}
