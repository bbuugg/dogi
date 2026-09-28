/**
 * 浏览器自动化功能的端到端验证（隔离实例 + CDP）。
 *
 * 覆盖：功能区注册 → 脚本新建/打开标签 → 启动浏览器 → screencast 帧到达渲染端
 *      → 合成输入转发 → 官方 recorder 产出代码 → 运行脚本。
 *
 * 启动实例（注意剥掉 WorkBuddy 注入的 ELECTRON_RUN_AS_NODE）：
 *   MSYS_NO_PATHCONV=1 env -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS \
 *     node_modules/electron/dist/electron.exe . --remote-debugging-port=9333 \
 *     --user-data-dir="C:/Users/<user>/AppData/Local/Temp/dogi-cdp-auto" \
 *     --no-sandbox --in-process-gpu --disable-gpu-sandbox
 *
 * 然后：node scripts/verify-automation.mjs
 */
import { connect, sleep, report } from './lib/cdp.mjs'

const cdp = await connect({ port: 9333 })
await cdp.bringToFront()
await sleep(1500)

const checks = []
const log = (...a) => console.log('[verify]', ...a)

/** 浏览器画面的 img：DOM 里可能有多个（历史遗留的 automation 标签），取可见的那个 */
const VISIBLE_IMG = `[...document.querySelectorAll('img')]
  .filter((el) => el.alt === '浏览器画面')
  .find((el) => { const r = el.getBoundingClientRect(); return r.width > 40 && r.height > 40 })`

// ---------------------------------------------------------------------------
// 0. 清理：关掉上一轮遗留的 automation 标签（否则 img 查找会命中隐藏的旧面板）
// ---------------------------------------------------------------------------
const cleaned = await cdp.eval(`(() => {
  const s = window.__store.getState()
  const stale = s.ui.panelTabs.filter((t) => t.type === 'automation')
  stale.forEach((t) => s.closePanelTab(t.id))
  return stale.length
})()`)
log('清理遗留 automation 标签:', cleaned)
await sleep(1000)

// ---------------------------------------------------------------------------
// 1. 接线：store 状态 / 动作 + preload 命名空间
// ---------------------------------------------------------------------------
const storeShape = await cdp.eval(`(() => {
  const s = window.__store.getState()
  return {
    hasScripts: Array.isArray(s.automationScripts),
    hasGroups: Array.isArray(s.automationGroups),
    hasCreate: typeof s.createAutomationScript === 'function',
    hasOpen: typeof s.openAutomationTab === 'function',
    hasSave: typeof s.saveAutomationScript === 'function',
    hasArrange: typeof s.arrangeAutomation === 'function'
  }
})()`)
checks.push(['store 有 automationScripts / automationGroups', storeShape.hasScripts && storeShape.hasGroups])
checks.push(['store 有脚本 CRUD 与重排动作', storeShape.hasCreate && storeShape.hasOpen && storeShape.hasSave && storeShape.hasArrange])

const apiKeys = await cdp.eval(`(() => {
  const b = window.api && window.api.browser
  return b ? Object.keys(b).sort() : null
})()`)
log('browser API:', apiKeys ? apiKeys.join(',') : '(缺失)')
const apiOk =
  Array.isArray(apiKeys) &&
  ['open', 'close', 'navigate', 'input', 'viewport', 'run', 'startRecord', 'stopRecord', 'onFrame', 'onRecord', 'onLog', 'onState'].every(
    (k) => apiKeys.includes(k)
  )
checks.push(['preload 暴露完整 browser 命名空间', apiOk])

// 主进程真的探测到了浏览器
const detected = await cdp.eval(`window.api.browser.detect()`)
log('探测到的浏览器:', JSON.stringify(detected))
checks.push(['主进程探测到至少一个可用浏览器', Array.isArray(detected) && detected.some((b) => b.available)])

// ---------------------------------------------------------------------------
// 2. 新建脚本 + 打开标签 + 切功能区
// ---------------------------------------------------------------------------
const scriptId = await cdp.eval(`(async () => {
  const s = window.__store.getState()
  const id = await s.createAutomationScript()
  window.__store.getState().openAutomationTab(id)
  window.__store.setState((st) => ({ ui: { ...st.ui, activeActivity: 'automation' } }))
  return id
})()`)
log('新建脚本 id =', scriptId)
await sleep(1500)

