/**
 * 容器资源限额（内存 / CPU）的校验与归一化。
 *
 * 这两项只由 `docker run` 的 `--memory` / `--cpus` 决定 —— 改配置**不会**影响已经在跑的
 * 容器，必须重建才生效（见 `lifecycle.ts` 的 `specOf`）。语义：**缺省 / 0 = 不限制**，
 * 留给 docker 默认。
 *
 * 边界常量住在 `@fizz/contracts/types`（前端弹窗要用同一份做即时校验），这里只管
 * 「校验成人话」与「落盘前归一化」—— 单独一个文件是为了「新建」与「修改」共用同一套口径，
 * 否则很容易出现「新建时能填 1MB、修改时被拒」这种两套边界。
 */
import {
  CONTAINER_CPUS_MAX,
  CONTAINER_MEMORY_LIMIT_MAX_MB,
  CONTAINER_MEMORY_LIMIT_MIN_MB
} from '@fizz/contracts/types'

/** 落盘前归一化：0 / 负数 = 不限制（`0`），小数内存向下取整到 MB */
export function normalizeMemoryLimitMb(value: number): number {
  return value > 0 ? Math.floor(value) : 0
}

/** 落盘前归一化：0 / 负数 = 不限制（`0`）；CPU 保留两位小数（`--cpus 1.25` 是合法的） */
export function normalizeCpus(value: number): number {
  return value > 0 ? Math.round(value * 100) / 100 : 0
}

/**
 * 校验入参（`undefined` = 不改 / 不设）。返回**可直接展示**的人话原因，合法时 `undefined`。
 *
 * ⚠️ 入参来自 HTTP body，类型声明不可信 —— 逐项判 `typeof number`，别让字符串 `"2"`
 * 混进去变成 `--memory 2m`（docker 会直接拒绝启动，报错还离这里很远）。
 */
export function resourceInputError(input: {
  memoryLimitMb?: unknown
  cpus?: unknown
}): string | undefined {
  const memory = input.memoryLimitMb
  if (memory !== undefined) {
    if (typeof memory !== 'number' || !Number.isFinite(memory)) {
      return '内存上限必须是数字（单位 MB）'
    }
    if (memory < 0) return '内存上限不能是负数'
    if (memory > 0 && memory < CONTAINER_MEMORY_LIMIT_MIN_MB) {
      return `内存上限不能小于 ${CONTAINER_MEMORY_LIMIT_MIN_MB} MB（留空或 0 表示不限制）`
    }
    if (memory > CONTAINER_MEMORY_LIMIT_MAX_MB) {
      return `内存上限不能超过 ${CONTAINER_MEMORY_LIMIT_MAX_MB} MB`
    }
  }

  const cpus = input.cpus
  if (cpus !== undefined) {
    if (typeof cpus !== 'number' || !Number.isFinite(cpus)) {
      return 'CPU 上限必须是数字（单位：核）'
    }
    if (cpus < 0) return 'CPU 上限不能是负数'
    if (cpus > CONTAINER_CPUS_MAX) return `CPU 上限不能超过 ${CONTAINER_CPUS_MAX} 核`
  }

  return undefined
}
