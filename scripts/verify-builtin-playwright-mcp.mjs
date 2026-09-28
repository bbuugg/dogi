/**
 * 内置 Playwright MCP（@playwright/mcp）的 stdio 冒烟验证。
 *
 * 防的回归：@playwright/mcp 官方钉的是 playwright **alpha** 版本，本项目用
 * `overrides` 强制它解析到顶层 playwright 1.63 稳定版（去重后安装包省 ~19MB）。
 * 如果 mcp 未来某个版本用到了 1.64+ 才有的 API，这里第一时间暴露——表现为
 * CLI 启动即抛错 / initialize 或 tools/list 无响应 / browser_navigate 失败。
 *
 * 流程（对齐 services/ai/mcp.ts 的真实启动方式——子进程跑 CLI 入口）：
 *   spawn node cli.js --headless --browser msedge
 *   → initialize → initialized → tools/list（断言 browser_navigate 在列）
 *   → tools/call browser_navigate(data: URL) → 断言返回 ok
 *
 * 跑：node scripts/verify-builtin-playwright-mcp.mjs
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const pkg = require('@playwright/mcp/package.json')
const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.['playwright-mcp']
const entry = fileURLToPath(new URL(`../node_modules/@playwright/mcp/${bin}`, import.meta.url))

let pass = 0
let fail = 0
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log('  PASS ' + name) }
  else { fail++; console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')) }
}

const child = spawn(process.execPath, [entry, '--headless', '--browser', 'msedge'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined }
})
let stderrTail = ''
child.stderr.on('data', (d) => {
  stderrTail = (stderrTail + String(d)).slice(-2000)
  if (process.env.MCP_DEBUG) console.error('[stderr]', String(d))
})
child.on('exit', (code, signal) => {
  if (code !== 0 && code !== null) {
    console.error(`[mcp cli] 提前退出 code=${code}\n${stderrTail}`)
  }
})

let buffer = ''
const pending = new Map()
child.stdout.on('data', (chunk) => {
  buffer += String(chunk)
  for (;;) {
    const nl = buffer.indexOf('\n')
    if (nl < 0) break
    const line = buffer.slice(0, nl).trim()
    buffer = buffer.slice(nl + 1)
    if (!line) continue
    try {
      const msg = JSON.parse(line)
      if (msg.id != null && pending.has(msg.id)) {
        pending.get(msg.id)(msg)
        pending.delete(msg.id)
      }
    } catch { /* 忽略非 JSON 行 */ }
  }
})

function request(id, method, params, timeoutMs = 30_000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      resolve({ error: { message: `timeout after ${timeoutMs}ms${stderrTail ? '，stderr 末尾：' + stderrTail.slice(-300) : ''}` } })
    }, timeoutMs)
    pending.set(id, (msg) => { clearTimeout(timer); resolve(msg) })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
}

let nextId = 1

try {
  const init = await request(nextId++, 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'dogi-probe', version: '0.0.0' }
  })
  check('MCP initialize 有响应', !init.error, init.error?.message ?? '')
  check('服务端能力里含 tools', Boolean(init.result?.capabilities?.tools))

  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')

  const list = await request(nextId++, 'tools/list', {})
  const names = (list.result?.tools ?? []).map((t) => t.name)
  check('tools/list 成功（browser_navigate 在列）', names.includes('browser_navigate'),
    `实际工具数 ${names.length}`)

  const nav = await request(nextId++, 'tools/call', {
    name: 'browser_navigate',
    arguments: { url: 'data:text/html,<title>dogi-probe</title><h1>ok</h1>' }
  }, 45_000)
  const isError = nav.result?.isError === true || nav.error != null
  check('browser_navigate 真实打开页面成功', !isError,
    JSON.stringify(nav.error?.message ?? nav.result?.content?.[0]?.text ?? '').slice(0, 200))

  const snap = await request(nextId++, 'tools/call', {
    name: 'browser_snapshot',
    arguments: {}
  }, 30_000)
  const snapOk = snap.result?.isError !== true && JSON.stringify(snap.result ?? '').includes('ok')
  check('browser_snapshot 能看到页面内容（1.63 API 全链路可用）', snapOk,
    JSON.stringify(snap.error?.message ?? snap.result?.content?.[0]?.text ?? '').slice(0, 200))
} finally {
  child.kill()
}

console.log(`\n===== 通过 ${pass} / 失败 ${fail} =====`)
process.exit(fail ? 1 : 0)