const tab = await cdp.eval(`(() => {
  const t = window.__store.getState().ui.panelTabs.find((x) => x.id === 'automation-${scriptId}')
  return t ? { type: t.type, title: t.title } : null
})()`)
checks.push(['标签已创建且类型为 automation', tab?.type === 'automation'])

// 侧边栏出现「自动化」标题
const sidebarOk = await cdp.eval(`(() => {
  const el = [...document.querySelectorAll('span')].find((n) => (n.textContent || '').startsWith('自动化 ('))
  return !!el
})()`)
checks.push(['侧边栏显示自动化脚本列表', sidebarOk])

// 脚本编辑器（Monaco）已挂载
const editorOk = await cdp.eval(`!!document.querySelector('.monaco-editor')`)
checks.push(['脚本编辑器（Monaco）已渲染', editorOk])

// 工具栏布局：地址栏不许撑爆它（曾踩过 —— 给 antd Input 写 Tailwind `w-56` 不生效，
// 它被 antd 的 `width: 100%` 顶到 951px，再叠 `shrink-0` 就把「保存 / 录制 / 运行」
// 整组挤出容器，按钮直接看不见。见 AGENTS.md 6.5）
const toolbarFit = await cdp.eval(`(() => {
  const norm = (s) => (s || '').replace(/\\s/g, '')
  const rec = [...document.querySelectorAll('button')].find((b) => norm(b.textContent) === '录制')
  if (!rec) return null
  const toolbar = rec.closest('.flex.shrink-0.items-center.gap-2')
  if (!toolbar) return null
  const tr = toolbar.getBoundingClientRect()
  const kids = [...toolbar.children]
  return {
    overflow: toolbar.scrollWidth - toolbar.clientWidth,
    allInside: kids.every((el) => el.getBoundingClientRect().right <= tr.right + 0.5),
    startUrlW: Math.round(kids[1]?.getBoundingClientRect().width ?? -1)
  }
})()`)
log('工具栏布局:', JSON.stringify(toolbarFit))
checks.push(['脚本页工具栏无横向溢出', Boolean(toolbarFit && toolbarFit.overflow <= 0)])
checks.push([
  '「保存/录制/运行」都在工具栏内（地址栏没把它挤出去）',
  Boolean(toolbarFit && toolbarFit.allInside)
])
checks.push([
  '起始地址栏宽度是 w-56 的 224px（Tailwind 类真的生效）',
  Boolean(toolbarFit && Math.abs(toolbarFit.startUrlW - 224) <= 2)
])

// ---------------------------------------------------------------------------
// 2.5 主体两栏：浏览器 : 代码 = 3:1，且拖拽方向正确
// ---------------------------------------------------------------------------
// 拖拽条在浏览器面板**左侧**，所以往左拖才是把面板拉宽。
// `ResizeHandle` 的 `invert` 漏传时方向整个反着（用户报过「方向反了」）。
/**
 * 定位主体分隔条。**不能全局 querySelector** —— `ResizeHandle` 还用在侧边栏宽度
 * （app/App.tsx）和 Agent 页，按 title 全局取会命中别的那个，测出来是旁人的比例。
 */
const SPLIT_HANDLE = `(() => {
  const norm = (s) => (s || '').replace(/\\s/g, '')
  const rec = [...document.querySelectorAll('button')].find((b) => norm(b.textContent) === '录制')
  const page = rec && rec.closest('.flex.h-full.flex-col')
  return page ? page.querySelector('[title="拖动调整宽度"]') : null
})()`

const SPLIT_PROBE = `(() => {
  const handle = ${SPLIT_HANDLE}
  if (!handle) return null
  const pane = handle.nextElementSibling
  const body = handle.parentElement
  if (!pane || !body) return null
  const bw = body.getBoundingClientRect().width
  const pw = pane.getBoundingClientRect().width
  return { body: Math.round(bw), pane: Math.round(pw), editor: Math.round(bw - pw) }
})()`

/** 在分隔条上拖 dx 像素（dx < 0 = 往左拖） */
async function dragSplit(dx) {
  const ok = await cdp.eval(`(() => {
    const handle = ${SPLIT_HANDLE}
    if (!handle) return false
    const r = handle.getBoundingClientRect()
    const x = r.left + r.width / 2
    const y = r.top + r.height / 2
    handle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: x, clientY: y }))
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: x + ${dx}, clientY: y }))
    window.dispatchEvent(new PointerEvent('pointerup', { clientX: x + ${dx}, clientY: y }))
    return true
  })()`)
  await sleep(500)
  return ok
}

