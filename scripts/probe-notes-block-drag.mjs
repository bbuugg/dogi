/**
 * 笔记正文「块拖拽手柄」失效定位探针（隔离 Electron 实例 + CDP，见 AGENTS.md 5.1）。
 *
 * 症状：悬停段落出现左侧抓手，能拖动，松手后编辑器**零变化**。
 * 事件链已验证走通（mousedown 选中整块 / dragstart / 22x dragover / drop 到达），
 * 所以问题落在 `handleDrop` 内部的**静默 no-op** 分支。本探针把那一刻的内部状态打出来：
 *
 * 1. `view.dragging`（Milkdown 在手柄 dragstart 里设的）到底有没有被设上；
 * 2. 选中区（NodeSelection.from/to）—— `isDraggingToItself` 拿它判「拖回自己」；
 * 3. **复刻** `prosemirror-drop-indicator` 的 `getTargetsByView` + 距离排序 + 取前 8 条，
 *    看被选中的落点是不是落在被拖块自己的范围内；
 * 4. `view.posAtCoords` 在落点处解析出的位置；
 * 5. drop 期间 dispatch 了多少事务、有没有 `uiEvent: "drop"`；
 * 6. 扫多个落点 y，看有没有哪一个能成功 —— 区分「几何/坐标算错」与「机制本身不通」。
 *
 * 断言口径：只有「拖回自己原位」（脚本自己算出的 isDraggingToItself 为 true）才允许不移动；
 * 其余落点必须都成功，否则 exitCode = 1（可当回归门用）。
 *
 * 依赖渲染端的 `window.__notesView` 钩子（见 features/notes/MilkdownEditor.tsx）。
 * 跑：node scripts/probe-notes-block-drag.mjs（项目根目录；需先 npm run build）
 */
import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect, sleep } from './lib/cdp.mjs'

const CDP_PORT = 9379
const base = join(tmpdir(), `dogi-block-drag-${Date.now()}`)
const userData = join(base, 'profile')
const noteDir = join(base, 'notes')
const noteFile = join(noteDir, 'drag.md')
const LOG = join(base, 'probe.log')
const SHOT = (n) => join(base, n)

