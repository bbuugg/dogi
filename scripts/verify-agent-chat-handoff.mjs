/**
 * 「停止」能不能生效，取决于 `agent:chat` **多快**把 requestId 交回渲染端
 * （requestId 是中止的唯一把手）。主进程原先把准备阶段放在回包之前：
 * 扫技能目录 → 启动 MCP server → 估算 baseTokens → 按窗口压缩上下文 → 动态 import agent。
 * 开了 MCP 或触发了压缩时这段能到好几秒，那段时间界面已经是「运行中」，
 * 用户点停止没有 requestId 可中止 —— 请求照跑到底，还会把待发送队列接着发出去。
 *
 * 本探针用一个**故意慢**的本地 mock LLM（首个 token 延迟 6s）把这条窗口量化出来：
 * - `agent:chat` 的回包耗时必须远小于 mock 的首 token 延迟（= 准备阶段没挡住回包）；
 * - 回包后立刻 abort，本轮要在短时间内收尾（finish 事件），不留孤儿请求。
 *
 * 隔离实例 + CDP（见 AGENTS.md「验证工具链」）：
 *   MSYS_NO_PATHCONV=1 node_modules/electron/dist/electron.exe . \
 *     --remote-debugging-port=9333 --user-data-dir=<临时目录> \
 *     --no-sandbox --in-process-gpu --disable-gpu-sandbox
 *   node scripts/verify-agent-chat-handoff.mjs
 */
import { createServer } from 'node:http'
import { connect, sleep, report } from './lib/cdp.mjs'

const PORT = Number(process.env.DOGI_CDP_PORT ?? 9333)
const MOCK_PORT = Number(process.env.DOGI_MOCK_LLM_PORT ?? 8791)
/** mock 的首 token 延迟：必须**远大于**准备阶段的耗时，回包快慢才有判别力 */
const FIRST_TOKEN_DELAY_MS = 6000
/** 回包预算：超过它就说明准备阶段还在阻塞 invoke */
const HANDOFF_BUDGET_MS = 2000

const checks = []
const check = (name, ok, detail) => {
  checks.push([name, Boolean(ok)])
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

/** OpenAI 兼容的最小 mock：拖到 FIRST_TOKEN_DELAY_MS 才吐第一个 delta */
function startMockLlm() {
  const state = { requests: 0 }
  const server = createServer((req, res) => {
    if (!req.url?.startsWith('/v1/chat/completions')) {
      res.writeHead(404).end()
      return
    }
    state.requests += 1
    req.resume()
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      const tick = (n) => setTimeout(() => res.write(`data: ${JSON.stringify(n)}\n\n`), FIRST_TOKEN_DELAY_MS)
      tick({
        id: 'mock',
        object: 'chat.completion.chunk',
        model: 'mock',
        choices: [{ index: 0, delta: { role: 'assistant', content: '慢' } }]
      })
      tick({
        id: 'mock',
        object: 'chat.completion.chunk',
        model: 'mock',
        choices: [{ index: 0, delta: { content: '速' }, finish_reason: null }]
      })
      tick({
        id: 'mock',
        object: 'chat.completion.chunk',
        model: 'mock',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
      })
      tick({
        id: 'mock',
        object: 'chat.completion.chunk',
        model: 'mock',
        choices: [],
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 }
      })
      setTimeout(() => res.end('data: [DONE]\n\n'), FIRST_TOKEN_DELAY_MS + 50)
    })
  })
  return new Promise((resolve) => {
    server.listen(MOCK_PORT, '127.0.0.1', () => resolve({ server, state }))
  })
}

const { server, state } = await startMockLlm()
const cdp = await connect({ port: PORT })
try {
  await cdp.bringToFront()
  await cdp.reload(4000)
  await sleep(2000)

  // 注入一个指向本地 mock 的模型配置（走 preload 白名单，不需要重启实例）
  const injected = await cdp.eval(`
  (async () => {
    const now = Date.now()
    await window.api.ai.saveConfig({
      id: 'verify-chat-handoff', name: 'verify-chat-handoff', kind: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:${MOCK_PORT}/v1', apiKey: 'mock-key', model: 'mock-model',
      createdAt: now, updatedAt: now
    })
    const st = window.__store.getState()
    const WS = 'verify-handoff-ws', CID = 'verify-handoff-conv'
    window.__store.setState({
      agentWorkspaces: [...st.agentWorkspaces.filter(w => w.id !== WS), { id: WS, path: 'D:/workspace/dogi-probe', name: 'probe', createdAt: now, updatedAt: now }],
      agentConversations: [...st.agentConversations.filter(c => c.id !== CID), {
        id: CID, workspaceId: WS, kind: 'mastra', title: 'verify', createdAt: now, updatedAt: now, messages: []
      }],
      ui: { ...st.ui, activeActivity: 'agent' }
    })
    const configs = await window.api.ai.listConfigs()
    return { has: configs.some(c => c.id === 'verify-chat-handoff'), ws: WS, cid: CID }
  })()
`)
  check('模型配置注入成功', injected.has === true, JSON.stringify(injected))

  // ① `agent:chat` 的回包必须不等模型（否则「停止」在 prepare 窗口里按不住）
  const handoff = await cdp.eval(`
  (async () => {
    const t0 = Date.now()
    const res = await window.api.agent.chat({
      workspaceId: '${injected.ws}',
      conversationId: '${injected.cid}',
      kind: 'mastra',
      configId: 'verify-chat-handoff',
      history: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'handoff' }], createdAt: Date.now() }]
    })
    return { ms: Date.now() - t0, requestId: res.requestId }
  })()
`)
  check(
    'agent:chat 在准备阶段完成前就回包（requestId 立即可用）',
    typeof handoff.requestId === 'string' && handoff.ms < HANDOFF_BUDGET_MS,
    `回包耗时 ${handoff.ms}ms（mock 首 token ${FIRST_TOKEN_DELAY_MS}ms / 预算 ${HANDOFF_BUDGET_MS}ms）`
  )

  // ② 回包后立刻中止：本轮要在短时间内收尾，且**不能**等到 mock 吐 token 之后才结束
  const stopped = await cdp.eval(`
  (async () => {
    const t0 = Date.now()
    let finish = null
    const off = window.api.agent.onChatEvent(({ requestId, event }) => {
      if (requestId !== ${JSON.stringify(handoff.requestId)}) return
      if (event.type === 'finish') finish = { ms: Date.now() - t0, reason: event.finishReason }
    })
    window.api.agent.abort(${JSON.stringify(handoff.requestId)})
    for (let i = 0; i < 60 && !finish; i++) await new Promise(r => setTimeout(r, 100))
    off?.()
    return { finish, total: Date.now() - t0 }
  })()
`)
  check(
    '回包后立即中止能快速收尾（不用等 mock 的首 token）',
    stopped.finish !== null && stopped.finish.ms < HANDOFF_BUDGET_MS,
    JSON.stringify(stopped)
  )
  check('中止后 mock 没有留下挂住的请求', state.requests <= 2, `mock 收到 ${state.requests} 个请求`)

  // 收尾：把注入的配置删掉，别留在隔离实例的磁盘里
  await cdp.eval(`window.api.ai.deleteConfig('verify-chat-handoff'), 1`)
} finally {
  cdp.close()
  server.close()
}

const failed = report(checks)
process.exit(failed === 0 ? 0 : 1)