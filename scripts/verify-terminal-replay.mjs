// 终端标签跨组移动后回放主进程环形缓冲的验证（隔离实例 + CDP）。
//
// 背景：PTY 在主进程一直在跑，而渲染端只收**增量**流（`terminal:onData`）。
// 把终端标签拖到分屏（`splitTabToGroup`）或跨组并入（`moveTabToGroup`）会让标签宿主
// 换父节点、React 重挂载 `TerminalView`，新 xterm 实例的滚动缓冲是空的 —— 修复前
// 表现为「历史输出没了，只能滚回当前屏幕顶（LINE29）」。
//
// 覆盖：
//   1. 灌 60 行（超出屏幕高度，滚动缓冲才有意义）；先确认拆分**前**能滚到会话第一行；
//   2. 拖到分屏后仍能滚到会话第一行（PowerShell 的启动横幅）—— 即回放生效；
//   3. 接缝不重复：拆分后再打一条哨兵，滚到底部只见一次；
//   4. 回放之后新来的输出照常到达（订阅没被回放卡住）；
//   5. 跨组并入（另一条路径）同样回放。
//
// 用法：先 `npm run build`，再按 AGENTS.md「验证工具链」起隔离实例
//      （--remote-debugging-port=9333 --user-data-dir=<临时>），然后 `node scripts/verify-terminal-replay.mjs`。
import { connect, sleep, report } from './lib/cdp.mjs'

const PORT = Number(process.env.DOGI_CDP_PORT ?? 9333)
const cdp = await connect({ port: PORT })
/** 包一层：打印失败的求值表达式，便于定位 */
const ev = async (expr) => {
  try {
    return await cdp.eval(expr)
  } catch (e) {
    console.log('EVAL FAILED:', JSON.stringify(String(expr).slice(0, 140)), '→', String(e).slice(0, 140))
    throw e
  }
}
await cdp.bringToFront()
await cdp.reload(4000)
await sleep(2500)

const checks = []
const assert = (name, ok, detail) => {
  checks.push([name, Boolean(ok)])
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

/** 目标终端（灌过 60 行的那个）中心坐标：滚轮是真事件，必须打在元素上 */
const targetRect = async () =>
  JSON.parse(
    await ev(`
(() => {
  const t = [...document.querySelectorAll('.xterm')].find(x => x.innerText.includes('LINE'))
  if (!t) return '{}'
  const r = t.getBoundingClientRect()
  return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) })
})()
`)
  )
/**
 * 往上/下滚。
 * ⚠️ 必须用 CDP 的 `Input.dispatchMouseEvent`（真事件）：往 `.xterm-viewport` 派发
 * 合成 `WheelEvent` **滚不动** —— xterm 的 wheel 监听挂在里面的屏幕元素上，
 * 事件从 viewport 派发是向下传播、到不了监听点，探针会误判成「历史丢了」。
 */
const wheel = async (deltaY, times) => {
  const { x, y } = await targetRect()
  if (x === undefined) return
  for (let i = 0; i < times; i++) {
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x,
      y,
      deltaX: 0,
      deltaY,
      pointerType: 'mouse'
    })
  }
  await sleep(500)
}
const scrollTop_ = () => wheel(-400, 40)
const scrollBottom = () => wheel(400, 60)

/** 目标终端当前屏幕上的行文本（空行滤掉） */
const screen = async () =>
  JSON.parse(
    await ev(`
(() => {
  const t = [...document.querySelectorAll('.xterm')].find(x => x.innerText.includes('LINE'))
  if (!t) return '{"missing":true}'
  const r = [...t.querySelectorAll('.xterm-rows > div')].map(x => x.textContent.replace(/\\u00a0/g, ' ').trim()).filter(Boolean)
  return JSON.stringify({ first: r[0], last: r[r.length - 1], rows: r })
})()
`)
  )

/** 会话第一行：PowerShell 的启动横幅（环形缓冲的最开头） */
const BANNER = 'Windows PowerShell'

// 1. 同组开两个本地终端
await ev(`(async () => { const s = window.__store.getState(); await s.createLocalSession(); await s.createLocalSession(); return 1 })()`)
await sleep(3500)
const tabs = JSON.parse(
  await ev(`
(() => { const s = window.__store.getState()
  return JSON.stringify(s.ui.panelTabs.filter(t => t.type === 'terminal').map(t => ({ id: t.id, sid: t.sessionId, gid: t.groupId }))) })()
`)
)
const t2 = tabs[tabs.length - 1]

// 2. 灌 60 行（超出屏幕高度，滚动缓冲才有意义）
await ev(`window.api.terminal.write('${t2.sid}', '1..60 | % { "LINE$_" }\\r'), 1`)
await sleep(5000)
const before = await screen()
assert('灌完 60 行（当前屏幕看不到 LINE1）', !/^LINE1$/.test(before.first) && before.rows?.length > 0, `first=${before.first}`)

await scrollTop_()
const beforeTop = await screen()
assert('拆分前能滚到会话第一行（对照组）', beforeTop.first === BANNER, `first=${beforeTop.first}`)
await scrollBottom()

// 3. 拖到分屏 —— 这一步会重挂载 TerminalView
await ev(`window.__store.getState().splitTabToGroup('${t2.id}', '${t2.gid}', 'right'), 1`)
await sleep(3000)
const afterSplit = await screen()
assert('拆分后当前屏幕仍是最新输出', afterSplit.first === before.first, `first=${afterSplit.first}`)

await scrollTop_()
const afterSplitTop = await screen()
assert('拖到分屏后仍能滚回会话第一行', afterSplitTop.first === BANNER, `滚到顶 first=${afterSplitTop.first}`)

// 4. 接缝不重复 + 回放之后的新输出照常到达
await ev(`window.api.terminal.write('${t2.sid}', 'echo DOGI_SEAM_MARKER\\r'), 1`)
await sleep(3000)
await scrollBottom()
const seam = await screen()
assert(
  '接缝不重复：哨兵只出现一次',
  seam.rows?.filter((x) => x === 'DOGI_SEAM_MARKER').length === 1,
  `末三行 ${JSON.stringify(seam.rows?.slice(-3))}`
)

// 5. 跨组并入（另一条路径）同样回放
await ev(`window.api.terminal.write('${t2.sid}', '1..60 | % { "LINE$_" }\\r'), 1`)
await sleep(5000)
await scrollTop_()
const preMove = await screen()
assert('并入前能滚到会话第一行', preMove.first === BANNER, `first=${preMove.first}`)
await scrollBottom()
const groups = JSON.parse(
  await ev(`JSON.stringify(Object.values(window.__store.getState().groups).map(g => ({ id: g.id, n: g.tabIds.length })))`)
)
const curGid = JSON.parse(
  await ev(`(() => { const t = window.__store.getState().ui.panelTabs.find(x => x.id === '${t2.id}'); return JSON.stringify({ gid: t.groupId }) })()`)
).gid
const other = groups.find((g) => g.id !== curGid)
await ev(`window.__store.getState().moveTabToGroup('${t2.id}', '${other.id}'), 1`)
await sleep(3000)
await scrollTop_()
const afterMove = await screen()
assert('跨组并入后也能滚回会话第一行', afterMove.first === BANNER, `滚到顶 first=${afterMove.first}`)

report(checks)
cdp.close()
process.exit(checks.every(([, ok]) => ok) ? 0 : 1)
