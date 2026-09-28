/**
 * 技术验证：能否用官方 recorder（recorderMode:'api'，不开 Inspector 窗口）
 * 在我们自己控制的浏览器上录制，同时用 CDP screencast 抓帧嵌进面板。
 *
 * 这是「自动化」功能浏览器面板的核心可行性验证。
 * 跑法：node scripts/probe-playwright-recorder.mjs [headless|headed]
 */
import { chromium } from 'playwright'
import fs from 'node:fs'

const mode = process.argv[2] ?? 'headless'
const headless = mode !== 'headed'

const browser = await chromium.launch({ headless, channel: 'chrome' })
console.log('[probe] 启动完成 headless =', headless)

const context = await browser.newContext({ viewport: { width: 1000, height: 700 } })
const page = await context.newPage()

// ---- recorder 是否可用 ----
console.log('[probe] context._enableRecorder 类型 =', typeof context._enableRecorder)
console.log('[probe] context._disableRecorder 类型 =', typeof context._disableRecorder)

const events = []
await context._enableRecorder(
  {
    mode: 'recording',
    recorderMode: 'api',
    language: 'javascript',
    testIdAttributeName: 'data-testid',
    handleSIGINT: false,
    hideToolbar: true
  },
  {
    actionAdded: (_p, action, code) =>
      events.push({ kind: 'added', name: action?.action?.name ?? action?.name, code }),
    actionUpdated: (_p, action, code) =>
      events.push({ kind: 'updated', name: action?.action?.name ?? action?.name, code }),
    signalAdded: (_p, action, code) =>
      events.push({ kind: 'signal', name: action?.action?.name ?? action?.name, code })
  }
)
console.log('[probe] recorder 已启用（若弹出窗口说明 api 模式没生效）')

await page.goto(
  'data:text/html;charset=utf-8,' +
    encodeURIComponent(`
    <h1>录制验证</h1>
    <form>
      <input id="user" data-testid="username" placeholder="用户名">
      <input id="mail" type="email" placeholder="邮箱">
      <button id="go" data-testid="submit" type="button">提交</button>
    </form>
    <a href="#next" id="link">下一页</a>
  `)
)
await page.waitForTimeout(500)

// ---- 用 CDP 合成真实操作，模拟用户在 Dogi 面板里点击 ----
const client = await context.newCDPSession(page)

async function clickAt(selector) {
  const box = await page.locator(selector).boundingBox()
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  await client.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x,
    y,
    button: 'left',
    clickCount: 1
  })
  await client.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x,
    y,
    button: 'left',
    clickCount: 1
  })
  await page.waitForTimeout(400)
}

async function typeText(text) {
  for (const ch of text) {
    await client.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      text: ch,
      key: ch,
      windowsVirtualKeyCode: ch.toUpperCase().charCodeAt(0)
    })
    await client.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: ch,
      windowsVirtualKeyCode: ch.toUpperCase().charCodeAt(0)
    })
  }
  await page.waitForTimeout(400)
}

// ---- 同时开 screencast，确认录制与抓帧互不干扰 ----
let frames = 0
client.on('Page.screencastFrame', async (ev) => {
  frames++
  await client.send('Page.screencastFrameAck', { sessionId: ev.sessionId }).catch(() => {})
})
await client.send('Page.startScreencast', {
  format: 'jpeg',
  quality: 60,
  maxWidth: 1000,
  maxHeight: 700,
  everyNthFrame: 1
})

await clickAt('[data-testid="username"]')
await typeText('alice')
await clickAt('#mail')
await typeText('a@b.com')
await clickAt('[data-testid="submit"]')
await clickAt('#link')

await page.waitForTimeout(1200)

console.log('[probe] screencast 帧数 =', frames)
console.log('[probe] recorder 事件数 =', events.length)

// Git Bash 的 stdout 编码不可靠，把原始事件落成 UTF-8 JSON 供核对中文选择器
fs.mkdirSync('tmp', { recursive: true })
fs.writeFileSync('tmp/probe-recorder-result.json', JSON.stringify(events, null, 2), 'utf8')
console.log('[probe] 原始事件已写入 tmp/probe-recorder-result.json')
for (const [i, e] of events.entries()) {
  console.log(`  #${i + 1} [${e.kind}] ${e.name ?? '-'} => ${JSON.stringify(e.code)}`)
}

await context._disableRecorder().catch((e) => console.log('[probe] disableRecorder 报错:', e.message))
await browser.close()

const pass = events.length > 0 && events.some((e) => e.code)
console.log(pass ? '[probe] PASS recorder 可用且不弹窗口' : '[probe] FAIL recorder 没录到东西')
process.exit(pass ? 0 : 1)
