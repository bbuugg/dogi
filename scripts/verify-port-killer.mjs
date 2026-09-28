/**
 * E2E 验证：port-killer 插件（按端口查占用进程 → 强制结束 → 无权限给命令）。
 *
 * 隔离 Electron 实例（仓库 plugins/ 会在启动时播种到 userData）+ CDP 驱动真实 UI，
 * 用探针自己 spawn 的 node 子进程真实占住随机端口：
 *
 *   1. 插件装载：pluginList 里有 port-killer 且无加载错误、视图 viewId 已注册；
 *   2. 打开插件标签页 → 输入端口查询 → 表里出现该进程（PID / 进程名 / 监听中 / 地址）；
 *   3. search / killCommand handler 结构化断言（含平台命令格式：win32 `taskkill /F /PID N`，
 *      POSIX `sudo kill -9 N`）；行内「复制结束进程的命令」出成功提示；
 *   4. 结束进程：Popconfirm → 强制结束 → 子进程真的退出、端口连接被拒、
 *      表格自动复查为「未发现占用进程」；
 *   5. 保护与校验分支：kill PID 1 → protected、非法 PID → invalid、
 *      不存在的 PID → not_found、端口 70000 → 报错提示；
 *   6. 「重新查询」：换个随机端口再占一次 → 行回来（截图留档）→ 探针自己清理。
 *
 * 说明：EPERM（权限不足 → 弹管理员命令弹窗）需要真实高权限进程才能触发，
 * 自动化里不制造系统进程，只验证命令生成侧（killCommand）与受保护 PID 分支。
 */
import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

const CDP_PORT = 9343
const OUT_DIR = '.workbuddy-ai/shots'
const LOG_FILE = join(OUT_DIR, 'port-killer.log')
const userData = join(tmpdir(), 'dogi-port-killer-cdp')

const check = (label, ok) => {
  assert.ok(ok, `FAIL: ${label}`)
  console.log(`  ok  ${label}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 取一个当前空闲的端口（绑定 0 后立刻释放） */
const getFreePort = () =>
  new Promise((resolve, reject) => {
    const s = net.createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => resolve(port))
    })
  })

/** 起一个真实的 node 子进程占住端口（tcp=监听 / udp=绑定）；stdout 打 READY 表示已就绪 */
function startOccupier(port, kind = 'tcp') {
  const code = kind === 'udp'
    ? `require('node:dgram').createSocket('udp4').bind(${port},'127.0.0.1',()=>console.log('READY'))`
    : `require('node:net').createServer().listen(${port},'127.0.0.1',()=>console.log('READY'))`
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    const timer = setTimeout(() => reject(new Error('occupier 启动超时')), 10000)
    child.stdout.on('data', (d) => {
      out += String(d)
      if (out.includes('READY')) {
        clearTimeout(timer)
        resolve(child)
      }
    })
    child.once('exit', () => {
      clearTimeout(timer)
      reject(new Error('occupier 提前退出'))
    })
  })
}

const waitExit = (child, timeoutMs = 8000) =>
  new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve(true)
    const timer = setTimeout(() => reject(new Error('等待占用子进程退出超时')), timeoutMs)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve(true)
    })
  })

/** 端口是否已无人监听（连接被拒 = true） */
const portRefused = (port) =>
  new Promise((resolve) => {
    const s = net.connect({ port, host: '127.0.0.1' })
    const done = (v) => {
      s.destroy()
      resolve(v)
    }
    s.once('connect', () => done(false))
    s.once('error', () => done(true))
    setTimeout(() => done(false), 3000)
  })

await fs.rm(userData, { recursive: true, force: true })
await fs.mkdir(OUT_DIR, { recursive: true })
const log = await fs.open(LOG_FILE, 'w')
const child = spawn(
  'node_modules/electron/dist/electron.exe',
  [
    '.',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${userData}`,
    '--no-sandbox',
    '--in-process-gpu',
    '--disable-gpu-sandbox'
  ],
  { stdio: ['ignore', log.fd, log.fd], detached: true }
)
child.unref()

async function pageTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page
    } catch {
      // 还没起来
    }
    await sleep(500)
  }
  throw new Error('没有等到可调试的页面')
}

const page = await pageTarget()
const socket = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.onopen = resolve
  socket.onerror = reject
})
let msgId = 0
const pending = new Map()
socket.onmessage = (event) => {
  const msg = JSON.parse(event.data)
  const entry = pending.get(msg.id)
  if (!entry) return
  pending.delete(msg.id)
  msg.error ? entry.reject(new Error(JSON.stringify(msg.error))) : entry.resolve(msg.result)
}
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++msgId
    pending.set(id, { resolve, reject })
    socket.send(JSON.stringify({ id, method, params }))
  })
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'evaluate 失败')
  return r.result.value
}
/** 轮询直到 cond() 为真（页面侧求值），超时抛错 */
async function waitFor(label, expression, timeoutMs = 15000) {
  const start = Date.now()
  for (;;) {
    if ((await evaluate(expression)) === true) return
    if (Date.now() - start > timeoutMs) throw new Error(`等待超时：${label}`)
    await sleep(250)
  }
}

