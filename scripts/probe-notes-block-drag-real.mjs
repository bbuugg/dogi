/**
 * 笔记块拖拽的**真实拖拽管线**验证（隔离 Electron 实例 + CDP）。
 *
 * 为什么要有这个探针：`probe-notes-block-drag.mjs` 是用 `new DragEvent(...)` 合成事件跑的 ——
 * 它能验证「drop 之后的处理逻辑」，但**验证不了「拖拽本身起不起得来」**。
 * 实际踩过：有一版改动在 `dragstart` 里清空并重设了 dataTransfer，合成探针全绿，
 * 但真实鼠标拖拽连拖拽影子都没了（Chromium 的拖拽状态机被影响）。
 *
 * 所以这里走真管线：
 *   1. `Input.setInterceptDrags(true)` + 真实 `Input.dispatchMouseEvent`（按下 + 移动）→
 *      收到 `Input.dragIntercepted` 就证明**真实拖拽确实起来了**，并拿到页面设好的拖拽数据；
 *   2. 再用 `Input.dispatchDragEvent` 把 dragEnter / dragOver / drop 喂回页面
 *      （拦截模式下必须由我们转发，否则页面收不到 drop）；
 *   3. 断言块真的移动了。
 *
 * 跑：node scripts/probe-notes-block-drag-real.mjs（项目根目录；需先 npm run build）
 */
import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect, sleep } from './lib/cdp.mjs'

const CDP_PORT = 9381
const base = join(tmpdir(), `dogi-block-drag-real-${Date.now()}`)
const userData = join(base, 'profile')
const noteDir = join(base, 'notes')
const noteFile = join(noteDir, 'drag.md')
const LOG = join(base, 'probe.log')
const PARAS = ['AAAA-first', 'BBBB-second', 'CCCC-third', 'DDDD-fourth', 'EEEE-fifth']

await fs.mkdir(noteDir, { recursive: true })
await fs.writeFile(noteFile, PARAS.join('\n\n') + '\n', 'utf8')
const logHandle = await fs.open(LOG, 'a')

function launch() {
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
    {
      stdio: ['ignore', logHandle.fd, logHandle.fd],
      detached: true,
      env: { ...process.env, DOGI_NOTES_OPEN_DIRS: noteDir }
    }
  )
  child.unref()
  return child
}

async function waitFor(cdp, expr, timeoutMs = 15000, label = expr) {
  const start = Date.now()
  for (;;) {
    if ((await cdp.eval(expr)) === true) return
    if (Date.now() - start > timeoutMs) throw new Error(`等待超时：${label}`)
    await sleep(200)
  }
}

const mouse = (cdp, type, x, y, buttons) =>
  cdp.send('Input.dispatchMouseEvent', {
    type,
    x,
    y,
    button: type === 'mouseMoved' ? (buttons ? 'left' : 'none') : 'left',
    buttons,
    clickCount: type === 'mouseMoved' ? 0 : 1
  })

const stop = async (child) => {
  if (!child) return
  try {
    process.kill(child.pid)
  } catch {
    /* 已退出 */
  }
  await sleep(1200)
}

