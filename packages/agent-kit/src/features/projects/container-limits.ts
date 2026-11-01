/**
 * 容器资源限额输入框的共用小工具（「新建容器型项目」与「容器设置」两个弹窗共用）。
 *
 * 边界常量来自 `@fizz/contracts/types`（服务端最终校验用的是同一份），这里只做
 * 「限额 → 人话提示」。
 *
 * 两个弹窗的输入框都是草稿态数字（`@fizz/ui/number-field`），state 是
 * `number | null`（`null` = 空 = 不限制），所以这里不再需要「字符串 → 数字」那一步：
 * 落盘前把 `null` 换成 `0` 即可（不能用 `undefined`：JSON 会把它丢掉，于是「清空输入框」
 * 永远改不掉旧值，服务端只会收到「不改」）。
 */
import {
  CONTAINER_CPUS_MAX,
  CONTAINER_MEMORY_LIMIT_MAX_MB,
  CONTAINER_MEMORY_LIMIT_MIN_MB
} from '@fizz/contracts/types'

/** 输入是否合法；返回可直接展示的人话原因（合法 = `undefined`）。`0` = 不限制 */
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
