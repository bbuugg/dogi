/**
 * 技术验证：Playwright 的 CDP screencast 能否把浏览器画面抓成帧流，
 * 以及 Input.dispatch* 能否把合成输入送回页面。
 *
 * 结论会决定「自动化」功能的浏览器面板怎么做（见 AGENTS.md 待补条目）。
 *
 * 跑法：node scripts/probe-playwright-screencast.mjs [chrome|msedge|bundled]
 */
import { chromium } from 'playwright'

const channelArg = process.argv[2] ?? 'chrome'
const launchOpts =
  channelArg === 'bundled' ? { headless: true } : { headless: true, channel: channelArg }

console.log('[probe] launch options =', JSON.stringify(launchOpts))

let browser
try {
  browser = await chromium.launch(launchOpts)
} catch (err) {
  console.error('[probe] 启动失败：', err.message.split('\n').slice(0, 3).join(' | '))
  process.exit(1)
}
console.log('[probe] 浏览器已启动：', browser.version())

const context = await browser.newContext({ viewport: { width: 1000, height: 700 } })
const page = await context.newPage()
await page.goto('data:text/html,<h1 style="font:700 48px sans-serif">screencast probe</h1><button id=b>click me</button>')

// ---- 1. screencast 抓帧 ----
const client = await context.newCDPSession(page)
let frames = 0
let firstFrameBytes = 0
let firstMeta = null
client.on('Page.screencastFrame', async (ev) => {
  frames++
  if (frames === 1) {
    firstFrameBytes = Buffer.from(ev.data, 'base64').length
    firstMeta = ev.metadata
  }
  // 必须 ack，否则 Chromium 不再推后续帧
  await client.send('Page.screencastFrameAck', { sessionId: ev.sessionId }).catch(() => {})
})

await client.send('Page.startScreencast', {
  format: 'jpeg',
  quality: 60,
  maxWidth: 1000,
  maxHeight: 700,
  everyNthFrame: 1
})

// 静止页面不会有新帧，主动改一下 DOM 逼出几帧
await new Promise((r) => setTimeout(r, 500))
await page.evaluate(() => {
  document.body.style.background = '#ffeedd'
})
await new Promise((r) => setTimeout(r, 1500))

console.log('[probe] screencast 帧数 =', frames)
console.log('[probe] 首帧 =', firstFrameBytes, 'bytes, metadata =', JSON.stringify(firstMeta))

// ---- 2. 输入转发：合成点击能否真的触发页面事件 ----
await page.evaluate(() => {
  window.__clicks = 0
  document.getElementById('b').addEventListener('click', () => {
    window.__clicks++
  })
})
const box = await page.locator('#b').boundingBox()
const x = box.x + box.width / 2
const y = box.y + box.height / 2
await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
await new Promise((r) => setTimeout(r, 300))
const clicks = await page.evaluate(() => window.__clicks)
console.log('[probe] CDP 合成点击后 window.__clicks =', clicks)

// ---- 3. 键盘转发 ----
await page.evaluate(() => {
  window.__keys = []
  window.addEventListener('keydown', (e) => window.__keys.push(e.key))
})
await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', text: 'a', windowsVirtualKeyCode: 65 })
await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', windowsVirtualKeyCode: 65 })
await new Promise((r) => setTimeout(r, 200))
const keys = await page.evaluate(() => window.__keys)
console.log('[probe] CDP 合成按键后 window.__keys =', JSON.stringify(keys))

await browser.close()

const pass = frames > 0 && firstFrameBytes > 1000 && clicks === 1 && keys.includes('a')
console.log(pass ? '[probe] PASS 三条链路全通' : '[probe] FAIL 有链路没通')
process.exit(pass ? 0 : 1)
