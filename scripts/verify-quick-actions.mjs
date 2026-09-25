/**
 * 工作区快捷功能的端到端验证（隔离 Electron 实例 + CDP 驱动真 UI）。
 *
 * 覆盖：
 * 1. 添加工作区时自动在项目目录里建出 `.dogi/workspace.json`（+.gitignore）；
 * 2. 已存在的配置（两个链接 + 一条命令 + 一条脏数据）能读出来并渲染成顶栏下拉里的条目，
 *    非法类型在读取时被丢弃；入口与终端 / 打开同处一排，不另开一栏；
 * 3. 点「执行命令」那条真的会在工作区目录开一个终端并把命令写进去（读主进程 recentOutput）；
 * 4. 管理弹窗打开 / 列出条目 / 关掉，以及没有快捷功能时下拉里只剩「添加快捷功能…」；
 * 5. 配置文件被写坏时降级为空配置 + 告警，且**不覆盖**原文件。
 *
 * 跑：node scripts/verify-quick-actions.mjs（在项目根目录执行）
 * ⚠️ 用独立的 --user-data-dir 起实例，不碰用户常驻的那个（单实例锁按 userData 隔离）。
 * ⚠️ antd 会给「两个汉字」的按钮中间插空格（关 闭），脚本里比对文案前先去空白。
 */
import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

const PORT = 9333
const OUT_DIR = '.workbuddy-ai/shots'
const userData = join(tmpdir(), 'dogi-quickaction-cdp')
const autoWs = join(tmpdir(), 'dogi-qa-autows')
const linkWs = join(tmpdir(), 'dogi-qa-links')

const check = (label, ok) => {
  assert.ok(ok, `FAIL: ${label}`)
  console.log(`  ok  ${label}`)
}

// ---------- 准备两个干净的工作区目录 ----------
await fs.rm(autoWs, { recursive: true, force: true })
await fs.mkdir(autoWs, { recursive: true })
await fs.rm(linkWs, { recursive: true, force: true })
await fs.mkdir(join(linkWs, '.dogi'), { recursive: true })
await fs.writeFile(
  join(linkWs, '.dogi', 'workspace.json'),
  JSON.stringify(
    {
      version: 1,
      quickActions: [
        { kind: 'link', label: '项目看板', target: 'https://example.com/board' },
        {
          kind: 'link',
          label: '接口文档',
          target: 'https://example.com/api',
          description: '后端接口说明'
        },
        { kind: 'command', label: '启动服务', target: 'echo quick-action-ran' },
        { kind: 'bogus', label: '脏数据', target: 'x' }
      ]
    },
    null,
    2
  ),
  'utf8'
)

