/**
 * Agent 文件工具（read_file / write_file / edit_file）的行为验证 —— 跑 agent-core 真源码
 * （工具定义 API：buildWorkspaceToolDefs 返回静态定义，会话状态经 ToolRunContext 注入）。
 *
 * 参照 opencode 的文件工具设计改造后的关键行为：
 *   1. read_file 大文件分段读取（修复：旧实现超过 20 万字符直接抛错，offset/limit 也救不回来）；
 *      单行截断、续读提示、缺失文件的相似文件建议、目录给出 list_files 指引；
 *   2. 「先读后改」：edit_file / 覆盖 write_file 之前必须本会话 read_file 读过，
 *      读后被外部改动要重读（快照 = mtimeMs + size，按会话存在调用方手里）；
 *   3. edit_file 单处替换语义（oldString/newString/replaceAll）：多处命中报错不猜；
 *      CRLF 文件把模型的 \n 归一成 \r\n 再匹配，写回保留 CRLF；
 *   4. 确认模式：改动类工具的统一闸（guardWrite）依旧生效。
 *
 * 包装机制同 verify-agent-posix-command.mjs：复制真源码到临时目录、改写 import 说明符再执行。
 *
 * 跑：node scripts/verify-agent-file-tools.mjs
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TMP = join(ROOT, '.filetest')

const CORE = 'src/main/services/ai/agent-core'
const AI = 'src/main/services/ai'
const FILES = [
  [`${CORE}/tools.ts`, 'core/tools.ts'],
  [`${CORE}/edit-match.ts`, 'core/edit-match.ts'],
  [`${CORE}/workspace.ts`, 'core/workspace.ts'],
  // tools.ts 里 execute_command 的长输出走产物写入器（不是 value import，但 Node 仍要解析）
  [`${AI}/output-artifact.ts`, 'output-artifact.ts']
]

// tools.ts 对 tool-registry / agent-core 其余模块的引用都是 **type-only import**
//（`--experimental-strip-types` 直接擦除），无需一并复制
const REWRITES = {
  'core/tools.ts': [
    ["from './workspace'", "from './workspace.ts'"],
    ["from './edit-match'", "from './edit-match.ts'"],
    ["from '../output-artifact'", "from '../output-artifact.ts'"]
  ],
  'core/edit-match.ts': [],
  'core/workspace.ts': [],
  'output-artifact.ts': []
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

// 探针主体。⚠️ 用数组 join 拼字符串而不是模板字面量：用例里有正则与 CRLF 字面量，
// 模板字面量会把反斜杠 / ${} 吃掉一层（AGENTS.md 6.5 第 20 条同款坑）
const PROBE = [
  "import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, utimesSync, statSync } from 'node:fs'",
  "import { tmpdir } from 'node:os'",
  "import { join } from 'node:path'",
  "import { buildWorkspaceToolDefs, createAgentFileState } from './core/tools.ts'",
  '',
  'let pass = 0',
  'let fail = 0',
  'function check(name, ok, detail = \'\') {',
  "  if (ok) { pass++; console.log('  PASS ' + name) }",
  "  else { fail++; console.log('  FAIL ' + name + (detail ? ' — ' + String(detail).slice(0, 300) : '')) }",
  '}',
  '',
  'const root = mkdtempSync(join(tmpdir(), \'dogi-filetools-\'))',
  '',
  "function call(tool, input) {",
  "  return tool.execute(input, { toolCallId: 't1', messages: [] })",
  '}',
  '',
  '// ── 把静态工具定义包成可直接 execute 的形状（会话状态经 ToolRunContext 注入） ──',
  "const workspace = { id: 'w', name: 'probe', path: root, createdAt: 0, updatedAt: 0 }",
  'function makeTools(opts = {}) {',
  "  const ctx = {",
  "    requestId: 'r1',",
  "    conversationId: 'c1',",
  "    scope: 'workspace',",
  '    workspace,',
  '    signal: new AbortController().signal,',
  "    permissionMode: opts.permissionMode ?? 'full',",
  '    requestConfirm: opts.requestConfirm ?? (async () => false),',
  '    fileState: opts.fileState ?? createAgentFileState(),',
  '    skills: [],',
  '    bashPath: null',
  '  }',
  '  const tools = {}',
  '  for (const def of buildWorkspaceToolDefs()) {',
  '    tools[def.name] = {',
  "      execute: (input, options) => def.execute(input, { toolCallId: options?.toolCallId ?? 't1' }, ctx)",
  '    }',
  '  }',
  '  return tools',
  '}',
  '/** 期望工具「回绝」（返回字符串，不抛错） */',
  'async function expectRefusal(name, tool, input, pattern) {',
  '  const res = await call(tool, input)',
  "  check(name, typeof res === 'string' && pattern.test(res), String(res))",
  '}',
  '/** 期望工具抛错（结果送回模型的是 tool-error） */',
  'async function expectError(name, tool, input, pattern) {',
  '  try {',
  '    const res = await call(tool, input)',
  "    check(name, false, '没有抛错，返回：' + String(res).slice(0, 120))",
  '  } catch (e) {',
  "    check(name, pattern.test(e.message), e.message)",
  '  }',
  '}',
  '',
  '// ── 1. read_file：大文件分段（旧实现 >20 万字符连 offset/limit 也抛错） ──',
  '{',
  "  const big = Array.from({ length: 6000 }, (_, i) => 'line-' + i + '-' + 'x'.repeat(38)).join('\\n')",
  "  writeFileSync(join(root, 'big.txt'), big)",
  "  const tools = makeTools()",
  '  const first = await call(tools.read_file, { path: \'big.txt\' })',
  "  check('大文件默认读取不再抛错（返回 2000 行以内）', typeof first === 'string' && /共 6000 行/.test(first), String(first).slice(0, 120))",
  "  const m = String(first).match(/offset=(\\d+) 继续读取/)",
  "  check('结尾给出续读 offset', !!m, String(first).slice(-160))",
  "  const nextOff = Number(m && m[1])",
  "  const second = await call(tools.read_file, { path: 'big.txt', offset: nextOff, limit: 10 })",
  "  check('续读从提示的 offset 开始', String(second).startsWith('big.txt（共 6000 行）\\n' + nextOff + ': '), String(second).slice(0, 120))",
  "  check('续读内容不是从头开始', !/^big\\.txt（共 6000 行）\\n1: /.test(second), String(second).slice(0, 120))",
  "  const tail = await call(tools.read_file, { path: 'big.txt', offset: 5990 })",
  "  check('读到文件尾给「文件结尾」提示', /文件结尾，共 6000 行/.test(String(tail)), String(tail).slice(-120))",
  "  await expectError('offset 越界明确报错', tools.read_file, { path: 'big.txt', offset: 99999 }, /超出范围/)",
  '}',
  '',
  '// ── 2. read_file：行截断 / 相似文件建议 / 目录指引 ──',
  '{',
  "  writeFileSync(join(root, 'longline.txt'), 'ok\\n' + 'y'.repeat(3000) + '\\nend\\n')",
  "  const tools = makeTools()",
  '  const res = await call(tools.read_file, { path: \'longline.txt\' })',
  "  check('超长行截断并标注', /（本行超长，已截断）/.test(String(res)), String(res).slice(0, 200))",
  "  check('截断后的行不超过上限（2000 + 提示）', String(res).split('\\n').every((l) => l.length < 2100), '')",
  "  writeFileSync(join(root, 'app.tsx'), 'export default 1\\n')",
  "  await expectError('找不到文件时给出相似文件建议', tools.read_file, { path: 'app.ts' }, /app\\.tsx/)",
  "  await expectError('目录路径指引去 list_files', tools.read_file, { path: '.' }, /list_files/)",
  "  writeFileSync(join(root, 'bin.dat'), Buffer.from([0x50, 0x4b, 0x00, 0x00, 0x01]))",
  "  await expectError('二进制文件拒绝读取', tools.read_file, { path: 'bin.dat' }, /二进制/)",
  '}',
  '',
  '// ── 3. 先读后改：edit_file / 覆盖写 write_file ──',
  '{',
  "  writeFileSync(join(root, 'app.ts'), 'const a = 1\\nconst b = 2\\n')",
  "  const fileState = createAgentFileState()",
  "  const tools = makeTools({ fileState })",
  "  await expectRefusal('没读过就编辑 → 回绝并指引先 read_file', tools.edit_file, { path: 'app.ts', oldString: 'const a = 1', newString: 'const a = 9' }, /read_file|还没有读过/)",
  "  check('回绝后文件原样', readFileSync(join(root, 'app.ts'), 'utf8') === 'const a = 1\\nconst b = 2\\n', '')",
  "  await call(tools.read_file, { path: 'app.ts' })",
  '  const ok = await call(tools.edit_file, { path: \'app.ts\', oldString: \'const a = 1\', newString: \'const a = 9\' })',
  "  check('读过之后编辑成功', /已编辑 app\\.ts（替换 1 处）/.test(String(ok)), String(ok))",
  "  check('内容真的改了', readFileSync(join(root, 'app.ts'), 'utf8') === 'const a = 9\\nconst b = 2\\n', '')",
  '',
  "  // 外部改动后快照失效：必须重读",
  "  utimesSync(join(root, 'app.ts'), new Date(Date.now() + 5000), new Date(Date.now() + 5000))",
  "  await expectRefusal('读后被外部改动 → 回绝并要求重读', tools.edit_file, { path: 'app.ts', oldString: 'const a = 9', newString: 'const a = 8' }, /又被修改过/)",
  "  await call(tools.read_file, { path: 'app.ts' })",
  "  await call(tools.edit_file, { path: 'app.ts', oldString: 'const a = 9', newString: 'const a = 8' })",
  "  check('重读后编辑放行', readFileSync(join(root, 'app.ts'), 'utf8') === 'const a = 8\\nconst b = 2\\n', '')",
  '',
  "  // write_file：覆盖前必须读过（app.ts 已读过会放行，所以换一个从没读过的文件来验证回绝）；新文件不用；写完自动记快照",
  "  writeFileSync(join(root, 'unseen.txt'), 'v1\\n')",
  "  await expectRefusal('覆盖写没读过的文件 → 回绝', tools.write_file, { path: 'unseen.txt', content: 'boom' }, /read_file|还没有读过/)",
  "  check('回绝后文件原样', readFileSync(join(root, 'unseen.txt'), 'utf8') === 'v1\\n', '')",
  "  const created = await call(tools.write_file, { path: 'new-dir/new.ts', content: 'export {}\\n' })",
  "  check('新建文件不需要先读', /已创建 new-dir\\/new\\.ts/.test(String(created)), String(created))",
  "  await call(tools.read_file, { path: 'app.ts' })",
  "  await call(tools.write_file, { path: 'app.ts', content: 'const a = 7\\nconst b = 2\\n' })",
  "  const editAfterWrite = await call(tools.edit_file, { path: 'app.ts', oldString: 'const a = 7', newString: 'const a = 6' })",
  "  check('写完后接着编辑不必重读（写入也记快照）', /已编辑/.test(String(editAfterWrite)), String(editAfterWrite))",
  "  check('编辑结果正确', readFileSync(join(root, 'app.ts'), 'utf8') === 'const a = 6\\nconst b = 2\\n', '')",
  '}',
  '',
  '// ── 4. edit_file：多处命中 / replaceAll / CRLF / 模糊匹配 ──',
  '{',
  "  const fileState = createAgentFileState()",
  "  const tools = makeTools({ fileState })",
  "  writeFileSync(join(root, 'multi.ts'), 'foo();\\nfoo();\\n')",
  "  await call(tools.read_file, { path: 'multi.ts' })",
  "  await expectError('多处命中不猜（报错指引 replaceAll / 扩上下文）', tools.edit_file, { path: 'multi.ts', oldString: 'foo();', newString: 'bar();' }, /多处|replaceAll/)",
  "  await call(tools.edit_file, { path: 'multi.ts', oldString: 'foo();', newString: 'bar();', replaceAll: true })",
  "  check('replaceAll 全部替换', readFileSync(join(root, 'multi.ts'), 'utf8') === 'bar();\\nbar();\\n', '')",
  '',
  "  // CRLF：模型按 \\n 给 oldString，写回保留 \\r\\n",
  "  writeFileSync(join(root, 'crlf.ts'), 'function f() {\\r\\n    return 1\\r\\n}\\r\\n')",
  "  await call(tools.read_file, { path: 'crlf.ts' })",
  "  await call(tools.edit_file, { path: 'crlf.ts', oldString: 'function f() {\\n    return 1\\n}', newString: 'function f() {\\n    return 2\\n}' })",
  "  const crlfAfter = readFileSync(join(root, 'crlf.ts'), 'utf8')",
  "  check('CRLF 文件用 LF 的 oldString 也能编辑', crlfAfter === 'function f() {\\r\\n    return 2\\r\\n}\\r\\n', JSON.stringify(crlfAfter))",
  '',
  "  // 模糊匹配：模型给的缩进不对也能定位",
  "  writeFileSync(join(root, 'indent.ts'), 'if (ok) {\\n    work()\\n}\\n')",
  "  await call(tools.read_file, { path: 'indent.ts' })",
  "  await call(tools.edit_file, { path: 'indent.ts', oldString: 'if (ok) {\\nwork()\\n}', newString: 'if (ok) {\\nrest()\\n}' })",
  "  check('缩进不一致仍命中（LineTrimmed）', readFileSync(join(root, 'indent.ts'), 'utf8') === 'if (ok) {\\nrest()\\n}\\n', JSON.stringify(readFileSync(join(root, 'indent.ts'), 'utf8')))",
  '',
  "  await expectError('编辑不存在的文件指引 write_file', tools.edit_file, { path: 'nope.ts', oldString: 'a', newString: 'b' }, /write_file/)",
  "  await expectError('oldString 与 newString 相同报错', tools.edit_file, { path: 'multi.ts', oldString: 'bar();', newString: 'bar();' }, /相同/)",
  '}',
  '',
  '// ── 5. 确认模式：guardWrite 闸依旧生效 ──',
  '{',
  "  writeFileSync(join(root, 'guarded.txt'), 'v1\\n')",
  "  let asked = 0",
  "  const denyTools = makeTools({",
  "    permissionMode: 'confirm',",
  "    requestConfirm: async () => { asked++; return false }",
  '  })',
  "  await call(denyTools.read_file, { path: 'guarded.txt' })",
  "  await expectRefusal('确认被拒 → 回绝且不落盘', denyTools.edit_file, { path: 'guarded.txt', oldString: 'v1', newString: 'v2' }, /用户拒绝/)",
  "  check('确认卡确实被请求过', asked === 1, 'asked=' + asked)",
  "  check('文件未被改动', readFileSync(join(root, 'guarded.txt'), 'utf8') === 'v1\\n', '')",
  '',
  "  const allowTools = makeTools({",
  "    permissionMode: 'confirm',",
  "    requestConfirm: async () => true",
  '  })',
  "  await call(allowTools.read_file, { path: 'guarded.txt' })",
  "  await call(allowTools.edit_file, { path: 'guarded.txt', oldString: 'v1', newString: 'v2' })",
  "  check('确认通过后落盘', readFileSync(join(root, 'guarded.txt'), 'utf8') === 'v2\\n', '')",
  '}',
  '',
  "rmSync(root, { recursive: true, force: true })",
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
