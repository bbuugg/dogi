/**
 * Windows 主机支持（平台探测 / 每主机终端编码 / 监控不支持态）端到端验证。
 *
 * 隔离 Electron 实例（独立 userData）+ 三台进程内 ssh2 假服务器 + CDP 驱动真 UI：
 * 1. Windows 假服务器（`cmd /c ver` → Microsoft Windows [Version …]）：
 *    平台探测为 windows；该会话不产生任何 monitor:data；monitor:unsupported(windows)
 *    推送到渲染端 store；状态栏徽标退化为「不支持监控」；
 * 2. GBK 假服务器（terminalCharset=gbk）：shell 输出 GBK 编码中文 ⇒ xterm 渲染正确；
 *    输入中文 ⇒ 服务器侧收到的字节等于 GBK 编码；
 * 3. Linux 假服务器（UTF-8）回归：字节原样透传 + monitor:data 正常到达。
 *
 * 跑：node scripts/verify-windows-host.mjs（项目根目录执行，需先 npm run build ）
 * ⚠️ 平台探测是「会话就绪后的异步 exec」，所有断言统一轮询，不要用固定 sleep。
 * ⚠️ Windows 的「不支持监控」在下一个采集周期（默认 2s）才推送 —— 探测先于 tick 完成。
 * ⚠️ xterm 6 默认 DOM 渲染器，中文断言取 `.xterm-rows` 的 textContent。
 */
import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import ssh2Pkg from 'ssh2'
import iconv from 'iconv-lite'

const { Server: SshServer, utils: sshUtils } = ssh2Pkg

const CDP_PORT = 9338
const WIN_PORT = 29431
const GBK_PORT = 29432
const LINUX_PORT = 29433
const OUT_DIR = '.workbuddy-ai/shots'
const userData = join(tmpdir(), 'dogi-windows-host-cdp')

