/**
 * 终端命令记录（命令 + 输出 → 主机日志）端到端验证。
 *
 * 隔离 Electron 实例（独立 userData）+ 进程内 ssh2 测试服务器 + CDP 驱动真 UI：
 * 1. 本地终端命令装配：普通命令 / 退格修正 / Ctrl+C 取消半截行 /
 *    CSI 序列导致编辑无法还原时整行不记（宁缺毋错）/ bracketed paste 多行合并；
 * 2. 来源：terminal:runScript → [脚本] 标记；SSH 未就绪时被丢弃的输入不产生记录；
 * 3. 输出回填：同 seq 条目增量更新（命令条目长出 detail），渲染端 store 按 seq 覆盖不重复；
 * 4. 原始会话文件：userData/logs/sessions/*.log 含正常命令输出、也含「未记录命令」的裸输出；
 * 5. 会话关闭：落一条「会话结束：已记录 N 条命令」（detail 为原始文件绝对路径）；
 * 6. host.log 落盘：同 seq 多行、后写为准（启动回填按 seq 去重后取最后一行）；
 * 7. 面板：终端作用域过滤行数与 store 一致 + 截图；
 * 8. 清空：内存 / host.log / 原始会话文件全部清掉。
 *
 * 跑：node scripts/verify-terminal-logging.mjs（项目根目录执行；需先 npm run build）
 * ⚠️ antd 会给「两个汉字」的按钮插空格（清 空），比对文案前先去掉空白。
 * ⚠️ AI 工具来源（[AI] 标记）需要真实模型回合，不在本探针范围（与脚本来源共用同一处 write 调用）。
 * ⚠️ bracketed paste 用例放在最后：部分 shell（如本机 Windows PowerShell）未启用 bracketed
 *    paste（输出里没有 ?2004h），合成的 \x1b[200~ / \x1b[201~ 会把 PSReadLine 带进怪状态、
 *    吞掉后续回显 —— 之后的断言不能再依赖 shell 输出，只能看命令条目的装配结果。
 */
import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import ssh2Pkg from 'ssh2'

const { Server: SshServer, utils: sshUtils } = ssh2Pkg

const CDP_PORT = 9338
const SSH_PORT = 29423
const OUT_DIR = '.workbuddy-ai/shots'
const userData = join(tmpdir(), 'dogi-ttylog-cdp')
const sessionsDir = join(userData, 'logs', 'sessions')
const hostLogFile = join(userData, 'logs', 'host.log')

