/**
 * 终端命令预测（历史 / 常见命令补全）端到端验证。
 *
 * 防回归的是「预测下拉里命令缺空格」的坑：建议行是「已输入前缀 + 高亮剩余」两段文字，
 * ⚠️ 这两段必须留在同一个元素里 —— 行的 button 是 flex 容器，若拆成两个子 span，
 * 它们各自成为 flex 子项（块容器），边界空格会落在各自行盒边缘被 CSS 裁掉，
 * 显示成「gitstatus」。**结构断言测不出这个坑**（两种结构的 textContent 完全相同），
 * 所以这里量的是渲染宽度：range 联合包围盒 vs 同字体的「带空格 / 去空格」基准。
 *
 * 链路（隔离实例 + CDP 真键盘注入 —— 预测缓冲只吃 xterm.onData，也就是真实按键）：
 *   1. 新建本地终端 → 点一下终端给焦点 → 无输入时无下拉；
 *   2. 键入 "git" → 下拉出现，'git status' 行渲染宽度 ≈ 带空格基准（而不是粘连宽度）；
 *   3. 再敲一个空格（前缀以空格结尾的另一种边界）→ 同样带空格；
 *   4. →（右方向键）接受首个建议 → 下拉收起 → PTY 回显出现补全后的 'git log'（含空格）。
 *
 * 跑：node scripts/verify-terminal-prediction.mjs（项目根目录执行；需先 npm run build）
 * ⚠️ 键盘注入前必须 bringToFront + 点击终端：xterm 的 helper textarea 没焦点时按键不派发。
 */

import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { connect, sleep } from './lib/cdp.mjs'

const CDP_PORT = 9344
const OUT_DIR = '.workbuddy-ai/shots'
const userData = join(tmpdir(), 'dogi-prediction-cdp')

const check = (label, ok) => {
  assert.ok(ok, `FAIL: ${label}`)
  console.log(`  ok  ${label}`)
}

/** 下拉框头部文案：拿它定位预测下拉容器（容器里其余子元素即建议行 button） */
const HINT_FRAGMENT = '命令预测 ·'
const DROPDOWN_OPEN_EXPR = `[...document.querySelectorAll('div')].some((d) => d.childElementCount === 0 && (d.textContent || '').includes(${JSON.stringify(HINT_FRAGMENT)}))`

/** 量 'git status' 行的渲染宽度，并与同字体的带空格 / 去空格基准比对 */
const measureExpr = (rowText) => `(() => {
  const hint = [...document.querySelectorAll('div')].find((d) => d.childElementCount === 0 && (d.textContent || '').includes(${JSON.stringify(HINT_FRAGMENT)}))
  if (!hint || !hint.parentElement) return { error: 'no-dropdown' }
  const rows = [...hint.parentElement.querySelectorAll(':scope > button')]
  const row = rows.find((b) => (b.textContent || '').trim() === ${JSON.stringify(rowText)})
  if (!row) return { error: 'no-row', texts: rows.map((b) => b.textContent) }
  const range = document.createRange()
  range.selectNodeContents(row)
  const rendered = range.getBoundingClientRect().width
  const cs = getComputedStyle(row)
  const ref = document.createElement('span')
  ref.style.cssText = 'position:fixed;left:-9999px;top:0;visibility:hidden;white-space:nowrap'
  ref.style.fontFamily = cs.fontFamily
  ref.style.fontSize = cs.fontSize
  ref.style.fontWeight = cs.fontWeight
  ref.style.letterSpacing = cs.letterSpacing
  document.body.appendChild(ref)
  ref.textContent = ${JSON.stringify(rowText)}
  const wSpace = ref.getBoundingClientRect().width
  ref.textContent = ${JSON.stringify(rowText.replace(/\s+/g, ''))}
  const wGlued = ref.getBoundingClientRect().width
  ref.remove()
  return { rendered, wSpace, wGlued }
})()`

/** 键盘注入：keyDown(+text) / keyUp —— 与真实按键一致，xterm 从 keydown 产出 PTY 数据 */
async function pressKey(cdp, { key, code, vk, text }) {
  const base = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }
  await cdp.send(
    'Input.dispatchKeyEvent',
    text ? { type: 'keyDown', ...base, text } : { type: 'keyDown', ...base }
  )
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
}