// ---------- 起隔离实例 ----------
await fs.mkdir(OUT_DIR, { recursive: true })
const log = await fs.open(join(OUT_DIR, 'quick-actions.log'), 'a')
const child = spawn(
  'node_modules/electron/dist/electron.exe',
  [
    '.',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${userData}`,
    '--no-sandbox',
    '--in-process-gpu',
    '--disable-gpu-sandbox'
  ],
  // 主进程 stdout/stderr 落到日志：窗口不出现之类的故障只能从这里看
  { stdio: ['ignore', log.fd, log.fd], detached: true }
)
child.unref()

async function pageTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page
    } catch {
      // 还没起来
    }
    await new Promise((r) => setTimeout(r, 500))
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
  const r = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true
  })
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
  await log.close()
  process.exit(code)
}

try {
  await new Promise((r) => setTimeout(r, 1500))

  // ---------- 1. 添加工作区会自动建出隐藏配置目录 ----------
  const autoId = await evaluate(`
    (async () => {
      await window.__store.getState().saveAgentWorkspace({ name: 'autows', path: ${JSON.stringify(autoWs)} })
      return window.__store.getState().agentWorkspaces.find((w) => w.path === ${JSON.stringify(autoWs)}).id
    })()
  `)
  check('新工作区已登记', !!autoId)
  const autoFile = join(autoWs, '.dogi', 'workspace.json')
  check(
    '添加工作区后 .dogi/workspace.json 自动创建',
    await fs
      .readFile(autoFile, 'utf8')
      .then((t) => JSON.parse(t).quickActions.length === 0, () => false)
  )
  check(
    '.dogi/.gitignore 一并写入',
    (await fs.readFile(join(autoWs, '.dogi', '.gitignore'), 'utf8')).includes('*')
  )

  // ---------- 2. 已有配置能读出来并渲染成按钮 ----------
  const snapshot = await evaluate(`
    (async () => {
      await window.__store.getState().saveAgentWorkspace({ name: 'links', path: ${JSON.stringify(linkWs)} })
      const s = window.__store.getState()
      const ws = s.agentWorkspaces.find((w) => w.path === ${JSON.stringify(linkWs)})
      window.__store.getState().selectAgentWorkspace(ws.id)
      window.__store.setState({ ui: { ...s.ui, activeActivity: 'agent', sidebarCollapsed: false } })
      await window.__store.getState().loadWorkspaceConfig(ws.id, true)
      const snap = window.__store.getState().workspaceConfigs[ws.id]
      return { id: ws.id, filePath: snap.filePath, labels: snap.config.quickActions.map((a) => a.label) }
    })()
  `)
  check('配置文件路径指向工作区目录内', snapshot.filePath.startsWith(linkWs))
  check(
    '脏数据（非法类型）在读取时被丢弃',
    JSON.stringify(snapshot.labels) === JSON.stringify(['项目看板', '接口文档', '启动服务'])
  )

  await new Promise((r) => setTimeout(r, 900))
  // 入口是顶栏里的下拉（与终端 / 打开同一排），条目在 .ant-dropdown-menu-item 里
  const openMenu = () =>
    evaluate(`
      (() => {
        const btn = document.querySelector('button[aria-label="快捷功能"]')
        if (!btn) throw new Error('顶栏里找不到「快捷功能」入口')
        btn.click()
        return true
      })()
    `)
  const menuItems = () =>
    evaluate(`
      Array.from(document.querySelectorAll('.ant-dropdown-menu-item')).map((el) => el.textContent.trim())
    `)

  await openMenu()
  await new Promise((r) => setTimeout(r, 400))
  const items = await menuItems()
  check('下拉里列出「项目看板」', items.includes('项目看板'))
  check('下拉里列出「接口文档」', items.includes('接口文档'))
  check('下拉里列出「启动服务」', items.includes('启动服务'))
  check('下拉最后一项是管理入口', items[items.length - 1]?.startsWith('管理快捷功能'))

  // ---------- 3. 点「启动服务」→ 在工作区目录开终端并写入命令 ----------
  const before = await evaluate(`(async () => (await window.api.terminal.list()).length)()`)
  await evaluate(`
    (() => {
      const item = Array.from(document.querySelectorAll('.ant-dropdown-menu-item')).find(
        (el) => el.textContent.trim() === '启动服务'
      )
      if (!item) throw new Error('下拉里找不到「启动服务」')
      item.click()
      return true
    })()
  `)
  await new Promise((r) => setTimeout(r, 1500))
  const sessions = await evaluate(`(async () => (await window.api.terminal.list()).length)()`)
  check('执行命令会新开一个终端会话', sessions > before)
  // 新会话的 shell 启动 + 回显需要点时间，轮询到出现为止（最多 12s）
  let out = ''
  for (let i = 0; i < 24 && !out.includes('quick-action-ran'); i++) {
    await new Promise((r) => setTimeout(r, 500))
    out = await evaluate(`
      (async () => {
        const list = await window.api.terminal.list()
        const outs = await Promise.all(list.map((s) => window.api.terminal.recentOutput(s.id, 6000)))
        return outs.filter(Boolean).join('\\n----\\n')
      })()
    `)
  }
  if (!out.includes('quick-action-ran')) console.error(`  终端最近输出：\n${out.slice(-800)}`)
  check('终端确实收到快捷功能里的命令', out.includes('quick-action-ran'))

  // ---------- 4. 管理弹窗链路（经下拉里的管理项进入） ----------
  await openMenu()
  await new Promise((r) => setTimeout(r, 400))
  await evaluate(`
    (() => {
      const item = Array.from(document.querySelectorAll('.ant-dropdown-menu-item')).find((el) =>
        el.textContent.trim().startsWith('管理快捷功能')
      )
      if (!item) throw new Error('下拉里找不到管理入口')
      item.click()
      return true
    })()
  `)
  await new Promise((r) => setTimeout(r, 700))
  const dialog = await evaluate(`
    (() => {
      const dialogs = Array.from(document.querySelectorAll('.ant-modal'))
      const visible = dialogs.filter((d) => d.offsetParent !== null)
      const text = visible.map((d) => d.textContent).join(' | ')
      return {
        count: visible.length,
        hasTitle: text.includes('工作区快捷功能'),
        hasPath: text.includes('.dogi'),
        rows: visible[0] ? visible[0].querySelectorAll('[aria-label="编辑快捷功能"]').length : 0
      }
    })()
  `)
  check('管理弹窗已打开', dialog.count >= 1 && dialog.hasTitle)
  check('弹窗里能看到配置落盘位置', dialog.hasPath)
  check('弹窗列出 3 条可编辑的快捷功能', dialog.rows === 3)

  // ---------- 5. 浅色主题截图（弹窗 / 下拉 / 无配置时的下拉） ----------
  await send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: 'light' }]
  })
  const shoot = async (name) => {
    const shot = await send('Page.captureScreenshot', { format: 'png' })
    await fs.writeFile(join(OUT_DIR, `${name}.png`), Buffer.from(shot.data, 'base64'))
    console.log(`  ok  截图已落盘 ${OUT_DIR}/${name}.png`)
  }
  await shoot('quick-actions-dialog')

  // antd 会给「两个汉字」的按钮中间插一个空格（关 闭），比对前先去掉所有空白
  await evaluate(`
    (() => {
      const btn = Array.from(document.querySelectorAll('.ant-modal button')).find(
        (b) => b.textContent.replace(/\\s+/g, '') === '关闭'
      )
      if (!btn) throw new Error('找不到弹窗的关闭按钮')
      btn.click()
      return true
    })()
  `)
  await new Promise((r) => setTimeout(r, 600))
  const stillOpen = await evaluate(`
    Array.from(document.querySelectorAll('.ant-modal')).filter((d) => d.offsetParent !== null).length
  `)
  check('点「关闭」后管理弹窗关掉', stillOpen === 0)

  // 顶栏入口的下拉：位置与终端 / 打开同一排（都在顶栏里，y 坐标应一致）
  await openMenu()
  await new Promise((r) => setTimeout(r, 400))
  const layout = await evaluate(`
    (() => {
      const trigger = document.querySelector('button[aria-label="快捷功能"]')
      const bar = trigger.closest('div')
      const tops = Array.from(bar.querySelectorAll('button')).map((b) =>
        Math.round(b.getBoundingClientRect().top)
      )
      return { tops, count: tops.length }
    })()
  `)
  check(
    '与终端 / 文件视图 / 打开同处一行（4 个按钮顶部对齐）',
    layout.count === 4 && new Set(layout.tops).size === 1
  )
  await shoot('quick-actions-menu')
  await evaluate(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`)
  await new Promise((r) => setTimeout(r, 400))

  // 没有快捷功能的工作区：下拉里只剩一条「添加快捷功能…」
  await evaluate(`
    (async () => {
      const s = window.__store.getState()
      const ws = s.agentWorkspaces.find((w) => w.path === ${JSON.stringify(autoWs)})
      window.__store.getState().selectAgentWorkspace(ws.id)
      await window.__store.getState().loadWorkspaceConfig(ws.id, true)
      return true
    })()
  `)
  await new Promise((r) => setTimeout(r, 900))
  await openMenu()
  await new Promise((r) => setTimeout(r, 400))
  const emptyItems = await menuItems()
  check(
    '无配置时下拉只剩「添加快捷功能…」',
    emptyItems.length === 1 && emptyItems[0].startsWith('添加快捷功能')
  )
  await shoot('quick-actions-menu-empty')
  await evaluate(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`)
  await new Promise((r) => setTimeout(r, 300))

  // ---------- 6. 配置被写坏：降级为空配置 + 告警，原文不覆盖 ----------
  const brokenFile = join(autoWs, '.dogi', 'workspace.json')
  await fs.writeFile(brokenFile, '{ "quickActions": [ ', 'utf8')
  const broken = await evaluate(`
    (async () => {
      const s = window.__store.getState()
      const ws = s.agentWorkspaces.find((w) => w.path === ${JSON.stringify(autoWs)})
      await window.__store.getState().loadWorkspaceConfig(ws.id, true)
      const snap = window.__store.getState().workspaceConfigs[ws.id]
      return { error: snap.error ?? null, count: snap.config.quickActions.length }
    })()
  `)
  check('损坏的配置降级为空并带出告警', !!broken.error && broken.count === 0)
  check('损坏的原文没有被覆盖', (await fs.readFile(brokenFile, 'utf8')).includes('quickActions'))

  console.log('ALL PASS')
  await finish(0)
} catch (err) {
  console.error(`\n${err.stack ?? err}`)
  await finish(1)
}