const check = (label, ok) => {
  assert.ok(ok, `FAIL: ${label}`)
  console.log(`  ok  ${label}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 生成可安全内联进 CDP 表达式的 JS 字符串字面量（JSON.stringify 不转义 DEL，手动补上） */
const jsStr = (s) => JSON.stringify(s).replace(/\u007f/g, '\\x7f')

// ---------- 测试用 SSH 服务器：接受密码认证 / shell，shell 里发一句问候输出 ----------
const hostKey = sshUtils.generateKeyPairSync('rsa', { bits: 2048 })
const sshServer = new SshServer({ hostKeys: [hostKey.private] }, (client) => {
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
        // 问候输出：原始记录文件在「一条命令都还没执行」时就应该开始积累
        stream.write('probe shell ready\r\n')
        stream.on('data', () => {})
      })
    })
    client.on('request', (accept) => accept && accept())
  })
})
await new Promise((res) => sshServer.listen(SSH_PORT, '127.0.0.1', res))
console.log(`ssh2 测试服务器已监听 127.0.0.1:${SSH_PORT}`)

// ---------- 起隔离实例 ----------
await fs.rm(userData, { recursive: true, force: true })
await fs.mkdir(OUT_DIR, { recursive: true })
const log = await fs.open(join(OUT_DIR, 'terminal-logs.log'), 'a')
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

const shoot = async (name) => {
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  await fs.writeFile(join(OUT_DIR, `${name}.png`), Buffer.from(shot.data, 'base64'))
  console.log(`  ok  截图已落盘 ${OUT_DIR}/${name}.png`)
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
  for (const e of last.slice(-12)) {
    console.error(`    [${e.level}] (${e.scope}) ${e.message}`)
  }
  throw new Error(`超时：${label}`)
}

const logBySeq = (seq) =>
  evaluate(`(async () => (await window.api.logs.list()).find((e) => e.seq === ${seq}) ?? null)()`)

const allLogs = () => evaluate(`(async () => await window.api.logs.list())()`)

const writeTo = (sid, data) =>
  evaluate(
    `(async () => await window.api.terminal.write(${JSON.stringify(sid)}, ${jsStr(data)}))()`
  )

/** 原始会话记录文件（logs/sessions/*.log） */
async function sessionFiles() {
  try {
    return (await fs.readdir(sessionsDir)).filter((f) => f.endsWith('.log'))
  } catch {
    return []
  }
}

async function waitForSessionFiles(label, count, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  let files = []
  while (Date.now() < deadline) {
    files = await sessionFiles()
    if (files.length >= count) return files
    await sleep(250)
  }
  throw new Error(`超时：${label}（当前 ${files.length} 个：${files.join(', ')}）`)
}

/** 轮询原始会话文件内容（输出落盘晚于命令写入，取决于 shell 回显速度） */
async function waitForRawText(path, need, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  let text = ''
  while (Date.now() < deadline) {
    text = await fs.readFile(path, 'utf8').catch(() => '')
    if (text.includes(need)) return text
    await sleep(250)
  }
  return text
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
  check('干净 userData 启动时没有历史日志', (await allLogs()).length === 0)

  // ---------- 1. 本地终端：命令装配 ----------
  const localSid = await evaluate(`(async () => (await window.api.terminal.createLocal(80, 24)).id)()`)
  check('本地终端已创建', !!localSid)

  // 1.1 普通命令 + 输出回填
  check('普通命令写入成功', (await writeTo(localSid, 'echo hello-probe-1\r')) === true)
  const helloEntry = await waitForLog(
    '命令条目（echo hello-probe-1）',
    (e) => e.scope === 'terminal' && e.message.includes('echo hello-probe-1')
  )
  check('命令正文格式为 [标题] $ 命令', /^\[.+\] \$ echo hello-probe-1$/.test(helloEntry.message))
  check('用户来源不带 [AI] / [脚本] 标记', !helloEntry.message.includes('[AI]') && !helloEntry.message.includes('[脚本]'))
  check('命令条目级别为 info', helloEntry.level === 'info')
  {
    const deadline = Date.now() + 8000
    let entry = await logBySeq(helloEntry.seq)
    while (Date.now() < deadline && !(entry?.detail ?? '').includes('hello-probe-1')) {
      await sleep(250)
      entry = await logBySeq(helloEntry.seq)
    }
    check('输出增量回填到同一条目（detail 含命令输出）', (entry?.detail ?? '').includes('hello-probe-1'))
  }

  // 1.2 退格修正：echo abc + 3 个退格 + xyz → 实际执行 echo xyz
  await writeTo(localSid, 'echo abc\x7f\x7f\x7fxyz\r')
  await waitForLog('退格修正后的命令', (e) => e.scope === 'terminal' && /^\[.+\] \$ echo xyz$/.test(e.message))
  check(
    '退格前的半截内容没有留下错误记录',
    !(await allLogs()).some((e) => e.scope === 'terminal' && e.message.includes('echo abc'))
  )

  // 1.3 Ctrl+C 取消半截行后重新输入
  await writeTo(localSid, 'echo killme\x03echo after-cancel\r')
  await waitForLog('Ctrl+C 后的命令', (e) => e.scope === 'terminal' && /^\[.+\] \$ echo after-cancel$/.test(e.message))
  check(
    'Ctrl+C 取消的行没有被记录',
    !(await allLogs()).some((e) => e.scope === 'terminal' && e.message.includes('killme'))
  )

  // 1.4 CSI 序列（光标左移）导致编辑无法还原 → 整行不记（宁缺毋错）
  await writeTo(localSid, 'echo supersecret\x1b[DX\r')
  await writeTo(localSid, '\x1b[Decho raw-only-2\r')
  await sleep(300)
  {
    const logs = await allLogs()
    check(
      '无法还原编辑的行整行不记录（宁缺毋错）',
      !logs.some((e) => e.scope === 'terminal' && e.message.includes('supersecret')) &&
        !logs.some((e) => e.scope === 'terminal' && e.message.includes('raw-only-2'))
    )
  }

  // 1.5 脚本来源：terminal:runScript → [脚本] 标记
  const runOk = await evaluate(
    `(async () => await window.api.terminal.runScript(${JSON.stringify(localSid)}, ${jsStr('echo script-tag\r')}))()`
  )
  check('runScript 写入成功', runOk === true)
  await waitForLog(
    '脚本来源命令',
    (e) => e.scope === 'terminal' && e.message.includes('$ [脚本] echo script-tag')
  )

  // 1.6 原始会话记录文件（本地）：含正常输出，也含「未记录命令」的裸输出
  {
    const files = await waitForSessionFiles('本地会话原始记录文件', 1)
    check('本地会话产生 1 个原始记录文件', files.length === 1)
    const rawPath = join(sessionsDir, files[0])
    const rawText = await waitForRawText(rawPath, 'script-tag')
    check('原始文件包含正常命令的输出', rawText.includes('hello-probe-1'))
    check('原始文件包含未记录命令的裸输出（条目宁缺，文件保底）', rawText.includes('raw-only-2'))
    check('原始文件包含脚本命令的输出', rawText.includes('script-tag'))
  }

  // 1.7 bracketed paste：多行粘贴合并为一条命令（与 shell 一次性提交语义一致）
  // ⚠️ 排在最后：合成标记可能让不支持 bracketed paste 的 shell 吞掉后续回显（见文件头注释），
  //    本用例只断言「装配结果」（命令条目），不再依赖 shell 输出。
  await writeTo(localSid, '\x1b[200~echo paste-one\necho paste-two\n\x1b[201~\r')
  await waitForLog(
    '粘贴多行命令',
    (e) => e.scope === 'terminal' && e.message.includes('echo paste-one') && e.message.includes('echo paste-two')
  )
  check(
    '粘贴内容只产生一条记录（含换行）',
    (await allLogs()).filter((e) => e.scope === 'terminal' && e.message.includes('paste-one')).length === 1
  )

  // 1.8 会话关闭 → 「会话结束：已记录 N 条命令」（本会话恰好 5 条）
  await evaluate(`(async () => await window.api.terminal.kill(${JSON.stringify(localSid)}))()`)
  const closeEntry = await waitForLog(
    '本地会话结束条目',
    (e) => e.scope === 'terminal' && e.message.includes('会话结束：已记录 5 条命令')
  )
  check('关闭条目 detail 为原始文件路径', (closeEntry.detail ?? '').includes('sessions'))
  check(
    '关闭条目指向的文件存在',
    await fs.access(closeEntry.detail).then(
      () => true,
      () => false
    )
  )

  // ---------- 2. SSH：未就绪时丢弃 + 就绪后记录 ----------
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
  const sshProbe = await evaluate(`
    (async () => {
      const s = await window.api.terminal.createFromProfile('${profileId}', 80, 24)
      // 连接尚未就绪：这条输入必然被丢弃（write 返回 false，不产生记录）
      const dropped = await window.api.terminal.write(s.id, ${jsStr('dropped-before-ready\r')})
      return { id: s.id, dropped }
    })()
  `)
  check('连接未就绪时的写入被丢弃（返回 false）', sshProbe.dropped === false)
  await waitForLog('SSH 会话就绪', (e) => e.message === '[终端会话] 会话已就绪：tester@127.0.0.1')
  check('未就绪时丢弃的输入没有留下记录', !(await allLogs()).some((e) => e.scope === 'terminal' && e.message.includes('dropped-before-ready')))
  check('SSH 就绪后写入成功', (await writeTo(sshProbe.id, 'ls -la\r')) === true)
  await waitForLog('SSH 命令条目', (e) => e.scope === 'terminal' && /^\[tester@127\.0\.0\.1\] \$ ls -la$/.test(e.message))
  await evaluate(`(async () => await window.api.terminal.kill(${JSON.stringify(sshProbe.id)}))()`)
  const sshClose = await waitForLog(
    'SSH 会话结束条目',
    (e) => e.scope === 'terminal' && e.message.includes('会话结束：已记录 1 条命令')
  )
  check('SSH 原始文件已就绪（问候输出即建文件）', (sshClose.detail ?? '').includes('sessions'))
  {
    const files = await waitForSessionFiles('两个会话的原始记录文件', 2)
    check('两个会话各有一个原始记录文件', files.length === 2)
    let sshRaw = ''
    for (const f of files) {
      const text = await fs.readFile(join(sessionsDir, f), 'utf8')
      if (text.includes('probe shell ready')) sshRaw = text
    }
    check('SSH 原始文件包含会话开始时的输出', sshRaw.includes('probe shell ready'))
  }

  // ---------- 3. 渲染端 store：同 seq 覆盖、不重复 ----------
  {
    const storeCheck = await evaluate(`
      (() => {
        const logs = window.__store.getState().hostLogs
        const same = logs.filter((e) => e.seq === ${helloEntry.seq})
        return {
          count: same.length,
          detail: same[0]?.detail ?? '',
          hasTerminal: logs.some((e) => e.scope === 'terminal'),
          storeLen: logs.length
        }
      })()
    `)
    const listed = await allLogs()
    check('store 里同 seq 只有一条（按 seq 覆盖）', storeCheck.count === 1)
    check('store 里的命令条目带输出 detail', storeCheck.detail.includes('hello-probe-1'))
    check('store 有终端作用域记录', storeCheck.hasTerminal)
    check('store 与 logs:list 数量一致', storeCheck.storeLen === listed.length)
  }

  // ---------- 4. 面板：终端作用域过滤 ----------
  await evaluate(`window.__store.getState().openLogsTab()`)
  await sleep(700)
  await send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: 'light' }]
  })
  await sleep(400)
  await shoot('terminal-logs-all')
  await evaluate(`
    (() => {
      const item = Array.from(document.querySelectorAll('.ant-segmented-item')).find((el) => el.textContent.trim() === '终端')
      if (!item) throw new Error('找不到过滤项「终端」')
      item.click()
      return true
    })()
  `)
  await sleep(400)
  {
    const filtered = await evaluate(`
      (() => {
        const els = Array.from(document.querySelectorAll('[data-log-scope]'))
        const expected = window.__store.getState().hostLogs.filter((e) => e.scope === 'terminal').length
        return {
          count: els.length,
          expected,
          allTerminal: els.every((el) => el.getAttribute('data-log-scope') === 'terminal'),
          hasClose: document.body.textContent.includes('会话结束：已记录 5 条命令')
        }
      })()
    `)
    check('过滤「终端」后只剩 terminal 记录', filtered.allTerminal && filtered.count === filtered.expected)
    check('面板能看到会话结束条目', filtered.hasClose)
  }
  await shoot('terminal-logs-panel')
  await send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: 'dark' }]
  })
  await sleep(500)
  await shoot('terminal-logs-panel-dark')
  await send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: 'light' }]
  })
  await sleep(300)

  // ---------- 5. host.log 落盘：同 seq 多行、后写为准 ----------
  {
    const content = await fs.readFile(hostLogFile, 'utf8')
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
    check('落盘包含命令条目与结束条目', content.includes('$ echo hello-probe-1') && content.includes('会话结束：已记录 5 条命令'))
    const sameSeq = lines.map((l) => JSON.parse(l)).filter((e) => e.seq === helloEntry.seq)
    check('同 seq 因输出回填落了多行', sameSeq.length >= 2)
    check('同 seq 后写为准（最后一行含完整输出）', (sameSeq[sameSeq.length - 1].detail ?? '').includes('hello-probe-1'))
  }

  // ---------- 6. 清空：内存 / host.log / 原始会话文件 ----------
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
  await sleep(700)
  {
    const after = await evaluate(`
      (async () => ({
        listed: (await window.api.logs.list()).length,
        inStore: window.__store.getState().hostLogs.length,
        rows: document.querySelectorAll('[data-log-scope]').length
      }))()
    `)
    check('清空后主进程内存为 0', after.listed === 0)
    check('清空后 store 为 0', after.inStore === 0)
    check('清空后列表为空', after.rows === 0)
  }
  check('清空后 host.log 归零', (await fs.stat(hostLogFile)).size === 0)
  check('清空后原始会话文件一并清掉', (await sessionFiles()).length === 0)
  await shoot('terminal-logs-empty')

  console.log('ALL PASS')
  await finish(0)
} catch (err) {
  console.error(`\n${err.stack ?? err}`)
  await finish(1)
}