/** 去掉 ANSI 转义序列（PSReadLine 会在字符间插光标 / 颜色序列，直接 includes 会漏） */
const stripAnsi = (s) =>
  s.replace(/\x1b\[[0-9;?]*[A-Za-z~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g, '')

// ---------- 起隔离实例 ----------
await fs.rm(userData, { recursive: true, force: true })
await fs.mkdir(OUT_DIR, { recursive: true })
const log = await fs.open(join(OUT_DIR, 'terminal-prediction.log'), 'a')
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

const cdp = await connect({ port: CDP_PORT })
let sessionId = null

async function waitFor(label, expression, timeoutMs = 15000) {
  const start = Date.now()
  for (;;) {
    if ((await cdp.eval(expression)) === true) return
    if (Date.now() - start > timeoutMs) throw new Error(`等待超时：${label}`)
    await sleep(250)
  }
}

try {
  // ---------- 0. bootstrap + 新建本地终端 + 焦点 ----------
  await waitFor(
    'bootstrap（shells 已加载）',
    `(window.__store ? window.__store.getState().shells !== null : false)`,
    30000
  )
  await cdp.bringToFront()
  await cdp.eval(`window.__store.getState().createLocalSession()`)
  await waitFor(
    '本地终端已渲染',
    `(() => { const s = window.__store.getState(); return s.sessions.length > 0 && !!document.querySelector('.xterm .xterm-helper-textarea') })()`,
    20000
  )
  sessionId = await cdp.eval(
    `window.__store.getState().sessions[window.__store.getState().sessions.length - 1].id`
  )
  check('本地终端会话已创建', typeof sessionId === 'string' && sessionId.length > 0)

  // 点一下终端给 xterm 焦点（键盘注入不派发最常见的原因就是没焦点）
  const rectExpr = `(() => {
    const el = document.querySelector('.xterm-screen') || document.querySelector('.xterm')
    if (!el) return null
    const r = el.getBoundingClientRect()
    if (r.width < 100 || r.height < 100) return null
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
  })()`
  let rect = await cdp.eval(rectExpr)
  for (let i = 0; !rect && i < 40; i++) {
    await sleep(250)
    rect = await cdp.eval(rectExpr)
  }
  if (!rect) throw new Error('终端区域尺寸异常（拿不到可点击坐标）')
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: rect.x,
    y: rect.y,
    button: 'left',
    clickCount: 1
  })
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: rect.x,
    y: rect.y,
    button: 'left',
    clickCount: 1
  })
  await sleep(400)
  check(
    '终端已获得焦点（helper textarea）',
    (await cdp.eval(`!!(document.activeElement && document.activeElement.closest('.xterm'))`)) ===
      true
  )

  // ---------- 1. 未输入时无下拉 ----------
  check('未输入时无预测下拉', (await cdp.eval(DROPDOWN_OPEN_EXPR)) === false)

  // ---------- 2. 键入 "git" → 'git status' 行必须带空格 ----------
  for (const [key, code, vk] of [
    ['g', 'KeyG', 71],
    ['i', 'KeyI', 73],
    ['t', 'KeyT', 84]
  ]) {
    await pressKey(cdp, { key, code, vk, text: key })
    await sleep(80)
  }
  await waitFor('预测下拉出现（已键入 git）', DROPDOWN_OPEN_EXPR, 8000)
  check('键入 git 后预测下拉出现', true)

  const m1 = await cdp.eval(measureExpr('git status'))
  if (m1.error) throw new Error(`量 'git status' 行失败：${JSON.stringify(m1)}`)
  console.log(
    `      rendered=${m1.rendered.toFixed(2)}  带空格基准=${m1.wSpace.toFixed(2)}  粘连基准=${m1.wGlued.toFixed(2)}`
  )
  check(
    "'git status' 行渲染带空格（不是 gitstatus）",
    Math.abs(m1.rendered - m1.wSpace) <= 1.5 && m1.rendered > m1.wGlued
  )

  await cdp.screenshot(join(OUT_DIR, 'terminal-prediction.png'))
  console.log(`  ok  截图已落盘 ${OUT_DIR}/terminal-prediction.png`)

  // ---------- 3. 前缀以空格结尾（"git "）：另一种边界，同样必须带空格 ----------
  await pressKey(cdp, { key: ' ', code: 'Space', vk: 32, text: ' ' })
  await sleep(300)
  check('输入空格后下拉仍在', (await cdp.eval(DROPDOWN_OPEN_EXPR)) === true)
  const m2 = await cdp.eval(measureExpr('git status'))
  if (m2.error) throw new Error(`量 'git status' 行失败（前缀带空格）：${JSON.stringify(m2)}`)
  console.log(
    `      rendered=${m2.rendered.toFixed(2)}  带空格基准=${m2.wSpace.toFixed(2)}  粘连基准=${m2.wGlued.toFixed(2)}`
  )
  check(
    "前缀带空格时 'git status' 行渲染仍带空格",
    Math.abs(m2.rendered - m2.wSpace) <= 1.5 && m2.rendered > m2.wGlued
  )

  // ---------- 4. → 接受首个建议：下拉收起，PTY 回显出现补全后的 'git log' ----------
  await pressKey(cdp, { key: 'ArrowRight', code: 'ArrowRight', vk: 39 })
  await waitFor('接受后下拉收起', `!(${DROPDOWN_OPEN_EXPR})`, 5000)
  check('按 → 接受后下拉收起', true)

  // 首个建议 = 'git log'（长度升序 + 稳定排序即 COMMON_COMMANDS 里先出现的同长度项）；
  // 前缀是 'git ' → 应只补写 'log'，行上呈现 'git log'
  let out = ''
  {
    const start = Date.now()
    for (;;) {
      out = stripAnsi((await cdp.eval(`window.api.terminal.recentOutput(${JSON.stringify(sessionId)})`)) ?? '')
      if (out.includes('git log') || Date.now() - start > 6000) break
      await sleep(300)
    }
    console.log(`      回显尾部：${JSON.stringify(out.slice(-80))}`)
  }
  check("PTY 回显含补全后的 'git log'", out.includes('git log'))
  check("回显中无粘连的 'gitlog'", !out.includes('gitlog'))

  console.log('\nALL PASS')
} catch (err) {
  console.error('\nFAIL:', err.message)
  try {
    await cdp.screenshot(join(OUT_DIR, 'terminal-prediction-fail.png'))
    console.error(`失败截图已落盘 ${OUT_DIR}/terminal-prediction-fail.png`)
  } catch {
    // 忽略
  }
  process.exitCode = 1
} finally {
  try {
    if (sessionId) {
      await cdp.eval(`window.__store.getState().closeSession(${JSON.stringify(sessionId)})`)
    }
  } catch {
    // 忽略
  }
  try {
    cdp.close()
  } catch {
    // 忽略
  }
  try {
    process.kill(child.pid)
  } catch {
    // 已退出
  }
  await log.close()
  process.exit(process.exitCode ?? 0)
}
