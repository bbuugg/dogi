/**
 * 终端命令历史（跨会话共享 / 持久化 / 管理）端到端验证 —— 隔离实例 + CDP。
 *
 * 链路：
 *   1. 真实键盘在终端里执行 'echo dogi-history-e2e' → 回车后全局 store 出现该条
 *      （渲染端 onData → pushCommandHistory → IPC history:add 全链路）；
 *   2. 再开一个终端标签，键入 'echo dogi' → 预测下拉出现来自**另一个标签**的历史
 *      （跨会话共享的 UI 证明）；
 *   3. 设置 → 终端：管理卡片显示条数、搜索过滤、单条删除、清空（Popconfirm）；
 *   4. 再用真实键盘记录一条 → 杀掉应用 → 同一 userData 重启 → bootstrap 灌回
 *      该条（持久化），且被删除的不在（删除也落了盘）。
 *
 * 跑：node scripts/verify-command-history-ui.mjs（项目根目录执行；需先 npm run build）
 */

import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { connect, sleep } from './lib/cdp.mjs'

const CDP_PORT = 9345
const userData = join(tmpdir(), 'dogi-cmd-history-cdp')

const check = (label, ok) => {
  assert.ok(ok, `FAIL: ${label}`)
  console.log(`  ok  ${label}`)
}

// ⚠️ 必须整体带括号：三元是最低优先级，裸拼 `${storeExpr}.shells` 会把 `.shells`
// 吞进 false 分支变成 `null.shells`（TypeError: reading 'shells'）
const storeExpr = `(window.__store ? window.__store.getState() : null)`

/** 预测下拉容器（头部提示文案定位）与建议行 */
const DROPDOWN_ROWS_EXPR = `(() => {
  const hint = [...document.querySelectorAll('div')].find((d) => d.childElementCount === 0 && (d.textContent || '').includes('命令预测 ·'))
  if (!hint || !hint.parentElement) return []
  return [...hint.parentElement.querySelectorAll(':scope > button')].map((b) => (b.textContent || '').trim())
})()`

async function pressKey(cdp, { key, code, vk, text, modifiers = 0 }) {
  const base = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers }
  await cdp.send('Input.dispatchKeyEvent', text ? { type: 'keyDown', ...base, text } : { type: 'keyDown', ...base })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
}

/** 逐字符键入一段可打印文本（xterm 从 keydown 产出 PTY 数据，预测只吃这条路） */
async function typeText(cdp, text) {
  for (const ch of text) {
    await pressKey(cdp, { key: ch, code: '', vk: 0, text: ch })
    await sleep(15)
  }
  await sleep(250)
}

async function pressEnter(cdp) {
  await pressKey(cdp, { key: 'Enter', code: 'Enter', vk: 13, text: '\r' })
  await sleep(300)
}

async function pressCtrlC(cdp) {
  await pressKey(cdp, { key: 'c', code: 'KeyC', vk: 67, modifiers: 2 })
  await sleep(200)
}

/** 点当前激活标签里的终端（多个 xterm 并存时取可视的那个），拿回焦点 */
async function focusActiveTerminal(cdp) {
  const rectExpr = `(() => {
    const els = [...document.querySelectorAll('.xterm-screen')]
    const el = els.find((e) => { const r = e.getBoundingClientRect(); return r.width > 100 && r.height > 100 })
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
  })()`
  let rect = await cdp.eval(rectExpr)
  for (let i = 0; !rect && i < 40; i++) {
    await sleep(250)
    rect = await cdp.eval(rectExpr)
  }
  assert.ok(rect, '拿不到可视终端区域（焦点点击无从下手）')
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 })
  await sleep(400)
}

async function launch() {
  const log = await fs.open(join('.workbuddy-ai/shots', 'command-history-ui.log'), 'a')
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
  return child
}

async function connectWithRetry(timeoutMs = 30000) {
  const start = Date.now()
  for (;;) {
    try {
      return await connect({ port: CDP_PORT })
    } catch {
      if (Date.now() - start > timeoutMs) throw new Error('CDP 连接超时')
      await sleep(500)
    }
  }
}

async function killTree(child) {
  if (!child || child.exitCode !== null) return
  spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 8000)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
  })
  await sleep(1000)
}

// ---------- 起隔离实例 ----------
await fs.rm(userData, { recursive: true, force: true })
await fs.mkdir('.workbuddy-ai/shots', { recursive: true })
let child = await launch()
let cdp = await connectWithRetry()

async function waitFor(label, expression, timeoutMs = 20000) {
  const start = Date.now()
  for (;;) {
    if ((await cdp.eval(expression)) === true) return
    if (Date.now() - start > timeoutMs) throw new Error(`等待超时：${label}`)
    await sleep(250)
  }
}