const split0 = await cdp.eval(SPLIT_PROBE)
log('两栏宽度:', JSON.stringify(split0))
const splitRatio = split0 && split0.editor > 0 ? split0.pane / split0.editor : 0
checks.push(['浏览器 : 代码 = 3:1（默认比例）', Math.abs(splitRatio - 3) <= 0.15])

await dragSplit(80)
const split1 = await cdp.eval(SPLIT_PROBE)
log('往右拖 80px 后:', JSON.stringify(split1))
checks.push([
  '分隔条往右拖 = 浏览器面板变窄（invert 生效，方向没反）',
  Boolean(split0 && split1 && split1.pane < split0.pane - 40)
])

await dragSplit(-80)
const split2 = await cdp.eval(SPLIT_PROBE)
log('往左拖 80px 后:', JSON.stringify(split2))
checks.push([
  '分隔条往左拖 = 浏览器面板变宽',
  Boolean(split1 && split2 && split2.pane > split1.pane + 40)
])

// ---------------------------------------------------------------------------
// 3. 启动浏览器
// ---------------------------------------------------------------------------
const clicked = await cdp.eval(`(() => {
  const norm = (s) => (s || '').replace(/\\s/g, '')
  const btn = [...document.querySelectorAll('button')].find((b) => norm(b.textContent).includes('打开浏览器'))
  if (btn) btn.click()
  return !!btn
})()`)
checks.push(['浏览器面板显示「打开浏览器」按钮', clicked])

/** 轮询直到拿到一帧 screencast 画面 */
let frameSrc = null
let browserState = null
for (let i = 0; i < 60; i++) {
  await sleep(500)
  const snap = await cdp.eval(`(() => {
    const img = ${VISIBLE_IMG}
    return { src: img ? img.src.slice(0, 24) : null }
  })()`)
  frameSrc = snap.src
  if (frameSrc && frameSrc.startsWith('data:image/jpeg')) break
}
checks.push(['screencast 帧到达渲染端（img.src 是 data:image/jpeg）', Boolean(frameSrc && frameSrc.startsWith('data:image/jpeg'))])
log('首帧 src 前缀 =', frameSrc)

browserState = await cdp.eval(`window.api.browser.state('automation-${scriptId}')`)
log('会话状态:', JSON.stringify(browserState))
checks.push(['浏览器会话已启动且拿到了浏览器', Boolean(browserState && browserState.channel)])
// 视口来自预设（PC = 1280×800），**不是**面板尺寸 —— 面板宽度只决定画面缩放比例
checks.push([
  '默认视口是 PC 预设 1280×800（不跟随面板宽度）',
  Boolean(
    browserState &&
      browserState.viewportMode === 'desktop' &&
      browserState.viewport.width === 1280 &&
      browserState.viewport.height === 800
  )
])

// ---------------------------------------------------------------------------
// 3.5 视口切换：PC ⇄ 手机
// ---------------------------------------------------------------------------
/** 帧的原始像素 —— 切视口会按新预设重开 screencast，帧尺寸随之变化 */
const FRAME_NATURAL = `(() => {
  const img = ${VISIBLE_IMG}
  return img ? { w: img.naturalWidth, h: img.naturalHeight } : null
})()`

/**
 * 点视口切换按钮。**限定在画面所属的那个面板内** ——
 * Agent 页的内嵌浏览器用的是同一个组件、同样的 aria-label，
 * 全局 querySelector 可能点到另一个标签里的那份。
 */
async function clickViewport(label) {
  const ok = await cdp.eval(`(() => {
    const img = ${VISIBLE_IMG}
    const pane = img && img.closest('.flex.min-h-0.flex-col')
    const btn = pane && pane.querySelector('button[aria-label=${JSON.stringify(label)}]')
    if (!btn) return false
    btn.click()
    return true
  })()`)
  log(`点击视口按钮「${label}」:`, ok)
  return ok
}

const desktopFrame = await cdp.eval(FRAME_NATURAL)
log('PC 帧原始像素:', JSON.stringify(desktopFrame))