/** 去掉全部空白再比对文案，规避 antd 两字按钮插空格 */
const CLICK_BY_TEXT = (text) => `
  (() => {
    const t = ${JSON.stringify(text)}
    const btn = [...document.querySelectorAll('button')].find(
      (b) => (b.textContent || '').replace(/\\s+/g, '') === t
    )
    if (btn) { btn.click(); return true }
    return false
  })()
`

/** 受控 Input 用原生 setter + input 事件喂值（React 才认） */
const SET_INPUT = (selector, value) => `
  (() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    if (!el) return false
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(el, ${JSON.stringify(String(value))})
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()
`

const isWin = process.platform === 'win32'
const expectKill = (pid) => (isWin ? `taskkill /F /PID ${pid}` : `sudo kill -9 ${pid}`)
let occ = null

try {
  // ---------- 0. bootstrap + 插件装载 ----------
  await waitFor(
    'bootstrap（shells 已加载）',
    `(window.__store ? window.__store.getState().shells !== null : false)`,
    30000
  )
  await waitFor(
    'port-killer 出现在插件列表（无加载错误）',
    `window.__store.getState().pluginList.some((p) => p.id === 'port-killer' && !p.error)`
  )
  check('插件已播种并加载（pluginList 无错误）', true)
  await waitFor(
    '端口占用视图已注册',
    `window.__store.getState().plugins.some((v) => v.viewId === 'port-killer')`
  )
  check('渲染端视图已注册（viewId=port-killer）', true)

  // ---------- 1. 打开插件标签页 ----------
  await evaluate(`window.__store.getState().openPluginTab('port-killer')`)
  await waitFor('插件页出现端口输入框', `!!document.querySelector('input[placeholder*="端口"]')`)
  check('插件标签页已打开（含端口输入框）', true)
  check(
    '顶栏显示当前系统标签',
    await evaluate(`['Windows', 'macOS', 'Linux'].some((n) => document.body.innerText.includes(n))`)
  )

  // ---------- 2. 查询被占用的端口 ----------
  const port = await getFreePort()
  occ = await startOccupier(port)
  console.log(`占用子进程已就绪：PID ${occ.pid} 监听 127.0.0.1:${port}`)

  check('填入端口号', (await evaluate(SET_INPUT('input[placeholder*="端口"]', port))) === true)
  await sleep(200)
  check('点击「查询」', (await evaluate(CLICK_BY_TEXT('查询'))) === true)
  await waitFor('结果行出现（含 PID）', `document.body.innerText.includes(${JSON.stringify(String(occ.pid))})`, 20000)
  const rowText = await evaluate(`document.body.innerText`)
  check('行含「监听中」状态', rowText.includes('监听中'))
  check('行含进程名 node', /node(\.exe)?/.test(rowText))
  check('行含本地地址 127.0.0.1:' + port, rowText.includes(`127.0.0.1:${port}`))
  check('显示本次查询命令', /netstat|ss -tanp|ss -uanp|lsof/.test(rowText))

  const resPort = await evaluate(`window.api.plugins.invoke('port-killer','search',{ port: ${port} })`)
  check(
    'search 结构化结果正确（pid / name / TCP / LISTENING）',
    resPort.rows.some(
      (r) =>
        r.pid === occ.pid &&
        /^node(\.exe)?$/.test(r.name || '') &&
        r.proto === 'TCP' &&
        (isWin ? r.state === 'LISTENING' : /LISTEN/i.test(r.state))
    )
  )
  check('search 平台标签与探针一致', resPort.platform === process.platform)

  // ---------- 3. 复制结束命令 ----------
  const cmd = await evaluate(`window.api.plugins.invoke('port-killer','killCommand',{ pid: 4321 })`)
  check(`killCommand 生成平台命令（${expectKill(4321)}）`, cmd.command === expectKill(4321))
  check(
    '点击行内「复制结束进程的命令」',
    (await evaluate(`
      (() => {
        const btn = document.querySelector('button[title="复制结束进程的命令"]')
        if (!btn) return false
        btn.click()
        return true
      })()
    `)) === true
  )
  await waitFor('复制成功提示', `document.body.innerText.includes('已复制命令')`)
  check('剪贴板复制成功提示出现', true)

  // ---------- 4. 结束进程：真杀真退真释放 ----------
  check('点击行内「结束进程」', (await evaluate(CLICK_BY_TEXT('结束进程'))) === true)
  await sleep(400)
  check('点击 Popconfirm「强制结束」', (await evaluate(CLICK_BY_TEXT('强制结束'))) === true)
  await waitFor('成功提示', `document.body.innerText.includes('已结束')`, 10000)
  await waitExit(occ)
  check('占用子进程已真的退出', occ.exitCode !== null || occ.signalCode !== null)
  check('端口已释放（再连被拒）', await portRefused(port))
  await waitFor('表格自动复查为空', `document.body.innerText.includes('未发现占用进程')`, 15000)
  check('结束后的自动复查显示「未发现占用进程」', true)

  // ---------- 5. 保护与校验分支 ----------
  const k1 = await evaluate(`window.api.plugins.invoke('port-killer','kill',{ pid: 1 })`)
  check('kill PID 1 → protected（拒绝系统关键进程）', k1.ok === false && k1.reason === 'protected')
  const kBad = await evaluate(`window.api.plugins.invoke('port-killer','kill',{ pid: -1 })`)
  check('kill 非法 PID → invalid', kBad.ok === false && kBad.reason === 'invalid')
  const kGone = await evaluate(`window.api.plugins.invoke('port-killer','kill',{ pid: 999999999 })`)
  check(
    'kill 不存在的 PID → not_found（不抛错）',
    kGone.ok === false && ['not_found', 'error'].includes(kGone.reason)
  )
  const badSearch = await evaluate(`
    window.api.plugins.invoke('port-killer','search',{ port: 70000 })
      .then(() => 'NO_ERROR')
      .catch((e) => String(e && e.message || e))
  `)
  check('search 70000 → 提示端口范围错误', badSearch.includes('1-65535'))
  const freePort = await getFreePort()
  const emptyRes = await evaluate(`window.api.plugins.invoke('port-killer','search',{ port: ${freePort} })`)
  check('空闲端口 search 返回空 rows', Array.isArray(emptyRes.rows) && emptyRes.rows.length === 0)

  // ---------- 6. 「重新查询」：换个端口再占一次 → 行回来（截图留档） ----------
  const port2 = await getFreePort()
  occ = await startOccupier(port2)
  console.log(`第二笔占用子进程：PID ${occ.pid} 监听 127.0.0.1:${port2}`)
  check('填入第二个端口号', (await evaluate(SET_INPUT('input[placeholder*="端口"]', port2))) === true)
  await sleep(200)
  check('点击「重新查询」', (await evaluate(CLICK_BY_TEXT('重新查询'))) === true)
  await waitFor('第二笔结果行出现', `document.body.innerText.includes(${JSON.stringify(String(occ.pid))})`, 20000)
  check('重新查询后结果行回来', true)

  // ---------- 6.5 UDP 端口占用（Windows netstat 的 UDP 行没有状态列）----------
  const udpPort = await getFreePort()
  const udpOcc = await startOccupier(udpPort, 'udp')
  const udpRes = await evaluate(`window.api.plugins.invoke('port-killer','search',{ port: ${udpPort} })`)
  check(
    'UDP 占用可查到（proto=UDP 且 PID / 进程名正确）',
    udpRes.rows.some((r) => r.proto === 'UDP' && r.pid === udpOcc.pid && !!r.name)
  )
  const udpKill = await evaluate(`window.api.plugins.invoke('port-killer','kill',{ pid: ${udpOcc.pid} })`)
  check('UDP 占用进程可结束', udpKill.ok === true)
  await waitExit(udpOcc)
  check('UDP 子进程已退出', udpOcc.exitCode !== null || udpOcc.signalCode !== null)

  const shot = await send('Page.captureScreenshot', { format: 'png' })
  await fs.writeFile(join(OUT_DIR, 'port-killer-panel.png'), Buffer.from(shot.data, 'base64'))
  console.log(`  ok  截图已落盘 ${OUT_DIR}/port-killer-panel.png`)

  // ---------- 7. 主进程日志（播种 + 插件加载） ----------
  const logText = await fs.readFile(LOG_FILE, 'utf-8')
  check('日志：内置插件已播种到 userData', logText.includes('已同步内置插件到 userData：port-killer'))
  check('日志：插件主进程入口已加载', logText.includes('[plugin:port-killer] port-killer 主进程已加载'))

  console.log('\nALL PASS')
} catch (err) {
  console.error('\nFAIL:', err.message)
  try {
    const shot = await send('Page.captureScreenshot', { format: 'png' })
    await fs.writeFile(join(OUT_DIR, 'port-killer-fail.png'), Buffer.from(shot.data, 'base64'))
    console.error('失败截图已落盘 .workbuddy-ai/shots/port-killer-fail.png')
  } catch {
    // 忽略
  }
  process.exitCode = 1
} finally {
  try {
    socket.close()
  } catch {
    // 忽略
  }
  try {
    occ?.kill()
  } catch {
    // 已退出
  }
  try {
    process.kill(child.pid)
  } catch {
    // 已退出
  }
  await log.close()
  process.exit(process.exitCode ?? 0)
}
