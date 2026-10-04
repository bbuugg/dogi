/**
 * 跑 `scripts/context-compression.test.ts` —— 它 import 的是
 * `src/main/services/ai/context.ts` 的**真实源码**（不是手抄的副本）。
 *
 * 为什么需要这层包装：`node --experimental-strip-types` 只擦类型、不做任何解析转换，
 * 于是源码里两样东西它认不了 ——
 *   1. 无扩展名的相对 import（源码写 `from './resolve-model'`，Node 要求 `'./resolve-model.ts'`）；
 *   2. `@shared/*` 别名（那是 tsconfig 的 paths，只对 tsc / vite 有效）。
 * 所以先把要跑的文件复制到 `.tooltest/` 并**只改写 import 说明符**，再执行。
 * 复制的是真文件、逻辑一字未改 —— 与 verify-agent-browser-tools.mjs 同一套路。
 *
 * resolve-model.ts 一并搬过来：context.ts 要用它建摘要模型，而它的 `@shared/types`
 * 是 type-only import（擦类型时消失），所以不用改别名。
 *
 * 跑：node scripts/verify-context-compression.mjs
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TMP = join(ROOT, '.tooltest')

const FILES = [
  ['src/main/services/ai/context.ts', 'ai/context.ts'],
  ['src/main/services/ai/resolve-model.ts', 'ai/resolve-model.ts'],
  ['src/shared/agent-usage.ts', 'shared/agent-usage.ts'],
  ['src/shared/context-budget.ts', 'shared/context-budget.ts'],
  ['scripts/context-compression.test.ts', 'context-compression.test.ts']
]

/** 每个文件要改写的 import 说明符 */
const REWRITES = {
  'ai/context.ts': [
    ["from './resolve-model'", "from './resolve-model.ts'"],
    // context-budget 是 shared 里的常量 / 解析函数（值 import，擦类型不会消失），得改写别名
    ["from '@shared/context-budget'", "from '../shared/context-budget.ts'"]
  ],
  'context-compression.test.ts': [
    ["from '../ai/context.ts'", "from './ai/context.ts'"],
    ["from '../shared/agent-usage.ts'", "from './shared/agent-usage.ts'"],
    ["from '../shared/context-budget.ts'", "from './shared/context-budget.ts'"]
  ]
}

rmSync(TMP, { recursive: true, force: true })

for (const [from, to] of FILES) {
  const dst = join(TMP, to)
  mkdirSync(dirname(dst), { recursive: true })
  if (!REWRITES[to]) {
    // 没有改写规则的直接复制（type-only import 会被 strip-types 擦掉，不用动）
    copyFileSync(join(ROOT, from), dst)
    continue
  }
  let code = readFileSync(join(ROOT, from), 'utf8')
  for (const [find, replace] of REWRITES[to]) {
    if (!code.includes(find)) {
      console.error(`[verify] 改写失败：${to} 里找不到 ${find}（源码 import 写法变了？）`)
      process.exit(1)
    }
    code = code.split(find).join(replace)
  }
  writeFileSync(dst, code)
}

const res = spawnSync(
  process.execPath,
  ['--experimental-strip-types', join(TMP, 'context-compression.test.ts')],
  { stdio: 'inherit', cwd: ROOT }
)

rmSync(TMP, { recursive: true, force: true })
process.exit(res.status ?? 1)