await clickViewport('手机视口')
let mobileState = null
let mobileFrame = desktopFrame
for (let i = 0; i < 20; i++) {
  await sleep(500)
  mobileState = await cdp.eval(`window.api.browser.state('automation-${scriptId}')`)
  mobileFrame = await cdp.eval(FRAME_NATURAL)
  if (mobileState?.viewportMode === 'mobile' && mobileFrame?.w < (desktopFrame?.w ?? 9999) - 100) break
}
log('手机视口:', JSON.stringify(mobileState?.viewport), '帧:', JSON.stringify(mobileFrame))
checks.push([
  '切到手机视口后会话视口是 390×844',
  Boolean(
    mobileState &&
      mobileState.viewportMode === 'mobile' &&
      mobileState.viewport.width === 390 &&
      mobileState.viewport.height === 844
  )
])
// 帧恒等于视口的 CSS 尺寸（与 deviceScaleFactor 无关，实测见 tmp/probe-dsf.mjs）——
// 所以这两个尺寸也就是「screencast 已按新预设重开」的直接证据
checks.push([
  'PC 帧 = PC 视口尺寸 1280×800',
  Boolean(desktopFrame && desktopFrame.w === 1280 && desktopFrame.h === 800)
])
checks.push([
  '手机帧 = 手机视口尺寸 390×844',
  Boolean(mobileFrame && mobileFrame.w === 390 && mobileFrame.h === 844)
])

await clickViewport('PC 视口')
let backState = null
for (let i = 0; i < 20; i++) {
  await sleep(500)
  backState = await cdp.eval(`window.api.browser.state('automation-${scriptId}')`)
  if (backState?.viewportMode === 'desktop' && backState.viewport.width === 1280) break
}
checks.push([
  '能切回 PC 视口 1280×800',
  Boolean(backState && backState.viewportMode === 'desktop' && backState.viewport.width === 1280)
])

// ---------------------------------------------------------------------------
// 3.6 点击坐标精度：点画面上的某点，页面收到的必须是同一个点
// ---------------------------------------------------------------------------
/**
 * 视口固定成预设后，面板宽高比（731×560 ≈ 1.30）≠ 视口宽高比（1280×800 = 1.6），
 * `object-contain` 会上下留黑边 —— **元素 rect ≠ 画面 rect**。拿元素 rect 映射坐标
 * 会整体偏移：画面底部实测偏 55px（点哪打到哪上面 55px 的地方），中心不偏。
 * 所以坐标一律按「等比缩进后的画面矩形」算（见 browser-input 的 containedRect）。
 */
const ACC_PAGE = `<body style="margin:0"><div style="position:absolute;inset:0"></div><script>
window.__hit = 'none'
document.addEventListener('click', (e) => {
  window.__hit = Math.round(e.clientX) + ',' + Math.round(e.clientY)
}, true)
</script></body>`

await cdp.eval(`window.api.browser.navigate('automation-${scriptId}', 'data:text/html;charset=utf-8,' + encodeURIComponent(${JSON.stringify(ACC_PAGE)}))`)
await sleep(1500)

/** 页面视口坐标 → 屏幕坐标（按 object-contain 的画面矩形，不是元素矩形） */
const PAGE_TO_SCREEN = `((px, py) => {
  const img = ${VISIBLE_IMG}
  if (!img) return null
  const r = img.getBoundingClientRect()
  const nw = img.naturalWidth || 1280
  const nh = img.naturalHeight || 800
  const scale = Math.min(r.width / nw, r.height / nh)
  const w = nw * scale
  const h = nh * scale
  const left = r.left + (r.width - w) / 2
  const top = r.top + (r.height - h) / 2
  return { x: left + (px / nw) * w, y: top + (py / nh) * h, rect: { left, top, w, h } }
})`

const accGeom = await cdp.eval(`(() => {
  const img = ${VISIBLE_IMG}
  if (!img) return null
  const r = img.getBoundingClientRect()
  const p = ${PAGE_TO_SCREEN}(0, 0)
  return {
    el: { w: Math.round(r.width), h: Math.round(r.height) },
    frame: { w: Math.round(p.rect.w), h: Math.round(p.rect.h), top: Math.round(p.rect.top) }
  }
})()`)
log('元素矩形 / 画面矩形:', JSON.stringify(accGeom))
checks.push([
  '画面矩形比元素矩形矮 40px 以上（确实存在黑边，才必须按画面 rect 映射）',
  Boolean(accGeom && accGeom.el.h - accGeom.frame.h > 40)
])

