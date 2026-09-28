/**
 * E2E 验证：SFTP 上传文件夹 + 传输托盘持久化 + 打开文件位置。
 *
 * 起一个进程内的假 SFTP 服务器（ssh2 Server，服务端 sftp 子系统实例的事件式 API：
 * OPENDIR/READDIR/OPEN/WRITE/CLOSE/LSTAT/STAT/MKDIR/REALPATH —— 见下方实现处的注意事项），
 * 再起隔离 Electron 实例，用 CDP 驱动真实 UI：
 *
 *   1. 在「文件管理」页点「上传 → 上传文件夹…」，
 *      断言假服务器收到逐层 MKDIR + 每个文件的 WRITE（内容与源文件一致）。
 *      原生目录选择框无法被自动化点击，主进程通过 DOGI_SFTP_UPLOAD_DIR
 *      环境变量走旁路（见 ipc/sftp.ts；正常运行不设置该变量）。
 *   2. 任务面板：完成的条目**不会自动移除**（越过旧的 3s/5s 自动清理窗口仍存在）。
 *   3. 完成的 上传 / 下载 条目带「打开文件位置」图标；已取消 / 失败 / 复制移动没有。
 *   4. 「清除已完成」清空面板，入口随之消失。
 *
 * ⚠️ 打开文件位置会真实弹出一次系统文件管理器（验证的就是这个行为），属正常现象。
 */
import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import ssh2Pkg from 'ssh2'

const { Server: SshServer, utils: sshUtils } = ssh2Pkg

const CDP_PORT = 9339
const SSH_PORT = 29424
const OUT_DIR = '.workbuddy-ai/shots'
const userData = join(tmpdir(), 'dogi-sftp-probe-cdp')
/** 探针源目录（上传文件夹的输入）；主进程经 DOGI_SFTP_UPLOAD_DIR 读取 */
const SOURCE_DIR = join(tmpdir(), 'dogi-sftp-up-src')

