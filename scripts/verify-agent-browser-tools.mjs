/**
 * 跑 `scripts/agent-browser-tools.test.ts` —— 它 import 的是
 * `src/main/services/browser/` 的**真实源码**（不是手抄的副本）。
 *
 * 为什么需要这层包装：`node --experimental-strip-types` 只擦类型、不做任何解析转换，
 * 于是源码里两样东西它认不了 ——
 *   1. 无扩展名的相对 import（源码写 `from './session'`，Node 要求 `'./session.ts'`）；
 *   2. `@shared/*` 别名（那是 tsconfig 的 paths，只对 tsc / vite 有效）。
 * 所以先把要跑的文件复制到 `.tooltest/` 并**只改写 import 说明符**，再执行。
 * 复制的是真文件、逻辑一字未改 —— 这是 skill「node-run-ts-without-build」的标准做法。
 *
 * 跑：node scripts/verify-agent-browser-tools.mjs
 */
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TMP = join(ROOT, '.tooltest')

/** 要复制过去并改写 import 的文件（相对 src/） */
const BROWSER_SRC = 'src/main/services/browser'
const FILES = [
  [`${BROWSER_SRC}/agent.ts`, 'browser/agent.ts'],
  [`${BROWSER_SRC}/session.ts`, 'browser/session.ts'],
  [`${BROWSER_SRC}/handlers.ts`, 'browser/handlers.ts'],
  [`${BROWSER_SRC}/input.ts`, 'browser/input.ts'],
  [`${BROWSER_SRC}/resolver.ts`, 'browser/resolver.ts'],
  ['src/main/services/ai/agent-core/workspace.ts', 'ai/agent-core/workspace.ts'],
  // session.ts 现在运行时 import 了视口预设表（@shared/browser），所以它也得一起搬过来
  ['src/shared/browser.ts', 'shared/browser.ts']
]

/** 每个文件要改写的 import 说明符：补上 .ts 扩展名 */
const REWRITES = {
  'browser/agent.ts': [
    ["from './handlers'", "from './handlers.ts'"],
    ["from './session'", "from './session.ts'"],
    ["from '../ai/agent-core/workspace'", "from '../ai/agent-core/workspace.ts'"],
    // 会话 id 推导（agentBrowserSessionId）是运行时 import，一并指向副本
    ["from '@shared/browser'", "from '../shared/browser.ts'"]
  ],
  'browser/session.ts': [
    ["from './input'", "from './input.ts'"],
    ["from './resolver'", "from './resolver.ts'"],
    ["from '@shared/browser'", "from '../shared/browser.ts'"]
  ]
}

rmSync(TMP, { recursive: true, force: true })

for (const [from, to] of FILES) {
  const src = join(ROOT, from)
  const dst = join(TMP, to)
  mkdirSync(dirname(dst), { recursive: true })
  let code = readFileSync(src, 'utf8')
  for (const [find, replace] of REWRITES[to] ?? []) {
    if (!code.includes(find)) {
      console.error(`[verify] 改写失败：${to} 里找不到 ${find}（源码 import 写法变了？）`)
      process.exit(1)
    }
    code = code.replaceAll(find, replace)
  }
  writeFileSync(dst, code)
}

// 测试体原样复制成入口（它的相对 import 已经指向 browser/ 与 ai/ 下的副本）
cpSync(join(ROOT, 'scripts/agent-browser-tools.test.ts'), join(TMP, 'run.ts'))

const child = spawnSync(
  process.execPath,
  ['--experimental-strip-types', join(TMP, 'run.ts')],
  {
    cwd: ROOT,
    stdio: 'inherit',
    // WorkBuddy 会往环境里注入 ELECTRON_RUN_AS_NODE / NODE_OPTIONS，剥掉免得干扰子进程
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, NODE_OPTIONS: undefined }
  }
)

rmSync(TMP, { recursive: true, force: true })
process.exit(child.status ?? 1)