/** 在浏览器画面上按「页面视口坐标」点一下 */
async function clickPagePoint(px, py) {
  const hit = await cdp.eval(`(() => {
    const p = ${PAGE_TO_SCREEN}(${px}, ${py})
    if (!p) return { ok: false, why: 'no-img' }
    const target = document.elementFromPoint(p.x, p.y)
    if (!target) return { ok: false, why: 'no-target' }
    const opts = { bubbles: true, cancelable: true, clientX: p.x, clientY: p.y, button: 0, detail: 1 }
    target.dispatchEvent(new MouseEvent('mousedown', opts))
    target.dispatchEvent(new MouseEvent('mouseup', opts))
    target.dispatchEvent(new MouseEvent('click', opts))
    return { ok: true, sx: Math.round(p.x), sy: Math.round(p.y) }
  })()`)
  await sleep(700)
  return hit
}

/** 从页面里读回 window.__hit（走 browser:run 的 log 通道，'@@' 前缀标记） */
async function readHit() {
  await cdp.eval(`(() => {
    if (typeof window.__hitOff === 'function') { try { window.__hitOff() } catch {} }
    window.__hitLog = []
    window.__hitOff = window.api.browser.onLog((l) => window.__hitLog.push(l.message))
  })()`)
  await cdp.eval(`window.api.browser.run('automation-${scriptId}', "log('@@' + String(await page.evaluate(() => window.__hit)))")`)
  await sleep(900)
  const msgs = await cdp.eval(`window.__hitLog.filter((m) => m.startsWith('@@')).map((m) => m.slice(2))`)
  return msgs[msgs.length - 1] ?? null
}

for (const t of [
  { px: 640, py: 700, name: '画面底部' },
  { px: 640, py: 100, name: '画面顶部' },
  { px: 200, py: 400, name: '画面中部偏左' }
]) {
  await clickPagePoint(t.px, t.py)
  const got = await readHit()
  log(`点页面 (${t.px},${t.py}) → 页面收到 ${got}`)
  const [gx, gy] = String(got ?? '').split(',').map(Number)
  checks.push([
    `点画面 (${t.px},${t.py}) 页面收到的坐标偏差 ≤ 8px（${t.name}）`,
    Number.isFinite(gx) &&
      Number.isFinite(gy) &&
      Math.abs(gx - t.px) <= 8 &&
      Math.abs(gy - t.py) <= 8
  ])
}

// ---------------------------------------------------------------------------
// 4. 导航（IPC → CDP）
// ---------------------------------------------------------------------------
await cdp.eval(`window.api.browser.navigate('automation-${scriptId}', 'data:text/html;charset=utf-8,' + encodeURIComponent('<h1>Dogi 自动化</h1><input id="u" data-testid="user" placeholder="用户名"><button id="b" data-testid="go">提交</button>'))`)
await sleep(1500)

/**
 * 点击工具栏上文案精确匹配的按钮 —— 走真实 UI。
 * 必须走按钮而不是直接调 IPC：录制/停止里的「落盘」等副作用挂在按钮的 onClick 上。
 */
async function clickButton(label) {
  const ok = await cdp.eval(`(() => {
    const norm = (s) => (s || '').replace(/\\s/g, '')
    const btn = [...document.querySelectorAll('button')].find((b) => norm(b.textContent) === ${JSON.stringify(label)})
    if (!btn) return false
    btn.click()
    return true
  })()`)
  log(`点击按钮「${label}」:`, ok)
  return ok
}

/** 轮询直到出现文案匹配的按钮（等异步状态生效） */
async function waitForButton(label, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const ok = await cdp.eval(`(() => {
      const norm = (s) => (s || '').replace(/\\s/g, '')
      return [...document.querySelectorAll('button')].some((b) => norm(b.textContent) === ${JSON.stringify(label)})
    })()`)
    if (ok) return true
    await sleep(250)
  }
  return false
}

/**
 * 在浏览器画面内按比例坐标 (fx, fy) 派发一次真实鼠标点击。
 *
 * 事件挂在 pane div 上（React 合成事件委托到根容器，bubbles 能冒泡上去），
 * 坐标由 img 的 rect 换算 —— 与 BrowserPane 内部 toPageCoords 用的是同一个 rect。
 * rect 每次现取，避免面板尺寸变化后坐标过期。
 */
async function panelClick(fx, fy) {
  const hit = await cdp.eval(`(() => {
    const img = ${VISIBLE_IMG}
    if (!img) return { ok: false, why: 'no-img' }
    const r = img.getBoundingClientRect()
    if (!r.width || !r.height) return { ok: false, why: 'zero-rect' }
    const x = r.left + r.width * ${fx}
    const y = r.top + r.height * ${fy}
    const target = document.elementFromPoint(x, y)
    if (!target) return { ok: false, why: 'no-target' }
    const opts = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, detail: 1 }
    target.dispatchEvent(new MouseEvent('mousedown', opts))
    target.dispatchEvent(new MouseEvent('mouseup', opts))
    target.dispatchEvent(new MouseEvent('click', opts))
    return { ok: true, x, y, tag: target.tagName }
  })()`)
  log('panelClick', fx, fy, '->', JSON.stringify(hit))
  await sleep(800)
}

