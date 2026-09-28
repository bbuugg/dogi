/**
 * Agent `execute_command` 的 Windows POSIX（Git Bash）执行环境验证 —— 跑 agent-core 真源码。
 *
 * 背景：Windows 上模型常按 Linux 习惯发命令（ls / grep / 管道 / $VAR），
 * PowerShell 解析这些会直接报错。修复是注入 Git Bash 的 bash.exe（`AgentToolOptions.bashPath`）。
 *
 * 覆盖：
 *   1. 注入 bashPath 后 POSIX 工具链可用（ls / grep / 管道 / $VAR / pwd 都是 POSIX 语义）；
 *   2. 不注入时回退 PowerShell（且 Windows 盘符路径仍可 cd，说明环境没退化成坏的）；
 *   3. 真源码里 buildAgentTools 暴露的 execute_command 描述会如实声明执行环境。
 *
 * 包装机制同 verify-agent-browser-tools.mjs：复制真源码到临时目录、改写 import
 * 说明符（补 .ts / 换 @shared 别名）再执行 —— agent-core 与 Electron 解耦，能在纯 Node 下跑。
 *
 * 跑：node scripts/verify-agent-posix-command.mjs
 */
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TMP = join(ROOT, '.cmdtest')

const CORE = 'src/main/services/ai/agent-core'
const FILES = [
  [`${CORE}/tools.ts`, 'core/tools.ts'],
  [`${CORE}/skills.ts`, 'core/skills.ts'],
  [`${CORE}/workspace.ts`, 'core/workspace.ts']
]

const REWRITES = {
  'core/tools.ts': [
    ["from './skills'", "from './skills.ts'"],
    ["from './workspace'", "from './workspace.ts'"]
  ],
  'core/skills.ts': [["from './workspace'", "from './workspace.ts'"]]
}

rmSync(TMP, { recursive: true, force: true })
for (const [from, to] of FILES) {
  const dst = join(TMP, to)
  mkdirSync(dirname(dst), { recursive: true })
  let code = readFileSync(join(ROOT, from), 'utf8')
  for (const [find, replace] of REWRITES[to] ?? []) {
    if (!code.includes(find)) {
      console.error(`[verify] 改写失败：${to} 里找不到 ${find}`)
      process.exit(1)
    }
    code = code.replaceAll(find, replace)
  }
  writeFileSync(dst, code)
}

// 探针主体：直接调 buildAgentTools 的 execute_command
// ⚠️ 用数组 join 拼字符串而不是模板字面量：下面全是 shell 命令与正则，
// 反斜杠 / ${} 在模板字面量里会被外层脚本吃掉一层（AGENTS.md 6.5 第 20 条同款坑）
const PROBE = [
  "import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'",
  "import { tmpdir } from 'node:os'",
  "import { join } from 'node:path'",
  "import { buildAgentTools } from './core/tools.ts'",
  '',
  'let pass = 0',
  'let fail = 0',
  'function check(name, ok, detail = \'\') {',
  "  if (ok) { pass++; console.log('  PASS ' + name) }",
  "  else { fail++; console.log('  FAIL ' + name + (detail ? ' — ' + String(detail).slice(0, 300) : '')) }",
  '}',
  '',
  "const root = mkdtempSync(join(tmpdir(), 'dogi-cmd-'))",
  "mkdirSync(join(root, 'sub dir'), { recursive: true })",
  "writeFileSync(join(root, 'a.txt'), 'hello world\\nsecond line\\n')",
  "writeFileSync(join(root, 'b.md'), '# title\\n')",
  '',
  'async function run(toolset, command) {',
  "  const res = await toolset.execute_command.execute({ command }, { toolCallId: 't1', messages: [] })",
  '  return String(res)',
  '}',
  '',
  "const isWin = process.platform === 'win32'",
  'const bashPath = process.env.DOGI_TEST_BASH || null',
  "console.log(isWin ? ('平台 win32，注入 bashPath=' + bashPath) : '平台 POSIX（恒为 bash）')",
  '',
  '// ── 1. 注入 Git Bash：POSIX 工具链与语法 ──',
  '{',
  "  const tools = buildAgentTools(root, { permissionMode: 'full', bashPath })",
  "  const ls = await run(tools, 'ls')",
  "  check('ls 可用（POSIX 工具链在）', /a\\.txt/.test(ls), ls)",
  "  const pipe = await run(tools, 'ls *.txt | wc -l')",
  "  check('管道 + 通配可用', /(^|\\D)1(\\D|$)/.test(pipe), pipe)",
  "  const grep = await run(tools, 'grep -n world a.txt')",
  "  check('grep 参数语义正确（POSIX）', /1:hello world/.test(grep), grep)",
  "  const loop = await run(tools, 'for f in *.md; do echo \"F=$f\"; done')",
  "  check('for 循环 / 变量展开（POSIX）', /F=b\\.md/.test(loop), loop)",
  "  const env = await run(tools, 'echo HOME=$HOME')",
  "  check('环境变量可用', /HOME=\\S/.test(env) && !/HOME=\\s*$/.test(env), env)",
  '}',
  '',
  '// ── 2. 不注入：回退 PowerShell，且不崩 ──',
  '{',
  "  const tools = buildAgentTools(root, { permissionMode: 'full', bashPath: null })",
  "  const pwd = await run(tools, 'pwd')",
  "  check('回退路径仍可执行命令', /退出码 0/.test(pwd), pwd)",
  "  check(isWin ? '回退到 PowerShell（pwd 输出 Windows 盘符路径）' : 'POSIX 下恒 bash', isWin ? /[A-Za-z]:\\\\/.test(pwd) : /退出码 0/.test(pwd), pwd)",
  '}',
  '',
  '// ── 3. 描述如实声明环境 ──',
  '{',
  "  const tools = buildAgentTools(root, { permissionMode: 'full', bashPath })",
  "  const desc = tools.execute_command.description ?? ''",
  "  check('工具描述声明执行环境', isWin ? /Git Bash|POSIX/.test(desc) : /bash/.test(desc), desc.slice(0, 160))",
  '}',
  '',
  'rmSync(root, { recursive: true, force: true })',
  "console.log('\\n===== 通过 ' + pass + ' / 失败 ' + fail + ' =====')",
  'process.exit(fail ? 1 : 0)'
].join('\n')

writeFileSync(join(TMP, 'run.ts'), PROBE)

const child = spawnSync(
  process.execPath,
  ['--experimental-strip-types', join(TMP, 'run.ts')],
  {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, NODE_OPTIONS: undefined }
  }
)

rmSync(TMP, { recursive: true, force: true })
process.exit(child.status ?? 1)
