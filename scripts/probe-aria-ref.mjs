/**
 * 探针：Playwright 1.63 的 AI aria 快照 + ref 定位是否可用（公开 API，非私有）。
 *
 * 要回答两个问题：
 *  1. `locator.ariaSnapshot({ mode: 'ai' })` 是否真的产出 `[ref=eN]`；
 *  2. 产出的 ref 能否用 `page.locator('aria-ref=eN')` 回解析并点击。
 *
 * 运行：node scripts/probe-aria-ref.mjs
 */
import { chromium } from 'playwright'

const HTML = `<!doctype html><meta charset="utf-8">
<h1>标题</h1>
<label>邮箱 <input data-testid="email" placeholder="输入邮箱"></label>
<button data-testid="submit">提交</button>
<a href="#x">更多</a>`

const browser = await chromium.launch({ channel: 'msedge', headless: true })
const page = await browser.newPage()
await page.setContent(HTML)

const snap = await page.locator('body').ariaSnapshot({ mode: 'ai' })
console.log('=== AI aria 快照 ===')
console.log(snap)

const refs = [...snap.matchAll(/\[ref=(e\d+)\]/g)].map((m) => m[1])
console.log('=== 提取到的 ref ===', refs.join(', ') || '(无)')

// 找到「提交」按钮的 ref
const submitLine = snap.split('\n').find((l) => l.includes('提交'))
const submitRef = submitLine?.match(/\[ref=(e\d+)\]/)?.[1]
console.log('提交按钮行 =', JSON.stringify(submitLine), '→ ref =', submitRef)

if (submitRef) {
  try {
    const loc = page.locator(`aria-ref=${submitRef}`)
    console.log('aria-ref 解析出的元素数 =', await loc.count())
    console.log('按钮文本 =', JSON.stringify(await loc.innerText()))
    // 点击并验证页面真的收到了（挂个标记）
    await page.evaluate(() => {
      document.querySelector('button')?.addEventListener('click', () => {
        window.__clicked = true
      })
    })
    await loc.click()
    console.log('点击后 window.__clicked =', await page.evaluate(() => window.__clicked))
    console.log('RESULT: aria-ref 可用 ✅')
  } catch (err) {
    console.log('aria-ref 解析失败 ❌:', err.message.split('\n')[0])
    console.log('RESULT: aria-ref 不可用')
  }
} else {
  console.log('RESULT: 快照里没有 ref')
}

await browser.close()
