/**
 * Agent 内嵌浏览器面板的端到端验证（隔离实例 + CDP）。
 *
 * 验证「会话 id 契约」：渲染端面板订阅的 sessionId 必须与主进程 Agent 工具用的
 * 完全一致（都由 @shared/browser 的 agentBrowserSessionId 推导）。做法是**绕过 UI**、
 * 直接用那个 id 从主进程开一个浏览器会话并导航 —— 如果面板订阅的 id 不对，
 * 帧就不会出现在面板的 <img> 里。
 *
 * 启动实例（注意剥掉 WorkBuddy 注入的 ELECTRON_RUN_AS_NODE）：
 *   MSYS_NO_PATHCONV=1 env -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS \
 *     node_modules/electron/dist/electron.exe . --remote-debugging-port=9333 \
 *     --user-data-dir="C:/Users/<user>/AppData/Local/Temp/dogi-cdp-auto" \
 *     --no-sandbox --in-process-gpu --disable-gpu-sandbox
 *
 * 然后：node scripts/verify-agent-browser.mjs
 */
import { connect, sleep, report } from './lib/cdp.mjs'

const cdp = await connect({ port: 9333 })
await cdp.bringToFront()
await sleep(1500)

const checks = []
const log = (...a) => console.log('[verify]', ...a)

/** 浏览器画面的 img：取可见的那个（历史遗留的隐藏面板 rect 为 0） */
const VISIBLE_IMG = `[...document.querySelectorAll('img')]
  .filter((el) => el.alt === '浏览器画面')
  .find((el) => { const r = el.getBoundingClientRect(); return r.width > 40 && r.height > 40 })`

// ---------------------------------------------------------------------------
// 0. 清理：关掉上一轮遗留的 agent 标签
//    每个 agent 标签都会渲染一份 AgentPage，工具栏里各有一个「浏览器」按钮 ——
//    不清掉的话 querySelector 命中的是隐藏标签里那个，点了不会影响本轮的会话。
// ---------------------------------------------------------------------------
const cleaned = await cdp.eval(`(() => {
  const s = window.__store.getState()
  const stale = s.ui.panelTabs.filter((t) => t.type === 'agent')
  stale.forEach((t) => s.closePanelTab(t.id))
  return stale.length
})()`)
log('清理遗留 agent 标签:', cleaned)
await sleep(1000)

// ---------------------------------------------------------------------------
// 1. 准备一个 Agent 工作区与会话
// ---------------------------------------------------------------------------
const prepared = await cdp.eval(`(async () => {
  const s = window.__store.getState()
  // 复用已有工作区（隔离实例的 user-data-dir 会跨轮保留），没有就用当前仓库建一个
  let ws = s.agentWorkspaces[0]
  if (!ws) {
    await s.saveAgentWorkspace({ name: 'Dogi 仓库', path: 'D:/Workspace/web/owner/dogi' })
    ws = window.__store.getState().agentWorkspaces[0]
  }
  if (!ws) return { error: '工作区创建失败' }
  window.__store.getState().createAgentConversation(ws.id)
  const st = window.__store.getState()
  return {
    workspaceId: ws.id,
    conversationId: st.activeAgentConversationId,
    tabs: st.ui.panelTabs.map((t) => ({ id: t.id, type: t.type }))
  }
})()`)
log('准备结果:', JSON.stringify(prepared))
checks.push(['Agent 工作区已就绪', Boolean(prepared && prepared.workspaceId)])
checks.push(['Agent 会话已创建', Boolean(prepared && prepared.conversationId)])

const conversationId = prepared.conversationId
const sessionId = `agent-browser:${conversationId}`
log('期望的浏览器会话 id =', sessionId)

// 切到 Agent 功能区并聚焦这个会话的标签 —— 否则面板所在的标签不是当前标签，
// 渲染出来的是 0 尺寸（隐藏态），断言会全部落空
await cdp.eval(`(() => {
  const s = window.__store.getState()
  window.__store.setState((st) => ({ ui: { ...st.ui, activeActivity: 'agent' } }))
  s.selectAgentConversation('${conversationId}')
  return true
})()`)
await sleep(1500)

// Agent 页的标签已打开
const agentTab = await cdp.eval(`(() => {
  const t = window.__store.getState().ui.panelTabs.find((x) => x.type === 'agent')
  return t ? { id: t.id, type: t.type } : null
})()`)
checks.push(['Agent 标签已打开', agentTab?.type === 'agent'])

