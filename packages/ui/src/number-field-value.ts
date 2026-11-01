/**
 * `NumberField` 的纯逻辑：草稿文本 ⇄ 数值。
 *
 * 为什么单独一个文件（而不是写在 `number-field.tsx` 里）：仓库的测试只跑 node 环境、
 * 没有 jsdom（见 AGENTS.md 的「测试」一节），组件渲染不了，但这几个判定全是纯函数 ——
 * 抽出来就能直接测「删空不许回填」「越界夹边界」这些真正会回归的行为。
 */

/** 一个数字输入框的可接受区间与兜底口径 */
export interface NumberDraftRange {
  /** 下界（含）；缺省 = 不设下界 */
  min?: number
  /** 上界（含）；缺省 = 不设上界 */
  max?: number
  /** 只接受整数（默认 true）：打字过程中的小数不提交，失焦时四舍五入 */
  integer?: boolean
  /**
   * 越界时夹到最近的边界（默认 true）。
   *
   * `false` = `min` / `max` 只用来标红与提示，值**原样提交**，由调用方自己报错或拦保存。
   * 用在「不许悄悄改用户填的数」的地方（子任务步数、容器限额、token 数）。
   */
  clamp?: boolean
  /** 草稿彻底无法解析（乱码）时回到它：通常是当前已保存的值；`null` = 空 */
  fallback: number | null
}

/**
 * 草稿文本 → 数值；空串 / 半截输入（`-`、`.`）/ 指数写法一律 `null`。
 *
 * **不做取整、不做夹紧** —— 调用方要区分「还能继续打的半截输入」和「已经越界的完整数字」。
 * 认十进制就够了：`<input type="number">` 里正常打字不会产出别的形状，而
 * `Number('0x10')` / `Number('1e5')` 这类宽松解析放进设置项只会让人意外。
 */
export function parseNumberDraft(raw: string): number | null {
  const trimmed = raw.trim()
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(trimmed)) return null
  const value = Number(trimmed)
  return Number.isFinite(value) ? value : null
}

/** 夹到 [min, max]；`NaN` 原样返回（调用方自己兜底） */
export function clampNumber(value: number, min?: number, max?: number): number {
  if (!Number.isFinite(value)) return value
  let next = value
  if (min !== undefined && next < min) next = min
  if (max !== undefined && next > max) next = max
  return next
}

/**
 * 草稿现在就能生效吗 —— 打字过程中用它决定「要不要立刻提交」。
 *
 * 只有**完整、在区间内**的值才算数：`""`（刚删干净）、`"-"`、`"12."` 都不提交，
 * 所以输入框里是什么就一直是用户自己打的那些字符，不会被 store 的旧值顶回去。
 *
 * ⚠️ 区间判定与 `clamp` 无关：越界值一律**不在打字过程中提交**，否则每敲一个字符
 * 都会触发一次「超出范围」的提示（调用方通常会在提交时校验并 toast）。
 */
export function isDraftCommittable(raw: string, range: NumberDraftRange): boolean {
  const value = parseNumberDraft(raw)
  if (value === null) return false
  if (range.integer !== false && !Number.isInteger(value)) return false
  if (range.min !== undefined && value < range.min) return false
  if (range.max !== undefined && value > range.max) return false
  return true
}

/**
 * 失焦 / 卸载时的归一化结果（**这是唯一会把草稿改写掉的地方**）。
 *
 * - 空输入 → `null`（「留空」本身就是一种取值，由调用方决定回默认值还是不限制）
 * - 无法解析（乱码）→ `fallback`（当前已保存的值，别让一个错字把配置清空）
 * - 需要整数 → 四舍五入
 * - 越界 → `clamp` 为真时夹到最近的边界（夹完界面上看得见，不是「填了没生效」）；
 *   为假时原样提交
 */
export function normalizeNumberDraft(raw: string, range: NumberDraftRange): number | null {
  const parsed = parseNumberDraft(raw)
  if (parsed === null) return raw.trim() === '' ? null : range.fallback
  const value = range.integer === false ? parsed : Math.round(parsed)
  return range.clamp === false ? value : clampNumber(value, range.min, range.max)
}
