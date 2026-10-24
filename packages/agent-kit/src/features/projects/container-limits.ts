/**
 * 容器资源限额输入框的共用小工具（「新建容器型项目」与「容器设置」两个弹窗共用）。
 *
 * 边界常量来自 `@fizz/contracts/types`（服务端最终校验用的是同一份），这里只做
 * 「输入框字符串 → 落盘数字」与「即时人话提示」。
 */
import {
  CONTAINER_CPUS_MAX,
  CONTAINER_MEMORY_LIMIT_MAX_MB,
  CONTAINER_MEMORY_LIMIT_MIN_MB
} from '@fizz/contracts/types'

/**
 * 输入框 → 落盘值：**空串 = 0 = 不限制**。
 *
 * 不能用 `undefined` 表达「不限制」—— JSON 会把它丢掉，于是「清空输入框」永远改不掉
 * 旧值（服务端只会收到「不改」）。所以显式发 `0`，服务端再归一化成「不限制」。
 * 非法输入返回 `NaN`（交给 `limitsError` 报出来，不要拿它发请求）。
 */
export function limitOf(raw: string): number {
  const text = raw.trim()
  if (!text) return 0
  const value = Number(text)
  return Number.isFinite(value) ? value : Number.NaN
}

/** 输入是否合法；返回可直接展示的人话原因（合法 = `undefined`） */
export function limitsError(memory: number, cpus: number): string | undefined {
  if (Number.isNaN(memory)) return '内存上限必须是数字'
  if (
    memory !== 0 &&
    (memory < CONTAINER_MEMORY_LIMIT_MIN_MB || memory > CONTAINER_MEMORY_LIMIT_MAX_MB)
  ) {
    return `内存上限需在 ${CONTAINER_MEMORY_LIMIT_MIN_MB}–${CONTAINER_MEMORY_LIMIT_MAX_MB} MB 之间（留空表示不限制）`
  }
  if (Number.isNaN(cpus)) return 'CPU 上限必须是数字'
  if (cpus !== 0 && (cpus <= 0 || cpus > CONTAINER_CPUS_MAX)) {
    return `CPU 上限需大于 0 且不超过 ${CONTAINER_CPUS_MAX} 核（留空表示不限制）`
  }
  return undefined
}
