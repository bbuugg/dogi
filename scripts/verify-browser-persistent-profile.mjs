/**
 * 浏览器会话持久化 profile 的端到端验证 —— 跑 `services/browser/session.ts` 真源码。
 *
 * 防的回归：登录态（cookie / localStorage）必须活得过「会话重启」（关标签再开、
 * browser_close、应用重启）；只有删除会话（`browserSessions.purge`）才清 profile。
 * 这是用户报告「登录了一个账号，刷新后登录态就没了」的根因修复
 * （旧实现 `browser.newContext()` 每次都是无痕窗口）。
 *
 * 包装机制同 `verify-agent-browser-tools.mjs`：先复制真源码到临时目录、
 * 只改写 import 说明符（补 .ts 扩展名 / 换掉 @shared 别名），再
 * `node --experimental-strip-types` 执行。session.ts 保持与 Electron 解耦
 * （profilesRoot 由外部注入），所以能在纯 Node 下跑。
 *
 * 跑：node scripts/verify-browser-persistent-profile.mjs
 */
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TMP = join(ROOT, '.profiltest')

const BROWSER_SRC = 'src/main/services/browser'
const FILES = [
  [`${BROWSER_SRC}/session.ts`, 'browser/session.ts'],
  [`${BROWSER_SRC}/handlers.ts`, 'browser/handlers.ts'],
  [`${BROWSER_SRC}/input.ts`, 'browser/input.ts'],
  [`${BROWSER_SRC}/resolver.ts`, 'browser/resolver.ts'],
  ['src/shared/browser.ts', 'shared/browser.ts']
]

const REWRITES = {
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

// 探针主体：注入 profilesRoot 后按「登录 → 关会话 → 重开 → 验登录态还在」的顺序走一遍
const PROBE = `
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { browserSessions, setBrowserProfilesRoot } from './browser/session.ts'
import { createBrowserSessionHandlers } from './browser/handlers.ts'

let pass = 0
let fail = 0
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log('  PASS ' + name) }
  else { fail++; console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')) }
}

// 假站点：每次响应都发一枚**持久** cookie（带 Max-Age，等价于真实登录态；
// 不带有效期的「会话 cookie」Chromium 本就不落盘 —— 真浏览器也是这个行为）
const server = createServer((_req, res) => {
  res.setHeader('set-cookie', 'sid=secret-42; Path=/; Max-Age=86400')
  res.setHeader('content-type', 'text/html')
  res.end('<html><body>ok</body></html>')
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port
const url = 'http://127.0.0.1:' + port + '/'

const SID = 'agent-browser:conv-1'
const DIR_NAME = 'agent-browser-conv-1'

const root = mkdtempSync(join(tmpdir(), 'dogi-profile-'))
setBrowserProfilesRoot(join(root, 'browser-profiles'))

// ── 第一轮：启动 + 登录 ──
{
  const s = browserSessions.create(SID, createBrowserSessionHandlers())
  await s.start('auto')
  check('启动后拿到页面（持久化上下文自带起始页）', s.isAlive() && Boolean(s.getPage()))
  check('持久化上下文的 browser() 可用', Boolean(s.getPage().context().browser()))
  await s.navigate(url)
  await s.getPage().evaluate(() => localStorage.setItem('login', 'yes'))
  const cookies = await s.getPage().context().cookies(url)
  check('本轮 cookie 已生效', cookies.some((c) => c.name === 'sid' && c.value === 'secret-42'))
}
await browserSessions.close(SID, '测试关闭')

const profileDir = join(root, 'browser-profiles', DIR_NAME)
check('关闭会话后 profile 目录保留（登录态不清）', existsSync(profileDir))

// ── 第二轮：同 id 重开（等价于关标签再打开 / 应用重启后再用） ──
{
  const s = browserSessions.create(SID, createBrowserSessionHandlers())
  await s.start('auto')
  const cookies = await s.getPage().context().cookies(url)
  check('cookie 活过会话重启', cookies.some((c) => c.name === 'sid' && c.value === 'secret-42'),
    JSON.stringify(cookies.map((c) => c.name)))
  await s.navigate(url)
  const ls = await s.getPage().evaluate(() => localStorage.getItem('login'))
  check('localStorage 活过会话重启', ls === 'yes', String(ls))
}
await browserSessions.close(SID, '测试关闭')

// ── purge：删除会话 → profile 一并删除 ──
await browserSessions.purge(SID)
check('purge 后 profile 目录已删除', !existsSync(profileDir))

// ── 未注入 profilesRoot（探针 / 单测环境）：回退临时上下文，不落盘 ──
setBrowserProfilesRoot('')
{
  const s = browserSessions.create(SID, createBrowserSessionHandlers())
  await s.start('auto')
  check('未注入 profilesRoot 时仍可启动（临时上下文）', s.isAlive())
  const cookies = await s.getPage().context().cookies(url)
  check('临时上下文不继承旧登录态', !cookies.some((c) => c.name === 'sid'))
  await browserSessions.close(SID, '测试关闭')
}
check('临时路径不创建 profile 目录', !existsSync(join(root, 'browser-profiles', DIR_NAME)))

server.close()
rmSync(root, { recursive: true, force: true })
console.log('\\n===== 通过 ' + pass + ' / 失败 ' + fail + ' =====')
process.exit(fail ? 1 : 0)
`

writeFileSync(join(TMP, 'run.ts'), PROBE)

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
