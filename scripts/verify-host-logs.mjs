/**
 * 主机日志（SSH / 隧道 / SFTP）端到端验证。
 *
 * 隔离 Electron 实例（独立 userData）+ 进程内 ssh2 测试服务器 + CDP 驱动真 UI：
 * 1. ssh:test → 「连接测试」连接日志 + 首连 TOFU 指纹记录，并经 logs:entry 实时推到渲染端 store（不刷新）；
 * 2. 终端会话就绪 / 关闭各落一条；knownHosts 重置落一条；
 * 3. 隧道启动 / 配置变更重启 / 手动停止的文案；服务器强断 → error 级「因 SSH 连接断开而中断」；
 * 4. SFTP 失败路径（通道被拒 / 配置不存在）落 error 级日志；
 * 5. 落盘 JSONL（userData/logs/host.log）：逐行可解析、包含关键事件；清空后文件归零；
 * 6. 日志面板：单例标签、行渲染、作用域过滤、关键字搜索、清空。
 *
 * 跑：node tmp/verify-host-logs.mjs（项目根目录执行）
 * ⚠️ antd 会给「两个汉字」的按钮插空格（清 空），比对文案前先去掉空白。
 * ⚠️ SFTP 服务器端故意拒绝 subsystem —— 探针要的就是「失败也进日志」这条路径。
 */
import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import ssh2Pkg from 'ssh2'

const { Server: SshServer, utils: sshUtils } = ssh2Pkg

const CDP_PORT = 9337
const SSH_PORT = 29422
const TUNNEL_PORT = 28471
const OUT_DIR = '.workbuddy-ai/shots'
const userData = join(tmpdir(), 'dogi-hostlogs-cdp')