try {
  // ---------- 1. 真实键盘执行一条命令 → 记入全局历史 ----------
  await waitFor('bootstrap', `(${storeExpr} && ${storeExpr}.shells !== null)`, 30000)
  await cdp.bringToFront()
  await cdp.eval(`${storeExpr}.createLocalSession()`)
  await waitFor('本地终端已渲染', `!!document.querySelector('.xterm .xterm-helper-textarea')`)
  await focusActiveTerminal(cdp)
  check('终端已获得焦点', (await cdp.eval(`!!(document.activeElement && document.activeElement.closest('.xterm'))`)) === true)

  await typeText(cdp, 'echo dogi-history-e2e')
  await pressEnter(cdp)
  await waitFor(
    '回车后命令记入全局历史',
    `(${storeExpr} && (${storeExpr}.commandHistory || []).some((e) => e.cmd === 'echo dogi-history-e2e'))`
  )
  check('真实回车路径：命令已记入全局 store（含 IPC 上报）', true)

  // 管理界面的测试数据：再补两条（记录路径本身已在上面用真实键盘验过）
  await cdp.eval(`${storeExpr}.pushCommandHistory('git status')`)
  await cdp.eval(`${storeExpr}.pushCommandHistory('ls -la')`)
  await sleep(300)

  // ---------- 2. 跨标签共享：新标签的预测下拉里出现别处敲过的命令 ----------
  await cdp.eval(`${storeExpr}.createLocalSession()`)
  await sleep(800)
  await focusActiveTerminal(cdp)
  await typeText(cdp, 'echo dogi')
  const rows = await cdp.eval(DROPDOWN_ROWS_EXPR)
  check('第二个标签的预测下拉出现跨标签历史', rows.includes('echo dogi-history-e2e'))
  await pressCtrlC(cdp)

  // ---------- 3. 设置 → 终端：管理卡片 ----------
  await cdp.eval(`${storeExpr}.setSettingsOpen(true, 'terminal')`)
  await sleep(600)
  check('管理卡片已渲染（共 3 条）', (await cdp.eval(`(document.body.textContent || '').includes('共 3 条')`)) === true)

  // 搜索过滤
  await cdp.eval(`(() => {
    const el = [...document.querySelectorAll('input')].find((i) => i.placeholder === '搜索命令')
    if (!el) return false
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(el, 'git')
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  await sleep(400)
  // ⚠️ 断言范围限定在设置 Modal 内，且只取带 title 的行 span：
  // Modal 底部的版本号（v0.0.12）也是 font-mono，会被 querySelectorAll('span.font-mono') 混进来
  const modalRowsExpr = `(() => {
    const modal = document.querySelector('.ant-modal')
    if (!modal) return []
    return [...modal.querySelectorAll('span.font-mono[title]')].map((s) => (s.textContent || '').trim())
  })()`
  check('搜索 git 只剩 git status 一行', (await cdp.eval(`(() => {
    const rows = ${modalRowsExpr}
    return rows.length === 1 && rows[0] === 'git status'
  })()`)) === true)
  await cdp.eval(`(() => {
    const el = [...document.querySelectorAll('input')].find((i) => i.placeholder === '搜索命令')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(el, '')
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  await sleep(300)

  // 最新在前（此时 3 条都在：ls -la 最新、echo dogi-history-e2e 最旧）
  check('历史最新在前', (await cdp.eval(`(() => {
    const rows = ${modalRowsExpr}
    return rows.length === 3 && rows[0] === 'ls -la' && rows[2] === 'echo dogi-history-e2e'
  })()`)) === true)

  // 单条删除（行内 ×）
  await cdp.eval(`(() => {
    const btn = [...document.querySelectorAll('button[aria-label]')].find((b) => (b.getAttribute('aria-label') || '') === '删除 ls -la')
    if (btn) btn.click()
  })()`)
  await sleep(500)
  check('单条删除：store 里 ls -la 已移除', (await cdp.eval(`(${storeExpr} && !${storeExpr}.commandHistory.some((e) => e.cmd === 'ls -la'))`)) === true)

  // 清空（Popconfirm）
  await cdp.eval(`(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === '清空' && !b.disabled)
    if (btn) btn.click()
  })()`)
  await sleep(500)
  // ⚠️ antd 会给两个汉字按钮插空格（清空 → 清 空），必须按去空白后的 textContent 匹配；
  // 优先在 Popconfirm 弹层里找（ Portal 挂在 body 末尾），避免误点触发按钮本身
  const confirmClicked = await cdp.eval(`(() => {
    const candidates = [...document.querySelectorAll('button')].filter(
      (b) => (b.textContent || '').replace(/\\s+/g, '') === '清空'
    )
    const inPopover = candidates.filter((b) => b.closest('.ant-popover'))
    const btn = inPopover[0] || candidates[candidates.length - 1]
    if (!btn) return false
    btn.click()
    return true
  })()`)
  assert.ok(confirmClicked, 'FAIL: Popconfirm 里找不到确认按钮')
  await sleep(500)
  check('清空后 store 归零', (await cdp.eval(`(${storeExpr} && ${storeExpr}.commandHistory.length === 0)`)) === true)
  check('卡片显示空态文案', (await cdp.eval(`(document.body.textContent || '').includes('暂无命令历史')`)) === true)

  // ---------- 4. 再记录一条 → 重启 → 持久化读回 ----------
  await cdp.eval(`${storeExpr}.setSettingsOpen(false)`)
  await sleep(400)
  await focusActiveTerminal(cdp)
  await typeText(cdp, 'echo after-cleanup')
  await pressEnter(cdp)
  await waitFor('清理后新命令已记录', `(${storeExpr} && (${storeExpr}.commandHistory || []).some((e) => e.cmd === 'echo after-cleanup'))`)
  await sleep(800) // 给主进程落盘留点时间

  await killTree(child)
  child = await launch()
  cdp = await connectWithRetry()
  await waitFor('重启后 bootstrap', `(${storeExpr} && ${storeExpr}.shells !== null)`, 30000)
  await waitFor(
    '重启后历史从文件灌回',
    `(${storeExpr} && (${storeExpr}.commandHistory || []).some((e) => e.cmd === 'echo after-cleanup'))`,
    20000
  )
  const after = await cdp.eval(
    `(() => { const h = ${storeExpr}.commandHistory; return { first: h[0] && h[0].cmd, hasDeleted: h.some((e) => e.cmd === 'echo dogi-history-e2e' || e.cmd === 'ls -la') } })()`
  )
  check('重启后最新一条在首位', after.first === 'echo after-cleanup')
  check('重启后已删除的条目不再出现（删除同样落盘）', after.hasDeleted === false)

  console.log('\nALL PASS')
} finally {
  await killTree(child)
}
