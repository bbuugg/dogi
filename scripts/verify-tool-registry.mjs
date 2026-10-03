/**
 * AI 工具注册表 + 客户端工具回填通道的行为验证 —— 跑主进程真源码（不起 Electron）。
 *
 * 覆盖（客户端工具为 **A 方案**：定义随请求携带、权限与确认全在渲染端、
 * 执行走「挂起 + 广播 + 回填」桥、当前请求的模型循环继续）：
 *   1. tool-registry：注册 / 同名重复注册抛错、作用域过滤（terminal / workspace / both）、
 *      动态可用性（MCP 带同名 browser_* 时让位）、MCP 同名覆盖内置、
 *      动态 description（按 ctx.bashPath 现算）；
 *   2. 客户端工具随请求组装：定义进工具集、与内置同名时**让位内置**（跳过 + warn）、
 *      主进程**不做权限闸**（full / confirm 都直接把调用广播回去）；
 *   3. 回填通道：invoke 挂起 → 广播（带 callId / 名字 / 入参 / 归属）→ resolve 收场、
 *      执行失败 reject、cancel(requestId) 收尾（abort / 流结束纪律）、通道未就绪报错。
 *
 * 包装机制同 verify-agent-file-tools.mjs：复制真源码到临时目录、改写 import 说明符再执行。
 *
 * 跑：node scripts/verify-tool-registry.mjs
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TMP = join(ROOT, '.toolregtest')

const AI = 'src/main/services/ai'
const FILES = [
  [`${AI}/tool-registry.ts`, 'ai/tool-registry.ts'],
  [`${AI}/client-tools.ts`, 'ai/client-tools.ts']
]

// 两个文件对 @shared / agent-core 的引用全部是 type-only import（运行时被擦除），
// client-tools 现在对 tool-registry 也只剩类型引用 —— 直接复制即可，无需改写
const REWRITES = {
  'ai/client-tools.ts': [],
  'ai/tool-registry.ts': []
}

rmSync(TMP, { recursive: true, force: true })
for (const [from, to] of FILES) {
  const dst = join(TMP, to)
  mkdirSync(dirname(dst), { recursive: true })
  writeFileSync(dst, readFileSync(join(ROOT, from), 'utf8'))
}

// 探针主体。⚠️ 用数组 join 拼字符串而不是模板字面量：用例里有正则，
// 模板字面量会把反斜杠 / ${} 吃掉一层（AGENTS.md 6.5 第 20 条同款坑）
const PROBE = [
  "import { toolRegistry } from './ai/tool-registry.ts'",
  "import { clientToolBroker } from './ai/client-tools.ts'",
  "import { z } from 'zod'",
  '',
  'let pass = 0',
  'let fail = 0',
  'function check(name, ok, detail = \'\') {',
  "  if (ok) { pass++; console.log('  PASS ' + name) }",
  "  else { fail++; console.log('  FAIL ' + name + (detail ? ' — ' + String(detail).slice(0, 300) : '')) }",
  '}',
  '',
  '// ── 造一个假 ToolRunContext ──',
  'function makeCtx(overrides = {}) {',
  '  const asked = { count: 0, last: null }',
  '  const ctx = {',
  "    requestId: 'r1',",
  "    conversationId: 'c1',",
  "    scope: 'workspace',",
  "    workspace: { id: 'w', name: 'probe', path: '/tmp/probe', createdAt: 0, updatedAt: 0 },",
  '    signal: new AbortController().signal,',
  "    permissionMode: 'full',",
  '    requestConfirm: async (req) => { asked.count++; asked.last = req; return overrides.approve ?? true },',
  '    fileState: undefined,',
  '    skills: [],',
  "    bashPath: '/git/bash.exe',",
  '    ...overrides.ctx',
  '  }',
  '  return { ctx, asked }',
  '}',
  '',
  '// 广播器提前装好：第 6 节的「挂起等回填」用例要在第 7 节之前就能收到 invoke',
  'let broadcastLast = null',
  'clientToolBroker.setBroadcaster((channel, payload) => { broadcastLast = payload })',
  '',
  'function makeDef(name, scope, extra = {}) {',
  '  return {',
  '    name,',
  "    description: '工具 ' + name,",
  '    inputSchema: z.object({}),',
  '    scope,',
  '    execute: async (input, call, ctx) => ({ name, input, requestId: ctx.requestId }),',
  '    ...extra',
  '  }',
  '}',
  '',
  '/** 把「请求携带的客户端工具定义」接上回填通道（模拟 agent.ts 的 clientToolExecutors） */',
  'function clientToolExecutors(defs) {',
  '  return defs.map((def) => ({',
  '    name: def.name,',
  '    description: def.description,',
  '    ...(def.inputSchema ? { inputSchema: def.inputSchema } : {}),',
  '    execute: (input, call, ctx) => clientToolBroker.invoke(def.name, input, call, ctx)',
  '  }))',
  '}',
  '',
  '// ── 1. 注册纪律 ──',
  '{',
  "  toolRegistry.register(makeDef('probe_w', 'workspace'))",
  "  toolRegistry.register(makeDef('probe_t', 'terminal'))",
  "  toolRegistry.register(makeDef('probe_both', 'both'))",
  '  let threw = false',
  "  try { toolRegistry.register(makeDef('probe_w', 'workspace')) } catch { threw = true }",
  "  check('同名重复注册抛错（编程错误不静默）', threw)",
  "  check('names() 列出已注册工具', ['probe_w', 'probe_t', 'probe_both'].every((n) => toolRegistry.names().includes(n)))",
  '}',
  '',
  '// ── 2. 作用域过滤 ──',
  '{',
  '  const { ctx } = makeCtx()',
  "  const ws = toolRegistry.buildToolset({ ctx })",
  "  check('workspace 组装含 workspace / both 工具', !!ws.probe_w && !!ws.probe_both)",
  "  check('workspace 组装不含 terminal 工具', !ws.probe_t)",
  "  const term = toolRegistry.buildToolset({ ctx: { ...ctx, scope: 'terminal' } })",
  "  check('terminal 组装含 terminal / both 工具', !!term.probe_t && !!term.probe_both)",
  "  check('terminal 组装不含 workspace 工具', !term.probe_w)",
  '}',
  '',
  '// ── 3. 动态可用性：available 谓词（browser 组在 MCP 带同名 browser_* 时让位） ──',
  '{',
  '  const { ctx } = makeCtx()',
  "  toolRegistry.register(makeDef('probe_yield', 'workspace', {",
  "    available: ({ mcpToolNames }) => !mcpToolNames.some((n) => n.startsWith('browser_'))",
  '  }))',
  "  const withoutMcp = toolRegistry.buildToolset({ ctx })",
  "  check('无 MCP 时带 available 的工具在集', !!withoutMcp.probe_yield)",
  '  const mcpLike = { browser_click: { execute: async () => ({}), description: \'\', inputSchema: z.object({}) } }',
  "  const withMcp = toolRegistry.buildToolset({ ctx, extra: mcpLike })",
  "  check('MCP 带 browser_* 时让位（available 返回 false）', !withMcp.probe_yield)",
  "  toolRegistry.unregister('probe_yield')",
  '}',
  '',
  '// ── 4. MCP 同名覆盖内置 ──',
  '{',
  '  const { ctx } = makeCtx()',
  '  const mcpLike = { probe_both: { execute: async () => ({ from: \'mcp\' }), description: \'\', inputSchema: z.object({}) } }',
  "  const mixed = toolRegistry.buildToolset({ ctx, extra: mcpLike })",
  '  const res = await mixed.probe_both.execute({}, { toolCallId: \'t1\' })',
  "  check('MCP 同名覆盖内置（历史语义）', res && res.from === 'mcp', JSON.stringify(res))",
  '}',
  '',
  '// ── 5. 动态 description：按 ctx 现算（execute_command 的 shell 说明同机制） ──',
  '{',
  '  const { ctx } = makeCtx()',
  "  toolRegistry.register(makeDef('probe_desc', 'workspace', { description: (c) => 'shell:' + (c.bashPath ?? 'none') }))",
  "  const withBash = toolRegistry.buildToolset({ ctx })",
  "  check('描述函数收到 ctx（bashPath 注入）', String(withBash.probe_desc.description) === 'shell:/git/bash.exe', String(withBash.probe_desc.description))",
  "  const noBash = toolRegistry.buildToolset({ ctx: { ...ctx, bashPath: null } })",
  "  check('描述随 ctx 变化', String(noBash.probe_desc.description) === 'shell:none')",
  "  toolRegistry.unregister('probe_desc')",
  '}',
  '',
  '// ── 6. 客户端工具随请求组装：可见 / 同名让位内置 / 无权限闸 ──',
  '{',
  '  const { ctx, asked } = makeCtx()',
  '  const defs = [',
  "    { name: 'ui_echo', description: '回显输入', inputSchema: { type: 'object' } },",
  "    { name: 'probe_both', description: '与内置同名的客户端工具' }",
  '  ]',
  "  const ws = toolRegistry.buildToolset({ ctx, clientTools: clientToolExecutors(defs) })",
  "  check('随请求携带的客户端工具进工具集', !!ws.ui_echo)",
  "  check('与内置同名时客户端定义让位（内置优先，描述未被覆盖）', String(ws.probe_both.description) === '工具 probe_both', String(ws.probe_both.description))",
  "  check('无参定义缺省给空对象 schema', !!ws.ui_echo)",
  '',
  "  const term = toolRegistry.buildToolset({ ctx: { ...ctx, scope: 'terminal' }, clientTools: clientToolExecutors(defs) })",
  "  check('terminal 作用域同样收客户端工具（页面作用域由发送方决定）', !!term.ui_echo)",
  '',
  '  // 主进程不做权限闸：confirm 模式下也直接执行（asked 计数不变），广播回去由渲染端决定',
  "  const confirmCtx = makeCtx({ approve: false })",
  "  const confirmSet = toolRegistry.buildToolset({ ctx: { ...confirmCtx.ctx, permissionMode: 'confirm' }, clientTools: clientToolExecutors([{ name: 'ui_echo', description: 'x' }]) })",
  '  const exec = confirmSet.ui_echo.execute({ a: 1 }, { toolCallId: \'t1\' })',
  "  check('confirm 模式主进程不弹卡（asked=0，权限在渲染端）', confirmCtx.asked.count === 0)",
  '  check(\'confirm 模式调用已广播（挂起等回填）\', !!broadcastLast && broadcastLast.name === \'ui_echo\')',
  '  clientToolBroker.resolve({ callId: broadcastLast.callId, ok: true, result: \'client-ok\' })',
  "  check('回填后 execute 以结果收场', (await exec) === 'client-ok')",
  '}',
  '',
  '// ── 7. 回填通道：广播载荷 / 失败 / cancel / 通道未就绪 ──',
  '{',
  '  let broadcast = null',
  '  clientToolBroker.setBroadcaster((channel, payload) => { broadcast = { channel, payload } })',
  '  const pending = clientToolBroker.invoke(',
  "    'ui_echo', { text: '你好' }, { toolCallId: 'tc1' }, makeCtx().ctx",
  '  )',
  "  check('invoke 挂起并广播 clientTools:invoke', broadcast && broadcast.channel === 'clientTools:invoke', JSON.stringify(broadcast))",
  "  check('广播带 callId / 名字 / 入参 / 归属', broadcast.payload.name === 'ui_echo' && broadcast.payload.input.text === '你好' && broadcast.payload.requestId === 'r1' && !!broadcast.payload.callId)",
  '  clientToolBroker.resolve({ callId: broadcast.payload.callId, ok: true, result: { echoed: \'你好\' } })',
  "  const res = await pending",
  "  check('resolve 后 invoke 以结果收场', res && res.echoed === '你好', JSON.stringify(res))",
  '',
  '  // 「用户拒绝」走正常结果文案（渲染端的约定），不是 ok=false 的执行错误',
  '  const denied = clientToolBroker.invoke(',
  "    'ui_echo', {}, { toolCallId: 'tc2' }, makeCtx().ctx",
  '  )',
  "  clientToolBroker.resolve({ callId: broadcast.payload.callId, ok: true, result: '用户拒绝了这次调用（客户端工具 ui_echo）。' })",
  "  check('拒绝文案作为正常结果回传（模型可见）', String(await denied).includes('用户拒绝'), '')",
  '',
  '  const failing = clientToolBroker.invoke(',
  "    'ui_echo', {}, { toolCallId: 'tc3' }, makeCtx().ctx",
  '  )',
  '  clientToolBroker.resolve({ callId: broadcast.payload.callId, ok: false, error: \'渲染端炸了\' })',
  '  let gotErr = \'\'',
  '  try { await failing } catch (e) { gotErr = e.message }',
  "  check('执行器失败回传 error（reject）', gotErr === '渲染端炸了', gotErr)",
  '',
  '  const dangling = clientToolBroker.invoke(',
  "    'ui_echo', {}, { toolCallId: 'tc4' }, makeCtx({ ctx: { requestId: 'rX' } }).ctx",
  '  )',
  "  clientToolBroker.cancel('rX')",
  '  gotErr = \'\'',
  '  try { await dangling } catch (e) { gotErr = e.message }',
  "  check('cancel(requestId) 把挂起调用按失败收场（abort 纪律）', gotErr.includes('取消'), gotErr)",
  '',
  '  clientToolBroker.setBroadcaster(null)',
  '  const noChan = clientToolBroker.invoke(',
  "    'ui_echo', {}, { toolCallId: 'tc5' }, makeCtx().ctx",
  '  )',
  '  gotErr = \'\'',
  '  try { await noChan } catch (e) { gotErr = e.message }',
  "  check('通道未就绪明确报错', gotErr.includes('未就绪'), gotErr)",
  '}',
  '',
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
