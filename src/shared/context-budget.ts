/**
 * 上下文预算（token）的**唯一真源**。
 *
 * ⚠️ 主进程（真正判断要不要压缩）与渲染端（输入框里那个用量圆环的分母）必须用**同一个**值：
 * 两边各写一份默认值的话，圆环显示「还剩 20%」而实际早就压过了，用户看到的数字就是假的。
 * 所以这个常量放 shared，两端都从这里取（见 main/services/ai/context.ts 与 ContextRing.tsx）。
 */

/** 默认上下文预算（token）：低于此数不触发压缩。留足系统提示词 + 本轮输入 + 输出余量。 */
export const DEFAULT_CONTEXT_BUDGET = 80_000

/**
 * 解析这一轮真正生效的预算。
 *
 * 非正数 / 非有限数（设置里被清空、或配置文件被手改过）一律回退默认 ——
 * 宁可按默认的 80k 判断，也不能按 0 判断（那会让每轮都触发压缩）。
 */
export function resolveContextBudget(budget?: number): number {
  return typeof budget === 'number' && Number.isFinite(budget) && budget > 0
    ? budget
    : DEFAULT_CONTEXT_BUDGET
}
