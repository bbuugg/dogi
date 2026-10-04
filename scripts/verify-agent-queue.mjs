// Agent 会话的「待发送消息队列」+ 工具行对齐契约（隔离实例 + CDP）。
//
// 覆盖：
//   1. 队列渲染在输入卡片**内部**（header），每条带「现在发 / 编辑 / 删除」三个按钮；
//   2. 空闲时 submit 直接发一轮（不落队列），流式中 submit 才入队；
//   3. 流式中「现在发」被忽略、删除生效、空闲后 pump 弹出队首、删会话清空队列；
//   3b. **手动停止 / 报错后队列暂停自动接续**（`queueHold`）：中止、报错两条路径都不 pump，
//       自然结束才解除；ACP 回放发的 finish('done') 与切会话都不得绕过这道暂停；
//   3c. 走真实的 `abortAgent`：**requestId 还没落地时点停止也要停得住**（主进程准备阶段
//       曾放在回包之前，那时 abortAgent 直接 return，队列照发），且停止后晚到的
//       finish('done') 不得撤销暂停；
//   4. 思考展开体走 use-stick-to-bottom：内容增长时贴底（spring 进行中 gap 略大于 0），
//      用户上滚后**不再**跟随、滚回底部恢复；
//   5. 工具行（失败态）行内各项的垂直中心完全相等、图标尺寸统一 size-4 —— 对齐契约。
//
// 用法（先构建好 out/，再按 AGENTS.md「验证工具链」起隔离实例）：
//   MSYS_NO_PATHCONV=1 node_modules/electron/dist/electron.exe . \
//     --remote-debugging-port=9333 --user-data-dir=<临时目录> \
//     --no-sandbox --in-process-gpu --disable-gpu-sandbox
//   node scripts/verify-agent-queue.mjs
import { connect, sleep, report } from './lib/cdp.mjs'

const PORT = Number(process.env.DOGI_CDP_PORT ?? 9333)
const WS_ID = 'verify-queue-ws'
const CONV_ID = 'verify-queue-conv'
/** 故意给一条**长**命令：用来验证横条上的截断（短的看不出问题） */
const LONG_CMD =
  'npm run build -- --mode=production --minify --sourcemap=false --outDir=dist/release/candidate --target=es2022'

/** 造一条会话（含思考 + 失败工具调用 + 成功工具调用），并把它开到前台 */
async function seed(cdp, { streaming = false } = {}) {
  const now = Date.now()
  await cdp.eval(`
  (() => {
    const st = window.__store.getState()
    const now = ${now}
    const conv = {
      id: '${CONV_ID}', workspaceId: '${WS_ID}', kind: 'mastra', title: 'verify',
      createdAt: now, updatedAt: now,
      messages: [{
        id: 'm1', role: 'assistant', createdAt: now,
        parts: [
          { type: 'text', text: '我先读一下文件。' },
          { type: 'reasoning', text: '用户想让我读一个文件。\\n先确认文件存不存在。\\n调用 read_file。' },
          { type: 'tool-call', toolCallId: 't1', toolName: 'read_file', input: { path: 'src/nope.ts' } },
          { type: 'tool-result', toolCallId: 't1', toolName: 'read_file', output: 'ENOENT: no such file or directory', isError: true },
          { type: 'tool-call', toolCallId: 't2', toolName: 'execute_command', input: { command: ${JSON.stringify(LONG_CMD)} } },
          { type: 'tool-result', toolCallId: 't2', toolName: 'execute_command', output: 'exit code 1' },
          // 纯结构化入参（无任何字符串字段）：横条上**不应**出现 JSON 噪声预览
          { type: 'tool-call', toolCallId: 't3', toolName: 'ask_followup_question', input: { questions: [{ id: 'q1', question: '选哪个？', options: [{ id: 'a', label: '甲' }] }] } },
          { type: 'text', text: '文件不存在。' }
        ]
      }]
    }
    window.__store.setState({
      agentWorkspaces: [
        ...st.agentWorkspaces.filter(w => w.id !== '${WS_ID}'),
        { id: '${WS_ID}', path: 'D:/workspace/demo', name: 'demo', createdAt: now, updatedAt: now }
      ],
      agentConversations: [...st.agentConversations.filter(c => c.id !== '${CONV_ID}'), conv],
      agentRuns: ${streaming ? `{ ...st.agentRuns, ['${CONV_ID}']: { streaming: true, requestId: null, error: null } }` : '{}'},
      agentQueues: {},
      ui: { ...st.ui, activeActivity: 'agent' }
    })
    return 1
  })()
  `)
  await sleep(500)
  await cdp.eval(`window.__store.getState().selectAgentConversation('${CONV_ID}'), 1`)
  await sleep(900)
}