const check = (label, ok) => {
  assert.ok(ok, `FAIL: ${label}`)
  console.log(`  ok  ${label}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------- 假 SFTP 服务器：内存目录树（ssh2 服务端事件式 API）----------
//
// ⚠️ 服务端 `session.on('sftp')` 的 accept() 返回的是一个**已就绪的 SFTP 协议实例**：
// 它自己负责帧解析与 INIT/VERSION 握手，按请求类型发事件（OPENDIR/READDIR/OPEN/…），
// 而**没有监听者的请求类型会被自动回 OP_UNSUPPORTED** —— 所以每个要支持的类型都必须挂监听，
// 不要自己解析字节流（服务端实例不会发 'data' 事件）。
const dirs = new Set(['/'])
const mkdirOps = []
/** 已写完整的文件：远端路径 → Buffer */
const files = new Map()
/** 打开中的句柄：uint32 → { kind, path, chunks?, writable? } */
const handles = new Map()
let handleSeq = 0

const DIR_ATTRS = { mode: 0o40755, size: 0, atime: 1, mtime: 1 }
const fileAttrs = (path) => ({ mode: 0o100644, size: files.get(path).length, atime: 1, mtime: 1 })
/** 句柄一律用 4 字节 uint32，客户端会原样回传 */
const handleBuf = (id) => {
  const b = Buffer.alloc(4)
  b.writeUInt32BE(id)
  return b
}
const handleId = (handle) => handle.readUInt32BE(0)

const hostKey = sshUtils.generateKeyPairSync('rsa', { bits: 2048 })
const sshServer = new SshServer({ hostKeys: [hostKey.private] }, (client) => {
  client.on('authentication', (ctx) => {
    if (ctx.method === 'password' && ctx.username === 'tester') ctx.accept()
    else ctx.reject(['password'])
  })
  client.on('ready', () => {
    client.on('session', (accept) => {
      const session = accept()
      session.on('sftp', (acceptSftp) => {
        const sftp = acceptSftp()

        const statHandler = (reqID, path) => {
          if (dirs.has(path)) sftp.attrs(reqID, DIR_ATTRS)
          else if (files.has(path)) sftp.attrs(reqID, fileAttrs(path))
          else sftp.status(reqID, 2) // NO_SUCH_FILE
        }

        sftp.on('REALPATH', (reqID, path) => {
          sftp.name(reqID, { filename: path, longname: path, attrs: DIR_ATTRS })
        })
        sftp.on('STAT', statHandler)
        sftp.on('LSTAT', statHandler)
        sftp.on('MKDIR', (reqID, path) => {
          if (dirs.has(path)) return sftp.status(reqID, 4) // 已存在 → FAILURE（服务侧会 lstat 复核）
          dirs.add(path)
          mkdirOps.push(path)
          sftp.status(reqID, 0)
        })
        sftp.on('OPEN', (reqID, filename, pflags) => {
          const id = ++handleSeq
          // pflags 0x02 = WRITE；只有写句柄在 CLOSE 时落盘，读句柄不覆盖内容
          handles.set(id, { kind: 'file', path: filename, chunks: [], writable: (pflags & 2) !== 0 })
          sftp.handle(reqID, handleBuf(id))
        })
        sftp.on('WRITE', (reqID, handle, offset, data) => {
          const h = handles.get(handleId(handle))
          if (!h) return sftp.status(reqID, 4)
          h.chunks.push(data)
          sftp.status(reqID, 0)
        })
        sftp.on('CLOSE', (reqID, handle) => {
          const id = handleId(handle)
          const h = handles.get(id)
          if (h?.kind === 'file' && h.writable) files.set(h.path, Buffer.concat(h.chunks))
          handles.delete(id)
          sftp.status(reqID, 0)
        })
        sftp.on('FSTAT', (reqID, handle) => {
          const h = handles.get(handleId(handle))
          sftp.attrs(reqID, { mode: 0o100644, size: h ? Buffer.concat(h.chunks).length : 0, atime: 1, mtime: 1 })
        })
        sftp.on('OPENDIR', (reqID, path) => {
          if (!dirs.has(path)) return sftp.status(reqID, 2)
          const id = ++handleSeq
          handles.set(id, { kind: 'dir', path })
          sftp.handle(reqID, handleBuf(id))
        })
        sftp.on('READDIR', (reqID, handle) => {
          // 探针里远端目录恒为空：读完直接 EOF（客户端据此结束读取并 CLOSE）
          if (!handles.has(handleId(handle))) return sftp.status(reqID, 4)
          sftp.status(reqID, 1) // EOF
        })
        sftp.on('error', () => {})
      })
    })
    client.on('request', (a) => a && a())
  })
})
await new Promise((res) => sshServer.listen(SSH_PORT, '127.0.0.1', res))
console.log(`假 SFTP 服务器已监听 127.0.0.1:${SSH_PORT}`)

// ---------- 探针源目录：a.txt + sub/b.txt + sub/deep/c.txt ----------
await fs.rm(SOURCE_DIR, { recursive: true, force: true })
await fs.mkdir(join(SOURCE_DIR, 'sub', 'deep'), { recursive: true })
await fs.writeFile(join(SOURCE_DIR, 'a.txt'), 'alpha-file')
await fs.writeFile(join(SOURCE_DIR, 'sub', 'b.txt'), 'beta-file')
await fs.writeFile(join(SOURCE_DIR, 'sub', 'deep', 'c.txt'), 'gamma-file')
console.log(`源目录就绪：${SOURCE_DIR}`)

// ---------- 隔离实例（带上传文件夹旁路环境变量）----------
await fs.rm(userData, { recursive: true, force: true })
await fs.mkdir(OUT_DIR, { recursive: true })
const log = await fs.open(join(OUT_DIR, 'sftp-transfers.log'), 'w')
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
  { stdio: ['ignore', log.fd, log.fd], detached: true, env: { ...process.env, DOGI_SFTP_UPLOAD_DIR: SOURCE_DIR } }
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

/** 页面内小工具（去掉全部空白再比对文案，规避 antd 两字按钮插空格） */
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

try {
  // ---------- 0. bootstrap ----------
  await waitFor(
    'bootstrap（shells 已加载）',
    `(window.__store ? window.__store.getState().shells !== null : false)`,
    30000
  )

  // ---------- 1. 打开「文件管理」页，连到假服务器 ----------
  const profileId = await evaluate(`
    (async () => {
      const list = await window.api.ssh.save({
        id: '', kind: 'ssh', name: 'SFTP 探针', host: '127.0.0.1', port: ${SSH_PORT},
        username: 'tester', authType: 'password', password: 'pw'
      })
      return list.find((p) => p.name === 'SFTP 探针').id
    })()
  `)
  check('主机已保存', !!profileId)
  await evaluate(`window.__store.getState().openSftpTab(${JSON.stringify(profileId)})`)
  await waitFor('SFTP 页已连接（空目录）', `document.body.innerText.includes('目录为空')`, 20000)
  check('SFTP 连接就绪且列目录成功', true)

  // ---------- 2. 上传文件夹：点击 上传 → 上传文件夹… ----------
  const opened = await evaluate(CLICK_BY_TEXT('上传'))
  check('工具栏「上传」按钮存在', opened === true)
  await sleep(500)
  const clickedDir = await evaluate(`
    (() => {
      const item = [...document.querySelectorAll('.ant-dropdown li, .ant-dropdown-menu-item')].find(
        (li) => (li.textContent || '').replace(/\\s+/g, '').includes('上传文件夹')
      )
      if (item) { item.click(); return true }
      return false
    })()
  `)
  check('下拉里点击「上传文件夹…」', clickedDir === true)

  // 等服务端收齐：逐层 mkdir + 3 个文件写入
  {
    const start = Date.now()
    while (files.size < 3) {
      if (Date.now() - start > 20000) break
      await sleep(250)
    }
  }
  const base = '/dogi-sftp-up-src'
  check('远端根目录已创建', mkdirOps.includes(base))
  check('子目录 sub 已创建', mkdirOps.includes(`${base}/sub`))
  check('嵌套目录 sub/deep 已创建', mkdirOps.includes(`${base}/sub/deep`))
  check('mkdir 顺序：sub 先于 deep', mkdirOps.indexOf(`${base}/sub`) < mkdirOps.indexOf(`${base}/sub/deep`))
  check('a.txt 内容一致', files.get(`${base}/a.txt`)?.toString() === 'alpha-file')
  check('sub/b.txt 内容一致', files.get(`${base}/sub/b.txt`)?.toString() === 'beta-file')
  check('sub/deep/c.txt 内容一致', files.get(`${base}/sub/deep/c.txt`)?.toString() === 'gamma-file')

  // ---------- 3. 页面提示 + store：3 笔上传全部完成且带 localPath ----------
  await waitFor('上传完成提示', `document.body.innerText.includes('文件夹上传完成')`)
  await waitFor(
    'store 里 3 笔上传均完成',
    `(() => {
      const t = Object.values(window.__store.getState().transfers)
      return t.length === 3 && t.every((x) => x.kind === 'upload' && x.done && x.localPath)
    })()`
  )
  check('3 笔上传（每文件一笔）均完成且带本地路径', true)

  // ---------- 4. 托盘：打开面板，条目留在面板里（不自动移除）----------
  // 按钮用 title 定位：内部含 Badge / 小圆点，文本匹配不可靠
  const trayOpened = await evaluate(`
    (() => {
      const btn = document.querySelector('button[title="传输任务"]')
      if (!btn) return false
      btn.click()
      return true
    })()
  `)
  check('状态栏「传输」入口存在', trayOpened === true)
  await waitFor('传输面板打开', `document.querySelector('.ant-popover') && document.querySelector('.ant-popover').innerText.includes('a.txt')`)
  const trayText = () =>
    evaluate(`(document.querySelector('.ant-popover')?.innerText ?? '')`)
  const revealCount = () =>
    evaluate(`document.querySelectorAll('.ant-popover button[title="打开文件位置"]').length`)
  let text = await trayText()
  check('面板含三笔上传', ['a.txt', 'b.txt', 'c.txt'].every((n) => text.includes(n)))
  check('三条均显示（完成）', (text.match(/（完成）/g) ?? []).length === 3)
  check('完成条目均带「打开文件位置」图标', (await revealCount()) === 3)

  await sleep(6500) // 越过旧的 3s/5s 自动移除窗口
  text = await trayText()
  check('6.5 秒后仍全部保留（不再自动移除）', ['a.txt', 'b.txt', 'c.txt'].every((n) => text.includes(n)))

  // ---------- 5. 注入假条目：下载完成带图标、已取消不带 ----------
  await evaluate(`
    (() => {
      const s = window.__store.getState()
      s.upsertTransfer({ connId: 'x', transferId: 'probe-dl', kind: 'download', name: 'probe-dl.zip',
        bytes: 100, total: 100, done: true, localPath: ${JSON.stringify(join(SOURCE_DIR, 'a.txt'))} })
      s.upsertTransfer({ connId: 'x', transferId: 'probe-cancel', kind: 'upload', name: 'probe-cancel.txt',
        bytes: 0, total: 0, done: true, canceled: true })
      return true
    })()
  `)
  await waitFor('假条目出现在面板', `document.querySelector('.ant-popover').innerText.includes('probe-dl.zip')`)
  text = await trayText()
  check('下载完成条目也带「打开文件位置」图标', (await revealCount()) === 4)
  check('已取消条目显示（已取消）', text.includes('（已取消）'))
  check('已取消条目不提供打开位置', (text.match(/probe-cancel\.txt/g) ?? []).length === 1)

  // ---------- 6. 打开文件位置：错误路径返回 ok:false；真实点击弹一次文件管理器 ----------
  const bad = await evaluate(`window.api.shell.revealPath(${JSON.stringify(join(SOURCE_DIR, '不存在.txt'))})`)
  check('不存在的路径返回 ok:false', bad && bad.ok === false)
  const clicked = await evaluate(`
    (() => {
      const btn = document.querySelector('.ant-popover button[title="打开文件位置"]')
      if (!btn) return false
      btn.click()
      return true
    })()
  `)
  check('点击「打开文件位置」（会真实弹出一次文件管理器）', clicked === true)
  await sleep(800)
  check('点击后无错误提示', !(await evaluate(`document.body.innerText.includes('打开文件位置失败')`)))

  const shot = await send('Page.captureScreenshot', { format: 'png' })
  await fs.writeFile(join(OUT_DIR, 'sftp-transfer-tray.png'), Buffer.from(shot.data, 'base64'))
  console.log(`  ok  截图已落盘 ${OUT_DIR}/sftp-transfer-tray.png`)

  // ---------- 7. 清除已完成：面板清空、入口消失 ----------
  await evaluate(CLICK_BY_TEXT('清除已完成'))
  await waitFor('store 清空', `Object.keys(window.__store.getState().transfers).length === 0`)
  check('清除已完成后 store 为空', true)
  await waitFor('传输入口消失', `!document.querySelector('button[title="传输任务"]')`)
  check('无任务时状态栏入口消失', true)

  console.log('\nALL PASS')
} catch (err) {
  console.error('\nFAIL:', err.message)
  try {
    const shot = await send('Page.captureScreenshot', { format: 'png' })
    await fs.writeFile(join(OUT_DIR, 'sftp-transfer-fail.png'), Buffer.from(shot.data, 'base64'))
    console.error('失败截图已落盘 .workbuddy-ai/shots/sftp-transfer-fail.png')
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
    process.kill(child.pid)
  } catch {
    // 已退出
  }
  try {
    sshServer.close()
  } catch {
    // 忽略
  }
  await log.close()
  process.exit(process.exitCode ?? 0)
}
