/**
 * 量化「消息流滚动」的开销：消息目录（MessageOutline）的 scroll-spy 在**每帧**要量消息位置。
 *
 * 修之前的做法是「每帧从头扫一遍全部提问」= O(提问数) 次 `getBoundingClientRect`
 * （每次都强制同步布局）+ O(提问数) 次 `querySelector` —— 消息一多，滚动就是掉帧。
 * 现在改成「缓存元素 + 二分查找」= O(log n) 次量。
 *
 * 这个探针直接在页面里**计数** `getBoundingClientRect` / `querySelector` 的调用次数：
 * 提问数 50 → 300（6 倍）时，每帧的量次数不应该跟着线性涨（对数级）。
 *
 * 隔离实例 + CDP（见 AGENTS.md 5.1）。用法：
 *   node scripts/verify-agent-outline-scroll-cost.mjs
 * 需要先 `npm run build`。
 */
import { connect, sleep, report } from './lib/cdp.mjs'

const checks = []
const check = (name, ok, detail = '') => {
  checks.push([name + (detail ? ` — ${detail}` : ''), !!ok])
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}

const cdp = await connect()
await cdp.bringToFront()
await cdp.reload()
await cdp.eval('1')
for (let i = 0; i < 40; i++) {
  const ready = await cdp.eval('!!(window.__store && document.querySelector("#root")?.firstChild)')
  if (ready) break
  await sleep(500)
}

/** 造一条有 n 轮「提问 + 回答」的会话并打开它 */
async function seed(n) {
  await cdp.eval(`(() => {
    const N = ${n}
    const st = window.__store.getState()
    const wsId = st.agentWorkspaces[0]?.id ?? 'probe-ws'
    const messages = []
    for (let i = 0; i < N; i++) {
      messages.push({ id: 'u' + i, role: 'user', createdAt: 1000 + i * 1000,
        parts: [{ type: 'text', text: '第 ' + i + ' 个问题：' + 'x'.repeat(200) }] })
      messages.push({ id: 'a' + i, role: 'assistant',
        parts: [{ type: 'text', text: '第 ' + i + ' 个回答：' + 'y'.repeat(600) }] })
    }
    const conv = {
      id: 'probe-outline', workspaceId: wsId, kind: 'mastra', title: '目录探针',
      messages, createdAt: 1000, updatedAt: 1000 + N * 1000
    }
    window.__store.setState((s) => ({
      agentWorkspaces: s.agentWorkspaces.length ? s.agentWorkspaces : [{ id: wsId, name: '探针工作区', path: 'C:/tmp' }],
      agentConversations: [...s.agentConversations.filter((c) => c.id !== 'probe-outline'), conv],
      activeAgentWorkspaceId: wsId
    }))
    window.__store.getState().selectAgentConversation('probe-outline')
    return true
  })()`)
  // 等消息渲染完（Markdown / 布局）
  await sleep(2500)
  // 滚到中间：让 scroll-spy 进入「扫过一部分」的稳态
  await cdp.eval(`(() => {
    const el = document.querySelector('[data-outline="rail"]')
    const panel = el?.parentElement
    let node = panel?.querySelector('[data-message-id]')?.parentElement
    while (node && node !== panel) {
      const oy = getComputedStyle(node).overflowY
      if (oy === 'auto' || oy === 'scroll') { node.scrollTop = node.scrollHeight / 2; return true }
      node = node.parentElement
    }
    return false
  })()`)
  await sleep(800)
}

/** 装计数器：统计一帧滚动里量了多少次布局 / 查了多少次选择器 */
await cdp.eval(`(() => {
  const proto = Element.prototype
  if (!window.__probePatched) {
    window.__probePatched = true
    window.__rectCalls = 0
    window.__qsCalls = 0
    const rect = proto.getBoundingClientRect
    proto.getBoundingClientRect = function () { window.__rectCalls++; return rect.apply(this, arguments) }
    const qs = Document.prototype.querySelector
    Document.prototype.querySelector = function () { window.__qsCalls++; return qs.apply(this, arguments) }
  }
  window.__rectCalls = 0
  window.__qsCalls = 0
  return true
})()`)

/** 跑 frames 帧滚动，返回每帧平均的 rect / querySelector 次数 */
async function measure(frames = 30) {
  await cdp.eval('(() => { window.__rectCalls = 0; window.__qsCalls = 0; return true })()')
  for (let i = 0; i < frames; i++) {
    await cdp.eval(`(() => {
      const el = document.querySelector('[data-outline="rail"]')
      const panel = el?.parentElement
      let node = panel?.querySelector('[data-message-id]')?.parentElement
      while (node && node !== panel) {
        const oy = getComputedStyle(node).overflowY
        if (oy === 'auto' || oy === 'scroll') {
          node.scrollTop += 37
          node.dispatchEvent(new Event('scroll'))
          return true
        }
        node = node.parentElement
      }
      return false
    })()`)
    // 一帧的时间（spy 是 rAF 合帧的）
    await sleep(20)
  }
  await sleep(300)
  const r = await cdp.eval('({ rect: window.__rectCalls, qs: window.__qsCalls })')
  return { rectPerFrame: r.rect / frames, qsPerFrame: r.qs / frames }
}

await seed(50)
const small = await measure()
await seed(300)
const big = await measure()

console.log(`50 轮提问：每帧 ${small.rectPerFrame.toFixed(1)} 次 getBoundingClientRect / ${small.qsPerFrame.toFixed(1)} 次 querySelector`)
console.log(`300 轮提问：每帧 ${big.rectPerFrame.toFixed(1)} 次 getBoundingClientRect / ${big.qsPerFrame.toFixed(1)} 次 querySelector`)

// 提问数 6 倍，每帧的布局读取**不应**接近 6 倍（对数级 ≈ 1.2 倍）
const rectRatio = big.rectPerFrame / Math.max(0.001, small.rectPerFrame)
check(
  '提问数 ×6 时每帧布局读取不成线性增长',
  rectRatio < 3,
  `比值 ${rectRatio.toFixed(2)}（线性会是 6）`
)
check(
  '每帧不再逐条 querySelector 消息元素',
  big.qsPerFrame < 40,
  `每帧 ${big.qsPerFrame.toFixed(1)} 次`
)
// 绝对值也要合理：use-stick-to-bottom 的主滚动容器本来每次事件就要读几次布局
check('每帧布局读取维持在两位数以内', big.rectPerFrame < 40, `${big.rectPerFrame.toFixed(1)} 次/帧`)

cdp.close()
const failed = report(checks)
process.exit(failed === 0 ? 0 : 1)