const cdp = await connect({ port: PORT })
await cdp.bringToFront()
await cdp.reload(4000)
await sleep(2500)

const checks = []
const check = (name, ok, detail) => {
  checks.push([name, Boolean(ok)])
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

// ---------- 1 + 5. 队列渲染位置 & 工具行对齐 ----------
await seed(cdp)
await cdp.eval(`window.__store.getState().enqueueAgentMessage('第一条排队消息', '${CONV_ID}'), 1`)
await cdp.eval(`window.__store.getState().enqueueAgentMessage('第二条排队消息', '${CONV_ID}'), 1`)
await sleep(600)

const dom = await cdp.eval(`
(() => {
  const queue = document.querySelector('[data-queue]')
  const card = queue?.parentElement ?? null
  const rows = [...document.querySelectorAll('[class*="group/row"]')]
  const toolRow = rows.find((r) => (r.textContent || '').includes('读取文件'))
  const cmdRow = rows.find((r) => (r.textContent || '').includes('执行命令'))
  const kids = toolRow
    ? [...toolRow.firstElementChild.children].map((el) => {
        const b = el.getBoundingClientRect()
        return {
          tag: el.tagName.toLowerCase(),
          size: (el.getAttribute('class') || '').match(/size-[\\d.]+/)?.[0] ?? null,
          cy: Math.round((b.top + b.height / 2) * 100) / 100
        }
      })
    : []
  // 命令行：工具名右侧的预览 + 状态图标是否还在最右端
  const cmdKids = cmdRow
    ? [...cmdRow.firstElementChild.children].map((el) => {
        const b = el.getBoundingClientRect()
        return { tag: el.tagName.toLowerCase(), text: (el.textContent || '').slice(0, 30), x: Math.round(b.x), w: Math.round(b.width) }
      })
    : []
  const preview = cmdRow?.querySelector('[data-tool-preview]') ?? null
  const trigger = cmdRow?.firstElementChild ?? null
  return {
    queueText: queue?.innerText.replace(/\\s*\\n\\s*/g, ' | ') ?? null,
    inComposerCard: Boolean(card && /rounded-xl/.test(card.className)),
    queueRows: queue?.querySelectorAll('[class*="group/queue"]').length ?? 0,
    queueButtons: [...(queue?.querySelectorAll('button') ?? [])].map((b) => b.getAttribute('aria-label')),
    toolRowKids: kids,
    cmdKids,
    previewText: preview?.textContent ?? null,
    previewTruncated: preview ? preview.scrollWidth > preview.clientWidth : null,
    previewFitsColumn: preview && trigger ? preview.getBoundingClientRect().right <= trigger.getBoundingClientRect().right + 1 : null,
    // 末位（箭头之前）必须是状态图标，不是预览
    cmdLastChildTag: cmdKids.length ? cmdKids[cmdKids.length - 1].tag : null,
    cmdLastChildIsSvg: cmdKids.length ? cmdKids[cmdKids.length - 1].tag === 'svg' : null,
    // 追问行（纯结构化入参）不应有预览
    structuredPreview: rows.find((r) => (r.textContent || '').includes('追问'))?.querySelector('[data-tool-preview]')?.textContent ?? null
  }
})()
`)
check('队列渲染在输入卡片内', dom.inComposerCard, dom.queueText)
check('两条队列各带「现在发 / 编辑 / 删除」', dom.queueRows === 2 && dom.queueButtons.filter((l) => l === '删除').length === 2, dom.queueButtons.join(','))
const centers = new Set(dom.toolRowKids.map((k) => k.cy))
check('失败工具行各项垂直中心完全一致', dom.toolRowKids.length >= 4 && centers.size === 1, `${dom.toolRowKids.length} 项，中心集合 ${[...centers].join('/')}`)
check('失败工具行图标尺寸统一 size-4', dom.toolRowKids.filter((k) => k.tag === 'svg').every((k) => k.size === 'size-4'), dom.toolRowKids.filter((k) => k.tag === 'svg').map((k) => k.size).join('/'))

// ---------- 1b. 命令显示在工具名右侧（截断），执行状态仍在最右 ----------
check('execute_command 横条上显示命令', dom.previewText === LONG_CMD, dom.previewText)
check('长命令在横条上截断', dom.previewTruncated === true, `truncated=${dom.previewTruncated}`)
check('截断后不撑破消息区', dom.previewFitsColumn === true, `fitsColumn=${dom.previewFitsColumn}`)
check('状态图标仍在最右端（预览之后）', dom.cmdLastChildIsSvg === true, dom.cmdKids.map((k) => k.tag).join(' > '))
check('纯结构化入参不渲染 JSON 噪声预览', dom.structuredPreview === null, String(dom.structuredPreview))

// ---------- 2 + 3. 队列行为 ----------
// ⚠️ 先清空该会话队列：第 1 节为了验渲染往里排了两条，队列是**按会话**存的，
//    不清的话下面每条断言都会多出那两个条目（错得看不出跟被测逻辑有没有关系）。
await cdp.eval(`
(() => {
  const g = window.__store.getState()
  const cid = '${CONV_ID}'
  for (const m of [...(g.agentQueues[cid] || [])]) g.removeQueuedAgentMessage(m.id, cid)
  return 1
})()
`)
const behavior = await cdp.eval(`
(async () => {
  const get = () => window.__store.getState()
  const cid = '${CONV_ID}'
  const q = () => (get().agentQueues[cid] || []).map(m => m.text)
  const out = {}

  // 空闲 → 直接发一轮（无模型配置会落到 error，但**不能**进队列）
  await get().submitAgentMessage('空闲时直接发送', cid)
  await new Promise(r => setTimeout(r, 300))
  out.idleQueue = q()
  out.idleSent = get().agentConversations.find(c => c.id === cid).messages.some(m => m.role === 'user' && m.parts[0].text === '空闲时直接发送')

  // 流式中 → 入队
  window.__store.setState({ agentRuns: { ...get().agentRuns, [cid]: { streaming: true, requestId: 'r1', error: null } } })
  await get().submitAgentMessage('排队一', cid)
  await get().submitAgentMessage('排队二', cid)
  out.queued = q()

  // 流式中「现在发」必须被忽略（否则会开第二轮、把上一轮顶掉）
  await get().sendQueuedAgentMessage(get().agentQueues[cid][0].id, cid)
  out.afterSendWhileRunning = q()

  // 删除一条
  get().removeQueuedAgentMessage(get().agentQueues[cid][0].id, cid)
  out.afterRemove = q()

  // 空闲后 pump：弹出队首开新一轮
  window.__store.setState({ agentRuns: { ...get().agentRuns, [cid]: { streaming: false, requestId: null, error: null } } })
  get().pumpAgentQueue(cid)
  await new Promise(r => setTimeout(r, 300))
  out.afterPump = q()
  return out
})()
`)
check('空闲时 submit 直接发一轮（不入队）', behavior.idleQueue.length === 0 && behavior.idleSent)
check('流式中 submit 按顺序入队', JSON.stringify(behavior.queued) === JSON.stringify(['排队一', '排队二']), behavior.queued.join('/'))
check('流式中「现在发」被忽略', JSON.stringify(behavior.afterSendWhileRunning) === JSON.stringify(['排队一', '排队二']), behavior.afterSendWhileRunning.join('/'))
check('队列条目可删除', JSON.stringify(behavior.afterRemove) === JSON.stringify(['排队二']), behavior.afterRemove.join('/'))
check('空闲后 pump 弹出队首开新一轮', behavior.afterPump.length === 0, `剩 ${behavior.afterPump.length} 条`)

const cleared = await cdp.eval(`
(async () => {
  const get = () => window.__store.getState()
  const cid = '${CONV_ID}'
  window.__store.setState({ agentRuns: { ...get().agentRuns, [cid]: { streaming: false, requestId: null, error: null } } })
  get().enqueueAgentMessage('待删除会话的队列', cid)
  const before = (get().agentQueues[cid] || []).length
  await get().deleteAgentConversation(cid)
  return { before, after: get().agentQueues[cid] === undefined ? 'cleared' : get().agentQueues[cid].length }
})()
`)
check('删除会话连带清空队列', cleared.before === 1 && cleared.after === 'cleared', JSON.stringify(cleared))

// ---------- 3b. 手动停止 / 报错后队列暂停自动接续 ----------
// 直接驱动 store 的事件入口（不依赖真实模型）：这两个 bug 的根因都是
// 「收到 finish ≠ 本轮自然完成」—— 主进程在中止与报错路径末尾都会补发 finish。
// ⚠️ 上一个用例把会话删掉了，而 handleAgentEvent 要求会话存在（否则 pool 判空直接 return），
//    所以这里先重新播种。
await seed(cdp, { streaming: true })
const hold = await cdp.eval(`
(async () => {
  const get = () => window.__store.getState()
  const cid = '${CONV_ID}'
  const setRun = (patch) => window.__store.setState({
    agentRuns: { ...get().agentRuns, [cid]: { streaming: false, requestId: null, error: null, ...patch } }
  })
  const enqueue = (t) => get().enqueueAgentMessage(t, cid)
  const q = () => (get().agentQueues[cid] || []).map(m => m.text)
  const reqId = 'verify-queue-hold-req'
  const out = {}
  // 发一条流事件。
  //
  // ⚠️ 必须**每次**重新登记路由：handleAgentEvent 开头靠 agentRequestConversations
  // 反查会话，查不到就直接 return；而 finish / error 分支都会把这张表的条目删掉
  // （见 app-store.ts）。只登记一次的话，第二条往后的事件会被**静默丢弃** ——
  // 断言假失败，且失败原因跟被测逻辑无关，最容易把人带偏。
  //
  // （这里用行注释而非块注释，且注释里不写反引号：整段是嵌在外层模板字符串里的。）
  const fire = (event) => {
    window.__agentRequests.set(reqId, cid)
    get().handleAgentEvent(reqId, event)
  }

  // (1) 中止：finish('aborted') → 不接续
  setRun({ streaming: true })
  enqueue('中止-甲'); enqueue('中止-乙')
  fire({ type: 'finish', finishReason: 'aborted' })
  out.afterAbortedHold = get().agentRuns[cid].queueHold
  out.afterAbortedQueue = q()
  get().pumpAgentQueue(cid)               // 再泵一次也不该发
  out.afterAbortedPump = q()

  // (2) 报错：error 事件 + 收尾的 finish('error') → 不接续
  get().removeQueuedAgentMessage(get().agentQueues[cid][0].id, cid)
  setRun({ streaming: true })
  fire({ type: 'error', message: 'boom' })
  out.afterErrorHold = get().agentRuns[cid].queueHold
  fire({ type: 'finish', finishReason: 'error' })
  out.afterErrorFinishHold = get().agentRuns[cid].queueHold
  out.afterErrorQueue = q()
  get().pumpAgentQueue(cid)
  out.afterErrorPump = q()

  // (3) 自然结束 → 解除暂停，pump 照常接上
  setRun({ streaming: true })
  fire({ type: 'finish', finishReason: 'done' })
  out.afterDoneHold = get().agentRuns[cid].queueHold

  // (4) ACP 回放也发 finish('done')：不得借此解除暂停（否则「只是打开会话」就自动发队列）
  // 会话得临时标成 acp —— 回放的判定同时看 isAcp 与 acpLoading[cid]
  // （见 handleAgentEvent 的 wasReplay），种子会话是 mastra，
  // 不换过去这条就走成了普通 finish、断言失去意义。
  setRun({ streaming: true, queueHold: true })
  window.__store.setState({
    agentConversations: get().agentConversations.map(c => (c.id === cid ? { ...c, kind: 'acp' } : c)),
    acpLoading: { ...get().acpLoading, [cid]: true }
  })
  fire({ type: 'finish', finishReason: 'done' })
  out.afterReplayHold = get().agentRuns[cid].queueHold
  window.__store.setState({
    agentConversations: get().agentConversations.map(c => (c.id === cid ? { ...c, kind: 'mastra' } : c)),
    acpLoading: { ...get().acpLoading, [cid]: false }
  })

  // (5) 切会话不能绕过暂停（队列在内存里跨切会话活着）
  out.afterSelectQueue = (() => { get().pumpAgentQueue(cid); return q() })()
  return out
})()
`)
check('中止后 queueHold 置位且队列保留', hold.afterAbortedHold === true && hold.afterAbortedQueue.length === 2, JSON.stringify(hold.afterAbortedQueue))
check('中止后 pump 不接续', hold.afterAbortedPump.length === 2, `剩 ${hold.afterAbortedPump.length} 条`)
check('报错后 queueHold 置位', hold.afterErrorHold === true && hold.afterErrorFinishHold === true, `error=${hold.afterErrorHold} finish=${hold.afterErrorFinishHold}`)
check('报错后 pump 不接续', hold.afterErrorQueue.length === 1 && hold.afterErrorPump.length === 1, `剩 ${hold.afterErrorPump.length} 条`)
check('自然结束解除暂停', hold.afterDoneHold === false, String(hold.afterDoneHold))
check('ACP 回放的 finish done 不解除暂停', hold.afterReplayHold === true, String(hold.afterReplayHold))
check('切会话 / 再泵也不接续', hold.afterSelectQueue.length === 0, `剩 ${hold.afterSelectQueue.length} 条`)

// ---------- 3c. 用户真点「停止」：requestId 还没落地也必须停得住 ----------
// 3b 只驱动事件入口，没走 abortAgent；而用户遇到的正是 abortAgent 这条路：
// 主进程原先把准备阶段（MCP server 启动 / 估算 token / 上下文压缩）放在
// `agent:chat` **返回 requestId 之前**，那段时间界面已经是「运行中」，
// abortAgent 却因为拿不到 requestId 直接 return —— 既没中止、也没置 queueHold，
// 那一轮照跑到底，结束后把队列接着发出去。
// （主进程侧已改成准备阶段后台化、立即回 requestId；这里守住渲染端不依赖那件事。）
await seed(cdp, { streaming: true })
const gap = await cdp.eval(`
(async () => {
  const get = () => window.__store.getState()
  const cid = '${CONV_ID}'
  const reqId = 'verify-queue-gap-req'
  const setRun = (patch) => window.__store.setState({
    agentRuns: { ...get().agentRuns, [cid]: { streaming: false, requestId: null, error: null, ...patch } }
  })
  const q = () => (get().agentQueues[cid] || []).map(m => m.text)
  const out = {}
  const fire = (event) => { window.__agentRequests.set(reqId, cid); get().handleAgentEvent(reqId, event) }

  // 情形一：主进程还在准备，requestId 尚未交回来（streaming 已经是 true）
  setRun({ streaming: true, requestId: null })
  get().enqueueAgentMessage('空窗-甲', cid)
  get().enqueueAgentMessage('空窗-乙', cid)
  await get().abortAgent(cid)
  out.hold = get().agentRuns[cid].queueHold
  out.streaming = get().agentRuns[cid].streaming
  out.queue = q()
  get().pumpAgentQueue(cid)
  out.afterPump = q()

  // 情形二：中止生效前主进程已跑完并补发 finish('done')：不得撤销用户的暂停
  setRun({ streaming: true, requestId: null, queueHold: true })
  fire({ type: 'finish', finishReason: 'done' })
  out.holdAfterLateDone = get().agentRuns[cid].queueHold
  get().pumpAgentQueue(cid)
  out.queueAfterLateDone = q()
  return out
})()
`)
check('requestId 未落地时点停止：暂停置位、状态复位、队列保留', gap.hold === true && gap.streaming === false && gap.queue.length === 2, JSON.stringify(gap))
check('requestId 未落地时点停止：pump 不接续', gap.afterPump.length === 2, `剩 ${gap.afterPump.length} 条`)
check('停止后晚到的 finish done 不撤销暂停', gap.holdAfterLateDone === true && gap.queueAfterLateDone.length === 2, JSON.stringify(gap))

// ---------- 4. 思考展开体的贴底 / 上滚暂停 ----------
await seed(cdp, { streaming: true })
const longText = Array.from({ length: 40 }, (_, i) => `第 ${i + 1} 行思考内容 ${'x'.repeat(40)}`).join('\n')
await cdp.eval(`
(() => {
  const get = window.__store.getState()
  const msgs = get.agentConversations.find(c => c.id === '${CONV_ID}').messages.map(m => ({
    ...m, parts: m.parts.map(p => p.type === 'reasoning' ? { ...p, text: ${JSON.stringify(longText)} } : p)
  }))
  window.__store.setState({ agentConversations: get.agentConversations.map(c => c.id === '${CONV_ID}' ? { ...c, messages: msgs } : c) })
  return 1
})()
`)
await sleep(1200)
const bodyGap = () => cdp.eval(`
(() => {
  const body = document.querySelector('[class*="group/row"] div[style*="overflow-anchor"]')
  return body ? { top: Math.round(body.scrollTop), gap: Math.round(body.scrollHeight - body.scrollTop - body.clientHeight), anchor: getComputedStyle(body).overflowAnchor } : null
})()
`)
await cdp.eval(`
(() => {
  const get = window.__store.getState()
  const text = ${JSON.stringify(longText + '\n又来一行。')}
  const msgs = get.agentConversations.find(c => c.id === '${CONV_ID}').messages.map(m => ({ ...m, parts: m.parts.map(p => p.type === 'reasoning' ? { ...p, text } : p) }))
  window.__store.setState({ agentConversations: get.agentConversations.map(c => c.id === '${CONV_ID}' ? { ...c, messages: msgs } : c) })
  return 1
})()
`)
await sleep(700)
const afterGrow = await bodyGap()
check('思考展开体随内容增长贴底（spring 进行中 gap 很小）', afterGrow !== null && afterGrow.gap <= 6 && afterGrow.anchor === 'none', JSON.stringify(afterGrow))

await cdp.eval(`(() => { const b = document.querySelector('[class*="group/row"] div[style*="overflow-anchor"]'); b.scrollTop = 0; b.dispatchEvent(new Event('scroll')); return 1 })()`)
await sleep(400)
await cdp.eval(`(() => {
  const get = window.__store.getState()
  const text = ${JSON.stringify(longText + '\n又来一行。\n再来一行。')}
  const msgs = get.agentConversations.find(c => c.id === '${CONV_ID}').messages.map(m => ({ ...m, parts: m.parts.map(p => p.type === 'reasoning' ? { ...p, text } : p) }))
  window.__store.setState({ agentConversations: get.agentConversations.map(c => c.id === '${CONV_ID}' ? { ...c, messages: msgs } : c) })
  return 1
})()`)
await sleep(700)
const afterEscape = await bodyGap()
check('用户上滚后不再被拽回底部', afterEscape !== null && afterEscape.top === 0, JSON.stringify(afterEscape))

await cdp.eval(`(() => { const b = document.querySelector('[class*="group/row"] div[style*="overflow-anchor"]'); b.scrollTop = b.scrollHeight; b.dispatchEvent(new Event('scroll')); return 1 })()`)
await sleep(400)
await cdp.eval(`
(() => {
  const get = window.__store.getState()
  const text = ${JSON.stringify(longText + '\n又来一行。\n再来一行。\n最后一行。')}
  const msgs = get.agentConversations.find(c => c.id === '${CONV_ID}').messages.map(m => ({ ...m, parts: m.parts.map(p => p.type === 'reasoning' ? { ...p, text } : p) }))
  window.__store.setState({ agentConversations: get.agentConversations.map(c => c.id === '${CONV_ID}' ? { ...c, messages: msgs } : c) })
  return 1
})()`)
await sleep(700)
const afterResume = await bodyGap()
check('滚回底部后恢复跟随', afterResume !== null && afterResume.gap <= 6, JSON.stringify(afterResume))

cdp.close()
const failed = report(checks)
process.exit(failed === 0 ? 0 : 1)
