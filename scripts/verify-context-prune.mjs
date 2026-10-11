/**
 * 跑 `scripts/context-prune.test.ts` —— 它 import 的是
 * `src/main/services/ai/agent-core/prune.ts` 的**真实源码**（不是手抄的副本）。
 *
 * 与 `verify-context-compression.mjs` 同一套路：`node --experimental-strip-types` 只擦类型、
 * 不解析相对 import 的扩展名、也不认 `@shared/*` 别名，所以先把要跑的文件复制到 `.tooltest/`
 * 并**只改写 import 说明符**，再执行。复制的是真文件、逻辑一字未改。
 *
 * prune.ts 只依赖 `@shared/context-budget`（值 import）与 `ai` 的**类型**（擦类型后消失），
 * 所以需要搬的只有这两份 + 测试文件本身。
 *
 * 跑：node scripts/verify-context-prune.mjs
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TMP = join(ROOT, '.tooltest')

const FILES = [
  ['src/main/services/ai/agent-core/prune.ts', 'ai/agent-core/prune.ts'],
  ['src/shared/context-budget.ts', 'shared/context-budget.ts'],
  ['scripts/context-prune.test.ts', 'context-prune.test.ts']
]

/** 每个文件要改写的 import 说明符 */
const REWRITES = {
  'ai/agent-core/prune.ts': [
    // context-budget 是 shared 里的值 import（estimateTokens），擦类型不会消失，得改写别名
    ["from '@shared/context-budget'", "from '../../shared/context-budget.ts'"]
  ],
  'context-prune.test.ts': [
    ["from '../ai/agent-core/prune.ts'", "from './ai/agent-core/prune.ts'"],
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
  ['--experimental-strip-types', join(TMP, 'context-prune.test.ts')],
  { stdio: 'inherit', cwd: ROOT }
)

rmSync(TMP, { recursive: true, force: true })
process.exit(res.status ?? 1)