const check = (label, ok) => {
  assert.ok(ok, `FAIL: ${label}`)
  console.log(`  ok  ${label}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------- 测试用 SSH 服务器：接受密码认证 / shell，拒绝 sftp ----------
const hostKey = sshUtils.generateKeyPairSync('rsa', { bits: 2048 })
const liveClients = new Set()
const sshServer = new SshServer({ hostKeys: [hostKey.private] }, (client) => {
  client.on('authentication', (ctx) => {
    if (ctx.method === 'password' && ctx.username === 'tester') ctx.accept()
    else ctx.reject(['password'])
  })
  client.on('ready', () => {
    liveClients.add(client)
    client.on('close', () => liveClients.delete(client))
    client.on('session', (accept) => {
      const session = accept()
      session.on('pty', (a) => a && a())
      session.on('shell', (a) => {
        const stream = a()
        stream.on('data', () => {})
      })
      // 刻意拒绝：验证「SFTP 通道开不起来」会落 error 日志
      session.on('sftp', (_a, reject) => reject && reject())
    })
    // -L 转发时客户端会开 direct-tcpip 通道；探针不做真实转发，接受后立刻关闭
    client.on('tcpip', (accept) => {
      try {
        accept().close()
      } catch {
        // 忽略
      }
    })
    client.on('request', (accept) => accept && accept())
  })
})
await new Promise((res) => sshServer.listen(SSH_PORT, '127.0.0.1', res))
console.log(`ssh2 测试服务器已监听 127.0.0.1:${SSH_PORT}`)

// ---------- 起隔离实例 ----------
await fs.rm(userData, { recursive: true, force: true })
await fs.mkdir(OUT_DIR, { recursive: true })
const log = await fs.open(join(OUT_DIR, 'host-logs.log'), 'a')
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
  sshServer.close()
  await log.close()
  process.exit(code)
}

/** 轮询 logs:list 直到出现满足条件的条目（返回该条目） */
async function waitForLog(label, pred, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs
  let last = []
  while (Date.now() < deadline) {
    last = await evaluate(`(async () => await window.api.logs.list())()`)
    const hit = last.find((e) => pred(e))
    if (hit) return hit
    await sleep(250)
  }
  console.error(`  最后 ${last.length} 条日志：`)
  for (const e of last.slice(-10)) {
    console.error(`    [${e.level}] (${e.scope}) ${e.message}`)
  }
  throw new Error(`超时：${label}`)
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

  // ---------- 0. 启动一致性：store 初始数据来自 logs:list ----------
  {
    const consistency = await evaluate(`
      (async () => {
        const listed = await window.api.logs.list()
        return { listed: listed.length, inStore: window.__store.getState().hostLogs.length, zero: listed.length === 0 }
      })()
    `)
    check('干净 userData 启动时没有历史日志', consistency.zero)
    check('store 初始量与 logs:list 一致', consistency.listed === consistency.inStore)
  }

  // ---------- 1. 建主机 + ssh:test ----------
  const profileId = await evaluate(`
    (async () => {
      const list = await window.api.ssh.save({
        id: '', kind: 'ssh', name: '探针主机', host: '127.0.0.1', port: ${SSH_PORT},
        username: 'tester', authType: 'password', password: 'pw'
      })
      return list.find((p) => p.name === '探针主机').id
    })()
  `)
  check('主机已保存', !!profileId)

  const testResult = await evaluate(`
    (async () =>
      await window.api.ssh.test({
        id: '', kind: 'ssh', name: '探针主机', host: '127.0.0.1', port: ${SSH_PORT},
        username: 'tester', authType: 'password', password: 'pw'
      }))()
  `)
  check('ssh:test 成功并返回耗时', typeof testResult.ms === 'number')

  await sleep(400)
  {
    // 实时推送：不调 refreshHostLogs / logs:list，直接看 store 里有没有
    const pushed = await evaluate(`
      (() => {
        const logs = window.__store.getState().hostLogs
        return {
          connecting: logs.some((e) => e.message === '[连接测试] 正在连接 tester@127.0.0.1:${SSH_PORT}'),
          ready: logs.some((e) => e.message.includes('[连接测试] 已连接 tester@127.0.0.1:${SSH_PORT}')),
          tofu: logs.some((e) => e.message.includes('首次连接 127.0.0.1:${SSH_PORT}，已记录主机指纹'))
        }
      })()
    `)
    check('logs:entry 实时推送到 store（正在连接）', pushed.connecting)
    check('logs:entry 实时推送到 store（已连接 + 耗时）', pushed.ready)
    check('首连 TOFU 指纹记录已入日志', pushed.tofu)
  }

  // ---------- 2. 终端会话：就绪 / 关闭 ----------
  const sid = await evaluate(
    `(async () => (await window.api.terminal.createFromProfile('${profileId}')).id)()`
  )
  check('终端会话已创建', !!sid)
  await waitForLog('终端会话就绪', (e) => e.message === '[终端会话] 会话已就绪：tester@127.0.0.1')

  await evaluate(`(async () => await window.api.terminal.kill('${sid}'))()`)
  await waitForLog('终端会话关闭', (e) => e.message === '[终端会话] 会话已关闭：tester@127.0.0.1')

  // ---------- 3. 隧道：启动 / 强断 / 重启 / 停止 ----------
  const tunnelId = await evaluate(`
    (async () => {
      const saved = await window.api.tunnels.save({
        id: '', profileId: '${profileId}', type: 'local',
        bindHost: '127.0.0.1', bindPort: ${TUNNEL_PORT},
        targetHost: '127.0.0.1', targetPort: 80, label: '探针隧道',
        createdAt: 0, updatedAt: 0
      })
      return saved.tunnels.find((t) => t.label === '探针隧道').id
    })()
  `)
  check('隧道配置已保存', !!tunnelId)

  await evaluate(`(async () => await window.api.tunnels.start('${tunnelId}'))()`)
  await waitForLog('隧道启动日志', (e) => e.message === '「探针隧道」已启动')
  await waitForLog(
    '隧道启动中日志（含路由）',
    (e) =>
      e.message === `「探针隧道」启动中：本地转发 127.0.0.1:${TUNNEL_PORT} → 127.0.0.1:80`
  )
  {
    const status = await evaluate(`window.__store.getState().tunnelRuntime['${tunnelId}']?.status`)
    check('隧道运行态为 running', status === 'running')
  }

  // 服务器侧强断所有连接 → 隧道应落 error 级日志并停止
  for (const c of liveClients) c.end()
  const cutLog = await waitForLog(
    '隧道连接断开日志',
    (e) => e.message === '「探针隧道」因 SSH 连接断开而中断'
  )
  check('断开日志级别为 error（scope=tunnel）', cutLog.level === 'error' && cutLog.scope === 'tunnel')
  {
    const deadline = Date.now() + 6000
    let status = ''
    while (Date.now() < deadline && status !== 'error') {
      status = await evaluate(`window.__store.getState().tunnelRuntime['${tunnelId}']?.status`)
      if (status !== 'error') await sleep(250)
    }
    check('隧道运行态回落为 error', status === 'error')
  }

  // 重启 → 保存（运行中被编辑：先停后起）→ 停掉
  await evaluate(`(async () => await window.api.tunnels.start('${tunnelId}'))()`)
  {
    // 等运行态真的回到 running（start 是异步的，保存前必须确认）
    const deadline = Date.now() + 8000
    let status = ''
    while (Date.now() < deadline && status !== 'running') {
      status = await evaluate(`window.__store.getState().tunnelRuntime['${tunnelId}']?.status`)
      if (status !== 'running') await sleep(250)
    }
    check('隧道重新启动后 running', status === 'running')
  }
  await evaluate(`
    (async () => {
      const list = await window.api.tunnels.list()
      const t = list.tunnels.find((x) => x.id === '${tunnelId}')
      await window.api.tunnels.save({ ...t, label: '探针隧道2' })
    })()
  `)
  await waitForLog(
    '配置变更重启：先停',
    (e) => e.message === '「探针隧道2」已停止（配置变更，正在重启）'
  )
  await waitForLog('配置变更重启：后起（新名字）', (e) => e.message === '「探针隧道2」启动中：本地转发 127.0.0.1:' + TUNNEL_PORT + ' → 127.0.0.1:80')
  {
    const deadline = Date.now() + 8000
    let status = ''
    while (Date.now() < deadline && status !== 'running') {
      status = await evaluate(`window.__store.getState().tunnelRuntime['${tunnelId}']?.status`)
      if (status !== 'running') await sleep(250)
    }
    check('改名重启后隧道 running', status === 'running')
  }
  await evaluate(`(async () => await window.api.tunnels.stop('${tunnelId}'))()`)
  await waitForLog('隧道手动停止', (e) => e.message === '「探针隧道2」已停止')

  // ---------- 4. SFTP：两条失败路径 ----------
  const sftpErr1 = await evaluate(`
    (async () => {
      try {
        await window.api.sftp.open('probe-sftp-1', '${profileId}')
        return 'resolved'
      } catch (e) {
        return String((e && e.message) || e)
      }
    })()
  `)
  check('SFTP 通道被拒时调用侧收到错误', sftpErr1 !== 'resolved')
  const sftpLog1 = await waitForLog(
    'SFTP 连接失败日志',
    (e) => e.scope === 'sftp' && e.message.startsWith('连接失败（tester@127.0.0.1）')
  )
  check('SFTP 连接失败日志级别为 error', sftpLog1.level === 'error')
  const sftpErr2 = await evaluate(`
    (async () => {
      try {
        await window.api.sftp.open('probe-sftp-2', 'nope-id')
        return 'resolved'
      } catch (e) {
        return String((e && e.message) || e)
      }
    })()
  `)
  check('SFTP 配置不存在时调用侧收到错误', sftpErr2 !== 'resolved')
  await waitForLog(
    'SFTP 配置不存在日志',
    (e) => e.scope === 'sftp' && e.message === '连接失败：主机配置不存在（nope-id）'
  )

  // ---------- 5. 指纹重置也入日志 ----------
  await evaluate(`(async () => await window.api.ssh.knownHostsReset('127.0.0.1', ${SSH_PORT}))()`)
  await waitForLog(
    '指纹重置日志',
    (e) => e.message === `已重置主机指纹：127.0.0.1:${SSH_PORT}（下次连接重新记录）`
  )

  // ---------- 6. 面板 UI ----------
  {
    const logs = await evaluate(`(async () => await window.api.logs.list())()`)
    check('日志按 seq 递增返回', logs.every((e, i) => i === 0 || e.seq > logs[i - 1].seq))
  }
  await evaluate(`window.__store.getState().openLogsTab()`)
  await evaluate(`window.__store.getState().openLogsTab()`)
  await sleep(600)
  {
    const tabs = await evaluate(`
      window.__store.getState().ui.panelTabs.filter((t) => t.type === 'logs').map((t) => ({ id: t.id, title: t.title }))
    `)
    check('日志标签为全局单例（重复打开不叠加）', tabs.length === 1)
    check('标签 id / 标题正确', tabs[0]?.id === 'logs' && tabs[0]?.title === '主机日志')
  }
  {
    const rows = await evaluate(`
      (() => {
        const els = Array.from(document.querySelectorAll('[data-log-scope]'))
        const scopes = {}
        const levels = {}
        for (const el of els) {
          const s = el.getAttribute('data-log-scope')
          const l = el.getAttribute('data-log-level')
          scopes[s] = (scopes[s] ?? 0) + 1
          levels[l] = (levels[l] ?? 0) + 1
        }
        return { count: els.length, scopes, levels, store: window.__store.getState().hostLogs.length }
      })()
    `)
    check('日志行已渲染且与 store 一致', rows.count > 0 && rows.count === rows.store)
    check('三类作用域都有记录', (rows.scopes.ssh ?? 0) >= 1 && (rows.scopes.tunnel ?? 0) >= 1 && (rows.scopes.sftp ?? 0) >= 1)
    check('存在 error 级记录（样式点对应）', (rows.levels.error ?? 0) >= 1)
  }
  // 作用域过滤
  await evaluate(`
    (() => {
      const item = Array.from(document.querySelectorAll('.ant-segmented-item')).find((el) => el.textContent.trim() === '隧道')
      if (!item) throw new Error('找不到过滤项「隧道」')
      item.click()
      return true
    })()
  `)
  await sleep(400)
  {
    const filtered = await evaluate(`
      (() => {
        const els = Array.from(document.querySelectorAll('[data-log-scope]'))
        const expected = window.__store.getState().hostLogs.filter((e) => e.scope === 'tunnel').length
        return { count: els.length, expected, allTunnel: els.every((el) => el.getAttribute('data-log-scope') === 'tunnel') }
      })()
    `)
    check('过滤「隧道」后只剩 tunnel 记录', filtered.allTunnel && filtered.count === filtered.expected)
  }
  // 关键字搜索（先切回全部）
  await evaluate(`
    (() => {
      const item = Array.from(document.querySelectorAll('.ant-segmented-item')).find((el) => el.textContent.trim() === '全部')
      item.click()
      return true
    })()
  `)
  await sleep(300)
  await evaluate(`
    (() => {
      const input = document.querySelector('input[placeholder="搜索日志…"]')
      if (!input) throw new Error('找不到搜索框')
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(input, '会话已就绪')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()
  `)
  await sleep(400)
  {
    const searched = await evaluate(`
      (() => {
        const els = Array.from(document.querySelectorAll('[data-log-scope]'))
        return { count: els.length, texts: els.map((el) => el.textContent) }
      })()
    `)
    check('搜索「会话已就绪」只剩 1 条', searched.count === 1)
    check('搜索命中内容正确', searched.texts[0]?.includes('会话已就绪'))
  }
  // 清掉搜索词
  await evaluate(`
    (() => {
      const input = document.querySelector('input[placeholder="搜索日志…"]')
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(input, '')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()
  `)
  await sleep(300)

  // ---------- 7. 落盘 JSONL ----------
  const logFile = join(userData, 'logs', 'host.log')
  const content = await fs.readFile(logFile, 'utf8')
  const lines = content.split('\n').filter(Boolean)
  check('host.log 已落盘且非空', lines.length > 0)
  check(
    '每行都是合法 JSON（JSONL）',
    lines.every((l) => {
      try {
        return typeof JSON.parse(l).seq === 'number'
      } catch {
        return false
      }
    })
  )
  check('落盘包含终端会话事件', content.includes('会话已就绪') && content.includes('会话已关闭'))
  check('落盘包含隧道事件', content.includes('「探针隧道」已启动'))
  check('落盘包含 error 级记录', lines.some((l) => JSON.parse(l).level === 'error'))

  // ---------- 8. 截图（亮 / 暗） ----------
  const shoot = async (name) => {
    const shot = await send('Page.captureScreenshot', { format: 'png' })
    await fs.writeFile(join(OUT_DIR, `${name}.png`), Buffer.from(shot.data, 'base64'))
    console.log(`  ok  截图已落盘 ${OUT_DIR}/${name}.png`)
  }
  await send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: 'light' }]
  })
  await sleep(500)
  await shoot('host-logs-panel')
  await send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: 'dark' }]
  })
  await sleep(500)
  await shoot('host-logs-panel-dark')
  await send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: 'light' }]
  })
  await sleep(300)

  // ---------- 9. 清空（Popconfirm → 内存 + 文件都归零） ----------
  await evaluate(`
    (() => {
      const btn = Array.from(document.querySelectorAll('button')).find(
        (b) => b.textContent.replace(/\\s+/g, '') === '清空' && b.closest('.ant-popover') === null
      )
      if (!btn) throw new Error('找不到清空按钮')
      btn.click()
      return true
    })()
  `)
  await sleep(500)
  {
    const confirmOk = await evaluate(`
      (() => {
        const btn = Array.from(document.querySelectorAll('.ant-popover button')).find(
          (b) => b.textContent.replace(/\\s+/g, '') === '清空'
        )
        if (!btn) return false
        btn.click()
        return true
      })()
    `)
    check('弹出确认框并点到「清空」', confirmOk)
  }
  await sleep(600)
  {
    const after = await evaluate(`
      (async () => {
        const listed = await window.api.logs.list()
        const rows = document.querySelectorAll('[data-log-scope]').length
        return {
          listed: listed.length,
          inStore: window.__store.getState().hostLogs.length,
          rows,
          emptyText: document.body.textContent.includes('还没有日志')
        }
      })()
    `)
    check('清空后主进程内存为 0', after.listed === 0)
    check('清空后 store 为 0', after.inStore === 0)
    check('清空后列表为空（显示空状态）', after.rows === 0 && after.emptyText)
  }
  check('清空后落盘文件归零', (await fs.stat(logFile)).size === 0)
  await shoot('host-logs-empty')

  console.log('ALL PASS')
  await finish(0)
} catch (err) {
  console.error(`\n${err.stack ?? err}`)
  await finish(1)
}