const check = (label, ok) => {
  assert.ok(ok, `FAIL: ${label}`)
  console.log(`  ok  ${label}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------- 假 SSH 服务器工厂：密码认证 + 可注入的 exec / shell 行为 ----------
const hostKey = sshUtils.generateKeyPairSync('rsa', { bits: 2048 })
/** GBK 假服务器捕获的 shell 输入字节（断言输入按 GBK 编码上送） */
const gbkInputChunks = []

function createFakeSsh({ onExec, onShell }) {
  return new SshServer({ hostKeys: [hostKey.private] }, (client) => {
    client.on('authentication', (ctx) => {
      if (ctx.method === 'password' && ctx.username === 'tester') ctx.accept()
      else ctx.reject(['password'])
    })
    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept()
        session.on('pty', (a) => a && a())
        session.on('shell', (a) => {
          const stream = a()
          onShell(stream)
        })
        session.on('exec', (a, _reject, info) => {
          const stream = a()
          onExec(info.command, stream)
        })
      })
      client.on('request', (accept) => accept && accept())
    })
  })
}

const writeAndClose = (stream, text, encoding) => {
  if (text) stream.write(encoding === 'gbk' ? iconv.encode(text, 'gbk') : text)
  stream.exit(0)
  stream.end()
}

// ---------- 三台假服务器 ----------
const WIN_VER_TEXT = 'Microsoft Windows [Version 10.0.20348.1]\r\n'
const WIN_VER_GBK = 'Microsoft Windows [\u7248\u672c 10.0.20348.1]\r\n'
const GBK_BANNER = 'GBK \u4e2d\u6587\u8f93\u51fa\u6d4b\u8bd5'
const LINUX_BANNER = 'Linux \u56de\u5f52\u6d4b\u8bd5'

/** 假 Linux 的 /proc 采集应答（结构与真实一致，让监控判定为有效数据） */
const LINUX_COLLECT_OUTPUT =
  [
    '0.52 0.41 0.38 1/234 5678',
    '===MEM===',
    'MemTotal:        2048000 kB',
    'MemFree:          512000 kB',
    'Buffers:           64000 kB',
    'Cached:           256000 kB',
    'MemAvailable:    1024000 kB',
    '===CPU===',
    'cpu  100 0 50 850 0 0 0 0 0 0',
    'cpu0  50 0 25 425 0 0 0 0 0 0',
    'cpu1  50 0 25 425 0 0 0 0 0 0',
    '===NET===',
    'Inter-|   Receive                                                |  Transmit',
    ' face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed',
    '    eth0: 1000000 1000 0 0 0 0 0 0 2000000 2000 0 0 0 0 0 0',
    '===UP===',
    '12345.67 98765.43',
    '===DISK===',
    'Filesystem     1-blocks      Used Available Capacity Mounted on',
    '/dev/sda1      100000000  40000000  60000000      40% /'
  ].join('\n') + '\n'

const winServer = createFakeSsh({
  onExec: (command, stream) => {
    // 平台探测命中；其余命令（监控采集）一律空输出 —— Windows 没有 /proc
    writeAndClose(stream, command.trim() === 'cmd /c ver' ? WIN_VER_TEXT : '', 'utf8')
  },
  onShell: (stream) => {
    stream.write('\r\n' + WIN_VER_TEXT + 'C:\\Users\\tester>')
    stream.on('data', () => {})
  }
})

const gbkServer = createFakeSsh({
  onExec: (command, stream) => {
    // 平台探测应答也走 GBK 编码：顺带验证 exec() 的按字符集解码
    writeAndClose(stream, command.trim() === 'cmd /c ver' ? WIN_VER_GBK : '', 'gbk')
  },
  onShell: (stream) => {
    stream.write(iconv.encode(GBK_BANNER + '\r\n', 'gbk'))
    stream.on('data', (d) => gbkInputChunks.push(Buffer.from(d)))
  }
})

const linuxServer = createFakeSsh({
  onExec: (command, stream) => {
    const cmd = command.trim()
    if (cmd === 'cmd /c ver') writeAndClose(stream, "'cmd' is not recognized\r\n", 'utf8')
    else if (cmd === 'uname -s') writeAndClose(stream, 'Linux\r\n', 'utf8')
    else if (cmd.startsWith('cat /proc/loadavg')) writeAndClose(stream, LINUX_COLLECT_OUTPUT, 'utf8')
    else writeAndClose(stream, '', 'utf8')
  },
  onShell: (stream) => {
    stream.write('\r\n' + LINUX_BANNER + '\r\n')
    stream.on('data', () => {})
  }
})

await Promise.all([
  new Promise((r) => winServer.listen(WIN_PORT, '127.0.0.1', r)),
  new Promise((r) => gbkServer.listen(GBK_PORT, '127.0.0.1', r)),
  new Promise((r) => linuxServer.listen(LINUX_PORT, '127.0.0.1', r))
])
console.log(
  `ssh2 假服务器已监听：Windows=${WIN_PORT} GBK=${GBK_PORT} Linux=${LINUX_PORT}`
)

// ---------- 起隔离实例 ----------
await fs.rm(userData, { recursive: true, force: true })
await fs.mkdir(OUT_DIR, { recursive: true })
const log = await fs.open(join(OUT_DIR, 'windows-host.log'), 'a')
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

const finish = async (code) => {
  try {
    socket.close()
  } catch {
    // 忽略
  }
  try {
    process.kill(child.pid)
  } catch {
    // 已退出
  }
  winServer.close()
  gbkServer.close()
  linuxServer.close()
  await log.close()
  process.exit(code)
}

/** 轮询表达式直到真值（返回命中值） */
async function waitFor(label, expression, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = await evaluate(expression)
    if (last) return last
    await sleep(250)
  }
  throw new Error(`超时：${label}（最后结果：${JSON.stringify(last)}）`)
}

/** 轮询日志直到出现满足条件的条目 */
async function waitForLog(label, pred, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs
  let last = []
  while (Date.now() < deadline) {
    last = await evaluate(`(async () => await window.api.logs.list())()`)
    const hit = last.find((e) => pred(e))
    if (hit) return hit
    await sleep(250)
  }
  throw new Error(`超时：${label}`)
}

/** 用 store 的连接动作建会话（与双击主机同一条路径：带标签 + 聚焦 + 监控自动启动） */
async function connectProfile(name, sshPort, charset) {
  const profile = {
    id: '',
    kind: 'ssh',
    name,
    host: '127.0.0.1',
    port: sshPort,
    username: 'tester',
    authType: 'password',
    password: 'pw'
  }
  if (charset) profile.terminalCharset = charset
  const sid = await evaluate(`
    (async () => {
      const list = await window.api.ssh.save(${JSON.stringify(profile)})
      const saved = list.find((p) => p.name === ${JSON.stringify(name)})
      const info = await window.__store.getState().connectHost(saved)
      return info.id
    })()
  `)
  return sid
}

/** 关闭会话并等它从主进程与 store 彻底消失（避免下一个阶段的 xterm 断言串台） */
async function killAndWait(sid) {
  await evaluate(`(async () => await window.api.terminal.kill('${sid}'))()`)
  await waitFor(
    `会话 ${sid} 已关闭`,
    `(async () => {
      const gone = (await window.api.terminal.list()).every((s) => s.id !== '${sid}')
      const tabGone = window.__store.getState().ui.panelTabs.every((t) => t.sessionId !== '${sid}')
      return gone && tabGone
    })()`
  )
}

const shoot = async (name) => {
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  await fs.writeFile(join(OUT_DIR, `${name}.png`), Buffer.from(shot.data, 'base64'))
  console.log(`  ok  截图已落盘 ${OUT_DIR}/${name}.png`)
}

try {
  // 等 bootstrap 完成（shells 就绪即代表整批初始数据已进 store）
  {
    const deadline = Date.now() + 20000
    let ready = false
    while (Date.now() < deadline && !ready) {
      ready = await evaluate(`window.__store.getState().shells !== null`).catch(() => false)
      if (!ready) await sleep(300)
    }
    check('渲染端 bootstrap 已完成', ready)
  }

  // 监控事件探针（先于任何连接安装；记录每会话的 data 次数与 unsupported 推送）
  await evaluate(`
    (() => {
      window.__probe = { monitorData: {}, unsupported: [] }
      window.api.monitor.onData(({ sessionId }) => {
        window.__probe.monitorData[sessionId] = (window.__probe.monitorData[sessionId] ?? 0) + 1
      })
      window.api.monitor.onUnsupported(({ sessionId, reason }) => {
        window.__probe.unsupported.push({ sessionId, reason })
      })
      return true
    })()
  `)

  // ---------- 1. Windows 假服务器：探测 / 监控不支持态 / 徽标 ----------
  const winSid = await connectProfile('Win 假机', WIN_PORT, null)
  check('Windows 会话已创建', !!winSid)

  const winPlatform = await waitFor(
    'Windows 平台探测',
    `(async () => {
      const info = (await window.api.terminal.list()).find((s) => s.id === '${winSid}')
      return info ? info.platform ?? '' : ''
    })()`
  )
  check('平台探测结果为 windows', winPlatform === 'windows')
  await waitForLog(
    '平台识别日志',
    (e) => e.message === '[终端会话] 已识别主机平台：Windows（tester@127.0.0.1）'
  )

  const winUnsupported = await waitFor(
    'monitor:unsupported(windows)',
    `window.__store.getState().monitorUnsupported['${winSid}'] === 'windows'`
  )
  check('store 收到不支持监控标记（windows）', winUnsupported === true)

  const badgeText = await waitFor(
    '「不支持监控」徽标',
    `(() => {
      const el = document.querySelector('[aria-label="不支持服务器监控"]')
      return el ? el.textContent.trim() : ''
    })()`
  )
  check('状态栏徽标显示「不支持监控」', badgeText.replace(/\s+/g, '') === '不支持监控')

  // 截图（亮 / 暗）
  await send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: 'light' }]
  })
  await sleep(400)
  await shoot('windows-host-unsupported')
  await send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: 'dark' }]
  })
  await sleep(400)
  await shoot('windows-host-unsupported-dark')
  await send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: 'light' }]
  })

  // 给足几个采集周期：Windows 会话不允许出现任何 monitor:data，unsupported 只推一次
  await sleep(4500)
  {
    const mon = await evaluate(`
      (() => ({
        data: window.__probe.monitorData['${winSid}'] ?? 0,
        unsupported: window.__probe.unsupported.filter((u) => u.sessionId === '${winSid}')
      }))()
    `)
    check('Windows 会话没有任何 monitor:data', mon.data === 0)
    check(
      'monitor:unsupported 恰好推送一次且 reason=windows',
      mon.unsupported.length === 1 && mon.unsupported[0].reason === 'windows'
    )
  }

  await killAndWait(winSid)
  check('Windows 会话关闭后标记被清理', await evaluate(`!('${winSid}' in window.__store.getState().monitorUnsupported)`))

  // ---------- 2. GBK 假服务器：输出解码渲染 + 输入编码 ----------
  const gbkSid = await connectProfile('GBK 假机', GBK_PORT, 'gbk')
  check('GBK 会话已创建', !!gbkSid)

  const gbkPlatform = await waitFor(
    'GBK 服务器的平台探测（exec 按 GBK 解码）',
    `(async () => {
      const info = (await window.api.terminal.list()).find((s) => s.id === '${gbkSid}')
      return info ? info.platform ?? '' : ''
    })()`
  )
  check('GBK 服务器平台探测为 windows（exec 解码正确）', gbkPlatform === 'windows')

  const rendered = await waitFor(
    'xterm 渲染 GBK 中文',
    `(() => {
      const rows = document.querySelector('.xterm-rows')
      return rows ? rows.textContent.includes(${JSON.stringify(GBK_BANNER)}) : false
    })()`
  )
  check('xterm 正确渲染 GBK 中文输出', rendered === true)

  // 输入路径：中文按会话字符集（GBK）编码后发往远端
  await evaluate(`(async () => await window.api.terminal.write('${gbkSid}', '\u4e2d\u6587\u8f93\u5165'))()`)
  await sleep(500)
  {
    const received = Buffer.concat(gbkInputChunks)
    const expected = iconv.encode('\u4e2d\u6587\u8f93\u5165', 'gbk')
    check(
      `服务器收到的输入字节等于 GBK 编码（${received.toString('hex')}）`,
      received.equals(expected)
    )
  }

  await shoot('windows-host-gbk-terminal')
  await killAndWait(gbkSid)

  // ---------- 3. Linux 假服务器：UTF-8 透传 + 监控正常（回归） ----------
  const linuxSid = await connectProfile('Linux 假机', LINUX_PORT, null)
  check('Linux 会话已创建', !!linuxSid)

  const linuxPlatform = await waitFor(
    'Linux 平台探测',
    `(async () => {
      const info = (await window.api.terminal.list()).find((s) => s.id === '${linuxSid}')
      return info ? info.platform ?? '' : ''
    })()`
  )
  check('平台探测结果为 linux', linuxPlatform === 'linux')

  const linuxRendered = await waitFor(
    'xterm 渲染 UTF-8 中文',
    `(() => {
      const rows = document.querySelector('.xterm-rows')
      return rows ? rows.textContent.includes(${JSON.stringify(LINUX_BANNER)}) : false
    })()`
  )
  check('xterm 正确渲染 UTF-8 中文输出（字节透传回归）', linuxRendered === true)
  {
    const recent = await evaluate(
      `(async () => await window.api.terminal.recentOutput('${linuxSid}', 4000))()`
    )
    check('主进程侧会话输出保留原文', typeof recent === 'string' && recent.includes(LINUX_BANNER))
  }

  await waitFor(
    'Linux 会话的 monitor:data',
    `(window.__probe.monitorData['${linuxSid}'] ?? 0) >= 1`,
    15000
  )
  {
    const state = await evaluate(`
      (() => {
        const s = window.__store.getState()
        return {
          data: window.__probe.monitorData['${linuxSid}'] ?? 0,
          metrics: !!s.monitors['${linuxSid}'],
          unsupported: s.monitorUnsupported['${linuxSid}'] ?? null,
          unsupportedEvent: window.__probe.unsupported.some((u) => u.sessionId === '${linuxSid}')
        }
      })()
    `)
    check('Linux 会话收到 monitor:data', state.data >= 1)
    check('store.monitors 有指标（指标条可显示）', state.metrics === true)
    check('Linux 会话没有被判为不支持', state.unsupported === null && state.unsupportedEvent === false)
  }

  await shoot('windows-host-linux-regression')
  await killAndWait(linuxSid)

  console.log('ALL PASS')
  await finish(0)
} catch (err) {
  console.error(`\n${err.stack ?? err}`)
  await finish(1)
}