let child = null
let cdp = null
let failed = false
try {
  child = launch()
  cdp = await connect({ port: CDP_PORT })
  await cdp.bringToFront()
  await cdp.reload()
  await waitFor(cdp, '!!(window.__store && window.__store.getState().shells !== null)', 30000, 'bootstrap')
  await cdp.eval(`(() => {
    const s = window.__store.getState()
    window.__store.setState({ ui: { ...s.ui, activeActivity: 'notes' } })
  })()`)
  await waitFor(cdp, "document.body.innerText.includes('打开文件夹')", 15000, '空态入口')
  await cdp.eval(`document.querySelector('[title="打开文件夹"]').click()`)
  await waitFor(cdp, "document.body.innerText.includes('drag.md')", 15000, '侧边栏出现 drag.md')
  await cdp.eval(`window.__store.getState().openNoteTab(${JSON.stringify(noteFile)}, 'drag.md')`)
  await waitFor(cdp, "!!document.querySelector('.notes-milkdown .ProseMirror')", 15000, 'Milkdown 挂载')
  await waitFor(cdp, '!!window.__notesView', 5000, 'window.__notesView 钩子')
  await sleep(800)
  console.log('  ok  笔记编辑器就绪')

  /* 收集被拦截的拖拽 */
  const drags = []
  cdp.on('Input.dragIntercepted', (params) => drags.push(params.data))
  await cdp.send('Input.setInterceptDrags', { enabled: true })

  /* 先真实 hover 第一段，让块手柄显示出来（走 pointermove，不是合成 PointerEvent） */
  const para = await cdp.eval(`(() => {
    const p = document.querySelector('.notes-milkdown .ProseMirror p')
    const r = p.getBoundingClientRect()
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
  })()`)
  await mouse(cdp, 'mouseMoved', para.x, para.y, 0)
  await sleep(500)

  const geom = await cdp.eval(`(() => {
    const pm = document.querySelector('.notes-milkdown .ProseMirror')
    const h = document.querySelector('.milkdown-block-handle')
    if (!h) return { fatal: '抓手没显示' }
    const hr = h.getBoundingClientRect()
    const ps = [...pm.querySelectorAll('p')].map((p) => {
      const r = p.getBoundingClientRect()
      return { top: r.top, bottom: r.bottom }
    })
    return {
      handle: { x: Math.round(hr.left + hr.width / 2), y: Math.round(hr.top + hr.height / 2) },
      /* 落点选第 4 段的上边界：这个位置在合成探针里是「会移动」的 */
      dropX: Math.round(hr.left + hr.width / 2),
      dropY: Math.round(ps[3].top + 2),
      paras: ps.map((p) => Math.round(p.top)),
      text: pm.textContent
    }
  })()`)
  if (geom.fatal) throw new Error(geom.fatal)
  console.log('  抓手位置：', JSON.stringify(geom.handle), ' 落点 y：', geom.dropY)
  console.log('  拖动前：', geom.text)

  /* ---- 真实鼠标拖拽：按下 → 多次移动 ---- */
  await mouse(cdp, 'mousePressed', geom.handle.x, geom.handle.y, 1)
  await sleep(120)
  const steps = 8
  for (let i = 1; i <= steps; i++) {
    const x = geom.handle.x + ((geom.dropX - geom.handle.x) * i) / steps
    const y = geom.handle.y + ((geom.dropY - geom.handle.y) * i) / steps
    await mouse(cdp, 'mouseMoved', Math.round(x), Math.round(y), 1)
    await sleep(60)
  }

  const dragStarted = drags.length > 0
  console.log(`\n=== 真实拖拽是否起来：${dragStarted ? '是' : '否'}（dragIntercepted ${drags.length} 次）===`)
  if (dragStarted) {
    const items = (drags[0].items || []).map((it) => it.mimeType)
    console.log('  页面设好的拖拽数据类型：', JSON.stringify(items))
  } else {
    console.log('  拖拽根本没起来 —— 拖拽影子不会有，页面也收不到任何 drag* 事件')
    failed = true
  }

  /* ---- 拦截模式下必须由我们把 drag 事件喂回页面 ---- */
  if (dragStarted) {
    const data = drags[0]
    for (const type of ['dragEnter', 'dragOver']) {
      await cdp.send('Input.dispatchDragEvent', {
        type,
        x: geom.dropX,
        y: geom.dropY,
        data,
        modifiers: 0
      })
      await sleep(60)
    }
    await cdp.send('Input.dispatchDragEvent', {
      type: 'drop',
      x: geom.dropX,
      y: geom.dropY,
      data,
      modifiers: 0
    })
    await sleep(200)
    await mouse(cdp, 'mouseReleased', geom.dropX, geom.dropY, 0)
    await sleep(300)

    const after = await cdp.eval(`document.querySelector('.notes-milkdown .ProseMirror').textContent`)
    console.log('  松手后：', after)
    const moved = after !== geom.text
    console.log(`\n=== 块是否移动：${moved ? '是' : '否'} ===`)
    if (!moved) failed = true
  }

  /* ---- 阶段 2：复现「旧方案」的后果，证明本探针确实能拦住这类回归 ----
     旧方案曾在 dragstart 里 clearData() 再 setData 自定义类型。合成事件探针全绿，
     但真实拖拽会连影子都没了。这里用运行时注入把那段行为还原出来再拖一次。 */
  console.log('\n=== 阶段 2：注入那段已被否掉的 dataTransfer 改写，看拖拽还起不起得来 ===')
  await cdp.send('Input.setInterceptDrags', { enabled: false })
  await cdp.reload()
  await waitFor(cdp, '!!(window.__store && window.__store.getState().shells !== null)', 30000, 'bootstrap(2)')
  await cdp.eval(`(() => {
    const s = window.__store.getState()
    window.__store.setState({ ui: { ...s.ui, activeActivity: 'notes' } })
  })()`)
  await cdp.eval(`window.__store.getState().openNoteTab(${JSON.stringify(noteFile)}, 'drag.md')`)
  await waitFor(cdp, "!!document.querySelector('.notes-milkdown .ProseMirror')", 15000, 'Milkdown(2)')
  await waitFor(cdp, '!!window.__notesView', 5000, '__notesView(2)')
  await sleep(600)
  await cdp.eval(`(() => {
    document.querySelector('.notes-milkdown').addEventListener('dragstart', (e) => {
      const t = e.target
      if (!t || typeof t.closest !== 'function' || !t.closest('.milkdown-block-handle')) return
      e.dataTransfer.clearData()
      try { e.dataTransfer.setData('application/x-dogi-block-drag', '1') } catch {}
    })
  })()`)

  const drags2 = []
  const off = cdp.on('Input.dragIntercepted', (params) => drags2.push(params.data))
  await cdp.send('Input.setInterceptDrags', { enabled: true })
  const para2 = await cdp.eval(`(() => {
    const p = document.querySelector('.notes-milkdown .ProseMirror p')
    const r = p.getBoundingClientRect()
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
  })()`)
  await mouse(cdp, 'mouseMoved', para2.x, para2.y, 0)
  await sleep(500)
  const h2 = await cdp.eval(`(() => {
    const h = document.querySelector('.milkdown-block-handle')
    if (!h) return null
    const r = h.getBoundingClientRect()
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
  })()`)
  if (!h2) throw new Error('阶段 2：抓手没显示')
  await mouse(cdp, 'mousePressed', h2.x, h2.y, 1)
  await sleep(120)
  for (let i = 1; i <= 8; i++) {
    await mouse(cdp, 'mouseMoved', h2.x, Math.round(h2.y + (60 * i) / 8), 1)
    await sleep(60)
  }
  off()
  await cdp.send('Input.setInterceptDrags', { enabled: false })
  const reproduced = drags2.length === 0
  console.log(`  旧方案下 dragIntercepted = ${drags2.length} 次 → ${reproduced ? '拖拽确实起不来（复现成功，证明本探针能拦住它）' : '拖拽仍然起得来（说明当时的失效另有原因）'}`)

  console.log(failed ? '\nFAILED' : '\nALL PASS')
} catch (err) {
  console.error('探针失败：', err)
  failed = true
} finally {
  await stop(child)
  try {
    cdp?.close()
  } catch {
    /* 已断开 */
  }
  await logHandle.close()
  await fs.rm(base, { recursive: true, force: true })
  if (failed) process.exitCode = 1
}