// ---------------------------------------------------------------------------
// 5. 录制：点「录制」→ 面板上合成点击 → 点「停止录制」（停止时才落盘）
// ---------------------------------------------------------------------------
// 页面换成铺满视口的按钮：比例坐标点击必定命中。先于开录导航，免得把 goto 记进脚本
await cdp.eval(`window.api.browser.navigate('automation-${scriptId}', 'data:text/html;charset=utf-8,' + encodeURIComponent('<body style="margin:0"><button id="big" data-testid="big-btn" style="position:absolute;inset:0;width:100%;height:100%;font-size:40px">CLICK ME</button></body>'))`)
await sleep(1500)

// 收集主进程推来的录制事件 —— 不依赖落盘时机。
// 渲染进程跨运行复用：先注销上一轮挂的订阅，否则旧闭包会往同一个 __rec 里重复 push
await cdp.eval(`(() => {
  if (typeof window.__recOff === 'function') { try { window.__recOff() } catch {} }
  window.__rec = []
  window.__recOff = window.api.browser.onRecord((e) => window.__rec.push({ kind: e.kind, code: e.code, action: e.action }))
  return true
})()`)

checks.push(['点击「录制」按钮成功', await clickButton('录制')])
checks.push(['录制状态生效（按钮变为「停止录制」）', await waitForButton('停止录制')])
await sleep(500)

await panelClick(0.5, 0.5)
await sleep(1500)

const recEvents = await cdp.eval(`window.__rec`)
log('录制事件:', JSON.stringify(recEvents))
checks.push(['官方 recorder 产出了录制事件', Array.isArray(recEvents) && recEvents.length > 0])
const recCode = (recEvents ?? []).map((e) => e.code).join('\n')
checks.push(
  ['录制代码是官方级选择器（getByTestId / getByRole）', /getByTestId|getByRole/.test(recCode)]
)

// 「停止录制」的 onClick 里会 stopRecord + 落盘
checks.push(['点击「停止录制」按钮成功', await clickButton('停止录制')])
await sleep(1500)

// 录制期间刻意不落盘（每个动作都写一次盘没必要），停止录制时才存
const savedCode = await cdp.eval(`(() => {
  const sc = window.__store.getState().automationScripts.find((x) => x.id === '${scriptId}')
  return sc ? sc.code : null
})()`)
log('停止录制后落盘的脚本 =', JSON.stringify(savedCode))
checks.push(['停止录制后脚本已落盘', Boolean(savedCode && savedCode.trim().length > 0)])
checks.push(['落盘内容含录制出的操作', /getByTestId|getByRole/.test(savedCode ?? '')])

// ---------------------------------------------------------------------------
// 6. 运行脚本
// ---------------------------------------------------------------------------
const runCode = `  await page.goto('data:text/html;charset=utf-8,' + encodeURIComponent('<h1 id=t>RUN OK</h1>'));\n  await page.getByText('RUN OK').waitFor();`
const runResult = await cdp.eval(`window.api.browser.run('automation-${scriptId}', ${JSON.stringify(runCode)}, 'desktop')`)
log('运行结果:', JSON.stringify(runResult))
checks.push(['脚本运行成功（逐行模式识别 + 执行）', Boolean(runResult && runResult.ok)])
checks.push(['运行步骤数被正确统计', Boolean(runResult && runResult.steps >= 2)])

// ---------------------------------------------------------------------------
// 7. 关闭会话（关标签 → 浏览器进程释放）
// ---------------------------------------------------------------------------
await cdp.eval(`window.api.browser.close('automation-${scriptId}')`)
await sleep(1200)
const afterClose = await cdp.eval(`window.api.browser.state('automation-${scriptId}')`)
checks.push(['关闭会话后状态为空', afterClose === null])

// ---------------------------------------------------------------------------
// 截图留档
// ---------------------------------------------------------------------------
await cdp.eval(`window.__store.getState().openAutomationTab('${scriptId}')`)
await sleep(1200)
const shot = await cdp.screenshot('tmp/automation-panel.png')
log('截图:', shot)

cdp.close()
process.exit(report(checks) === 0 ? 0 : 1)
