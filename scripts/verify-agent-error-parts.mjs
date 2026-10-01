/**
 * 跑 `scripts/agent-error-parts.test.ts`（它 import `agent-helpers.ts` 的**真源码**）
 *
 * 为什么需要包装：`agent-helpers.ts` 除了纯函数还 `import { useAppStore } from './app-store'`
 * 与 `isDraftConversation`（后者在 `stores/types.ts`）—— 那两条链路会拖进 zustand / window，
 * 纯 Node 下跑不起来。所以把真源码复制到 `.tooltest/`，**只改写这两条 import 指向本地桩**，
 * 被测的追加逻辑一行未改（思路同 `verify-agent-browser-tools.mjs` / `verify-context-compression.mjs`）。
 *
 * 用法：node scripts/verify-agent-error-parts.mjs
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TMP = join(ROOT, '.tooltest')

rmSync(TMP, { recursive: true, force: true })
mkdirSync(join(TMP, 'stores'), { recursive: true })

/** agent-helpers 里那两条跑不起来的依赖：只要「能import」，测试根本不调用它们 */
writeFileSync(
  join(TMP, 'stores', 'stubs.ts'),
  `export const useAppStore = { getState: () => ({}) } as never
export function isDraftConversation(_c: unknown): boolean {
  return false
}
`,
  'utf8'
)

let code = readFileSync(join(ROOT, 'src/renderer/src/stores/agent-helpers.ts'), 'utf8')
for (const [find, replace] of [
  ["from './app-store'", "from './stubs.ts'"],
  ["from './types'", "from './stubs.ts'"]
]) {
  if (!code.includes(find)) {
    console.error(`[verify] 源码里找不到 ${find}，import 说明符变了？`)
    process.exit(1)
  }
  code = code.split(find).join(replace)
}
writeFileSync(join(TMP, 'stores', 'agent-helpers.ts'), code, 'utf8')

// 测试文件本身只需改 import 路径（`./stores/agent-helpers.ts` 在 .tooltest 下已正确）
writeFileSync(
  join(TMP, 'agent-error-parts.test.ts'),
  readFileSync(join(ROOT, 'scripts/agent-error-parts.test.ts'), 'utf8'),
  'utf8'
)

const res = spawnSync(process.execPath, ['--experimental-strip-types', 'agent-error-parts.test.ts'], {
  cwd: TMP,
  stdio: 'inherit'
})
rmSync(TMP, { recursive: true, force: true })
process.exit(res.status ?? 1)