// ---------------------------------------------------------------------------
// 2. 点工具栏的「浏览器」按钮，面板应出现
// ---------------------------------------------------------------------------
// ⚠️ 活动栏的「接口请求」也用 Globe 图标，所以按 aria-label 精确定位，别按图标找；
//    再取可见的那个（分屏 / 多标签并存时会有多个同 aria-label 的按钮）
const globeClicked = await cdp.eval(`(() => {
  const btn = [...document.querySelectorAll('button[aria-label="浏览器"]')]
    .find((b) => b.getBoundingClientRect().width > 0)
  if (!btn) return false
  btn.click()
  return true
})()`)
checks.push(['Agent 工具栏有浏览器按钮且可点击', globeClicked])
await sleep(1200)

const panePresent = await cdp.eval(`(() => {
  const img = ${VISIBLE_IMG}
  if (!img) return { ok: false }
  return { ok: true, w: Math.round(img.getBoundingClientRect().width) }
})()`)
log('浏览器面板:', JSON.stringify(panePresent))
checks.push(['点按钮后浏览器面板出现且有尺寸', Boolean(panePresent && panePresent.ok && panePresent.w > 40)])

// 面板里应有「打开浏览器」占位（会话还没启动）
const placeholder = await cdp.eval(`(() => {
  const norm = (s) => (s || '').replace(/\\s/g, '')
  return [...document.querySelectorAll('button')].some((b) => norm(b.textContent) === '打开浏览器')
})()`)
checks.push(['未启动时面板显示「打开浏览器」占位', placeholder])

// ---------------------------------------------------------------------------
// 3. 会话 id 契约：用 agentBrowserSessionId 推导出的 id 从主进程开会话
// ---------------------------------------------------------------------------
await cdp.eval(`window.api.browser.open({
  sessionId: ${JSON.stringify(sessionId)},
  url: 'data:text/html;charset=utf-8,' + encodeURIComponent('<h1 id=t>AGENT BROWSER OK</h1>'),
  mode: 'desktop'
})`)
await sleep(1500)

let frameSrc = null
for (let i = 0; i < 40; i++) {
  await sleep(500)
  const snap = await cdp.eval(`(() => {
    const img = ${VISIBLE_IMG}
    return img ? img.src.slice(0, 24) : null
  })()`)
  frameSrc = snap
  if (frameSrc && frameSrc.startsWith('data:image/jpeg')) break
}
log('Agent 面板首帧 src 前缀 =', frameSrc)
checks.push([
  'Agent 面板收到该会话的 screencast 帧（id 契约一致）',
  Boolean(frameSrc && frameSrc.startsWith('data:image/jpeg'))
])

// 面板工具栏应显示浏览器名（说明 onState 也路由到了）
const channelShown = await cdp.eval(`(() => {
  const s = window.__store.getState()
  return document.body.innerText.includes('Edge') || document.body.innerText.includes('Chrome')
})()`)
checks.push(['面板状态（浏览器名）已渲染', channelShown])

// 主进程侧的会话状态
const state = await cdp.eval(`window.api.browser.state(${JSON.stringify(sessionId)})`)
log('会话状态:', JSON.stringify(state))
checks.push([
  '会话视口是 PC 预设 1280×800（Agent 工具与面板共用同一个默认视口）',
  Boolean(state && state.viewportMode === 'desktop' && state.viewport.width === 1280)
])

// ---------------------------------------------------------------------------
// 4. 关面板不应关会话（会话归 Agent 的工具管）
// ---------------------------------------------------------------------------
await cdp.eval(`(() => {
  const btn = [...document.querySelectorAll('button[aria-label="浏览器"]')]
    .find((b) => b.getBoundingClientRect().width > 0)
  if (btn) btn.click()
})()`)
await sleep(800)
const afterHide = await cdp.eval(`window.api.browser.state(${JSON.stringify(sessionId)})`)
checks.push(['收起面板后浏览器会话仍然存活', Boolean(afterHide && afterHide.channel)])

// 收尾
await cdp.eval(`window.api.browser.close(${JSON.stringify(sessionId)})`)
await sleep(1000)

const shot = await cdp.screenshot('tmp/agent-browser-panel.png')
log('截图:', shot)

cdp.close()
process.exit(report(checks) === 0 ? 0 : 1)