/* 5 个可区分的段落：纯文本行，Milkdown 按段落原样渲染 */
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
    if (Date.now() - start > timeoutMs) {
      /* 超时就把现场打出来：不然只有一个「等待超时」，定位全靠猜 */
      const diag = await cdp
        .eval(`(() => ({
          hasStore: !!window.__store,
          hasPm: !!document.querySelector('.notes-milkdown .ProseMirror'),
          hasWrapper: !!document.querySelector('.notes-milkdown'),
          hasView: !!window.__notesView,
          tabs: (window.__store?.getState().ui.panelTabs ?? []).map((t) => t.type + ':' + (t.noteFilePath ?? t.type)),
          text: document.body.innerText.slice(0, 300)
        }))()`)
        .catch((e) => ({ evalError: String(e) }))
      throw new Error(`等待超时：${label}\n现场：${JSON.stringify(diag, null, 2)}`)
    }
    await sleep(200)
  }
}

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
  await waitFor(cdp, "document.body.innerText.includes('打开文件夹')", 15000, '空态的「打开文件夹」入口')
  /* DOGI_NOTES_OPEN_DIRS 旁路是替换原生目录选择框的，所以必须点一下这个按钮 */
  await cdp.eval(`(() => {
    const el = document.querySelector('[title="打开文件夹"]')
    if (!el) throw new Error('找不到 [title=打开文件夹]')
    el.click()
  })()`)
  await waitFor(cdp, "document.body.innerText.includes('drag.md')", 15000, '侧边栏出现 drag.md')
  /* 树上点文件开标签；点不到（合成 click 与 React 的事件委托对不齐）就直接走 store 动作 */
  await cdp.eval(`(() => {
    const el = [...document.querySelectorAll('.notes-tree span')].find((e) => e.textContent === 'drag.md')
    if (el) el.click()
    window.__store.getState().openNoteTab(${JSON.stringify(noteFile)}, 'drag.md')
  })()`)
  await waitFor(cdp, "!!document.querySelector('.notes-milkdown .ProseMirror')", 15000, 'Milkdown 挂载')
  await waitFor(cdp, '!!window.__notesView', 5000, 'window.__notesView 钩子')
  await sleep(600)
  console.log('  ok  笔记编辑器就绪')
  await cdp.screenshot(SHOT('notes-1-before.png'))

  /* ================= 页面内：合成拖拽 + 全量内部状态 ================= */
  const report = await cdp.eval(`(async () => {
    const pm = document.querySelector('.notes-milkdown .ProseMirror')
    const view = window.__notesView
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    const out = { fatal: null, attempts: [] }
    const docText = () => view.state.doc.textBetween(0, view.state.doc.content.size, '\\n')

    /* 谁在 drop 上 preventDefault：runCustomHandler 里那行 OR 一旦为真，
       prosemirror-view 的内置 drop 整段被跳过（drop-indicator 的 handleDrop
       挂在内置 drop 里，也一起没了）。抓调用栈定位到人。 */
    const origPreventDefault = Event.prototype.preventDefault
    const pdCalls = []
    Event.prototype.preventDefault = function () {
      if (this.type === 'drop' || this.type === 'dragover') {
        pdCalls.push({
          type: this.type,
          stack: String(new Error().stack || '').split('\\n').slice(1, 7).join(' <- ')
        })
      }
      return origPreventDefault.call(this)
    }

    /* 事务日志：drop 期间到底有没有 dispatch。0 步事务要抓调用栈才知道是谁发的 */
    const origDispatch = view.dispatch.bind(view)
    let tx = []
    view.dispatch = (tr) => {
      tx.push({
        steps: tr.steps.length,
        uiEvent: tr.getMeta('uiEvent') ?? null,
        changed: !tr.doc.eq(view.state.doc),
        stack: tr.steps.length === 0 ? String(new Error().stack || '').split('\\n').slice(1, 5).join(' <- ') : null
      })
      return origDispatch(tr)
    }

    /* 直接 patch prosemirror-drop-indicator 插件的 handleDrop prop。
       不能靠包 view.someProp —— prosemirror-view 内部用的是模块级 helper，不走实例方法。 */
    const dropPlugin =
      view.state.plugins.find((p) => String(p.key).indexOf('prosemirror-drop-indicator') === 0) ||
      view.state.plugins.find((p) => p.props.handleDrop)
    let hpCalls = []
    let origDropProp = null
    if (dropPlugin) {
      origDropProp = dropPlugin.props.handleDrop
      dropPlugin.props.handleDrop = function (v, ev, slice, move) {
        const docBefore = v.state.doc
        const hadDragging = !!v.dragging
        const r = origDropProp.call(this, v, ev, slice, move)
        hpCalls.push({
          ret: r === true,
          move,
          hadDragging,
          sliceChildCount: slice ? slice.content.childCount : null,
          openStart: slice ? slice.openStart : null,
          openEnd: slice ? slice.openEnd : null,
          docChanged: !v.state.doc.eq(docBefore)
        })
        return r
      }
    }

    /* 复刻 prosemirror-drop-indicator 的 getTargetsByView（drop-target.ts:17） */
    const buildTargets = () => {
      const targets = []
      const stack = [[-1, view.state.doc]]
      while (stack.length) {
        const [pos, node] = stack.pop()
        if (pos >= 0) {
          const dom = view.nodeDOM(pos)
          if (dom && dom.nodeType === 1) {
            const r = dom.getBoundingClientRect()
            targets.push({ pos, line: [r.left, r.top, r.right, r.top] })
            targets.push({ pos: pos + node.nodeSize, line: [r.left, r.bottom, r.right, r.bottom] })
          }
        }
        if (node.isBlock && !node.isTextblock) {
          let cp = pos + 1
          for (const child of node.children) { stack.push([cp, child]); cp += child.nodeSize }
        }
      }
      return targets
    }
    const ppd = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1])
    const pld = (pt, line) => Math.min(ppd(pt, [line[0], line[1]]), ppd(pt, [line[2], line[3]]))

    /* 悬停第一段，让抓手显示出来 */
    const firstP = pm.querySelector('p')
    if (!firstP) { out.fatal = '编辑器里没有 p 段落'; return out }
    const pr = firstP.getBoundingClientRect()
    const hoverX = pr.left + pr.width / 2
    const hoverY = pr.top + pr.height / 2
    pm.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: hoverX, clientY: hoverY }))
    await sleep(400)

    const handle = document.querySelector('.milkdown-block-handle')
    if (!handle) { out.fatal = '抓手元素没渲染出来'; return out }
    out.handle = { draggable: handle.draggable, dataShow: handle.dataset.show }
    const hr = handle.getBoundingClientRect()
    const hx = hr.left + hr.width / 2
    const hy = hr.top + hr.height / 2

    /* 每次尝试：mousedown -> dragstart -> dragover -> drop -> dragend */
    const attempt = async (dropY) => {
      const snapshot = view.state.doc
      const restore = () => view.dispatch(view.state.tr.replaceWith(0, view.state.doc.content.size, snapshot.content))
      const before = docText()

      handle.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: hx, clientY: hy, button: 0 }))
      await sleep(60)
      const sel = view.state.selection
      const selInfo = { ctor: sel.constructor.name, from: sel.from, to: sel.to }
      const selected = !!pm.querySelector('.ProseMirror-selectednode')

      const dt = new DataTransfer()
      handle.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: hx, clientY: hy }))
      await sleep(40)
      const dragging = view.dragging
      const dragInfo = dragging ? { hasSlice: !!dragging.slice, move: dragging.move, hasNode: !!dragging.node } : null
      const domDragging = pm.dataset.dragging

      const targets = buildTargets()
      const pt = [hoverX, dropY]
      targets.sort((a, b) => pld(pt, a.line) - pld(pt, b.line) || a.pos - b.pos)
      const top8 = targets.slice(0, 8).map((t) => ({ pos: t.pos, y: Math.round(t.line[1]), dist: Math.round(pld(pt, t.line)) }))
      /* isDraggingToItself（drop-target.ts:163）。
         注意：插件用的是 instanceof 判断，不是构造函数名 —— 打包后类名被压成 "e"，
         按名字比会得出假阴性。这里用 instanceof 复现。 */
      let toItself = null
      if (dragging && dragging.move) {
        const chosen = targets[0]
        toItself = chosen ? sel.from <= chosen.pos && chosen.pos <= sel.to : null
        out.selIsNodeSel = sel instanceof sel.constructor
      }
      let posAtCoords = null
      try {
        const pc = view.posAtCoords({ left: hoverX, top: dropY })
        posAtCoords = pc ? pc.pos : null
      } catch (e) {
        posAtCoords = 'throw:' + e.message
      }

      tx = []
      hpCalls = []
      pdCalls.length = 0
      pm.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: hoverX, clientY: dropY }))
      await sleep(30)
      pm.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: hoverX, clientY: dropY }))
      await sleep(100)
      handle.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: hx, clientY: hy }))
      await sleep(80)

      const after = docText()
      if (after !== before) restore()
      return { dropY: Math.round(dropY), before, after, changed: after !== before, selInfo, selected, dragInfo, domDragging, top8, toItself, posAtCoords, tx, hpCalls, pdCalls: pdCalls.slice() }
    }

    /* 落点扫描：把落点依次放到每个段落的上/下方 */
    const ys = []
    for (const p of pm.querySelectorAll('p')) {
      const r = p.getBoundingClientRect()
      ys.push(r.top - 6, r.bottom + 6)
    }
    for (const y of ys) out.attempts.push(await attempt(y))

    const rectOf = (el) => {
      if (!el) return null
      const r = el.getBoundingClientRect()
      const s = getComputedStyle(el)
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, overflowY: s.overflowY }
    }
    out.domRect = rectOf(pm)
    out.milkdownRoot = rectOf(pm.closest('.milkdown'))
    /* 插件清单：确认 prosemirror-drop-indicator 到底在不在（它带 handleDrop prop） */
    out.pluginCount = view.state.plugins.length
    out.pluginsWithHandleDrop = view.state.plugins.filter((p) => p.props.handleDrop).length
    out.pluginKeys = view.state.plugins.map((p) => {
      const k = p.key
      return (k && k.key) || String(k)
    })
    out.selIsNodeSelText = '见每次尝试'
    view.dispatch = origDispatch
    if (dropPlugin && origDropProp) dropPlugin.props.handleDrop = origDropProp
    return out
  })()`)

  if (report.fatal) {
    console.error('  致命：', report.fatal)
    process.exitCode = 1
  } else {
    console.log('\n抓手元素：', JSON.stringify(report.handle))
    console.log('编辑区 .ProseMirror：', JSON.stringify(report.domRect))
    console.log('父级 .milkdown：', JSON.stringify(report.milkdownRoot))
    console.log(`插件数=${report.pluginCount}  带 handleDrop 的插件数=${report.pluginsWithHandleDrop}`)
    console.log('插件 key：', JSON.stringify(report.pluginKeys))
    for (const a of report.attempts) {
      console.log(`\n落点 y=${a.dropY}  changed=${a.changed}  isDraggingToItself=${a.toItself}  posAtCoords=${a.posAtCoords}`)
      console.log(`   handleDrop 被调用 ${a.hpCalls.length} 次：${JSON.stringify(a.hpCalls)}`)
      const dd = a.pdCalls.filter((c) => c.type === 'drop')
      console.log(`   drop 上的 preventDefault ${dd.length} 次`)
      for (const c of dd) console.log(`      ${c.stack}`)
      for (const t of a.tx) {
        console.log(`   事务 steps=${t.steps} uiEvent=${t.uiEvent} changed=${t.changed}`)
        if (t.stack) console.log(`      0 步事务调用栈：${t.stack}`)
      }
      if (a.changed) console.log(`   文本：${a.before.replace(/\n/g, ' | ')}  =>  ${a.after.replace(/\n/g, ' | ')}`)
    }
    /* 断言：只有「拖回自己原位」（isDraggingToItself）才允许不动 */
    const moved = report.attempts.filter((a) => a.changed)
    const selfDrops = report.attempts.filter((a) => a.toItself === true)
    const realFailures = report.attempts.filter((a) => a.toItself !== true && !a.changed)
    console.log(
      `\n=== 结论：共 ${report.attempts.length} 个落点 —— 移动成功 ${moved.length} 个；` +
        `落点算在「被拖块自己范围内」${selfDrops.length} 个（这类按设计该不动，` +
        `其中也可能被 prosemirror-view 内置路径接走而真的移动了）；真正的失败 ${realFailures.length} 个 ===`
    )
    if (realFailures.length) {
      console.log('真正的失败落点 y：', realFailures.map((a) => a.dropY).join(', '))
      process.exitCode = 1
    } else {
      console.log('PASS：所有非「拖回自己」的落点都成功移动了块')
    }
  }
  await cdp.screenshot(SHOT('notes-2-after.png'))
} catch (err) {
  console.error('探针失败：', err)
  process.exitCode = 1
} finally {
  await stop(child)
  try {
    cdp?.close()
  } catch {
    /* 已断开 */
  }
  await logHandle.close()
  await fs.rm(base, { recursive: true, force: true })
}
