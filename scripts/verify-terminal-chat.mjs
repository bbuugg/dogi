/**
 * 终端 AI 助手「并入统一 agent 引擎」后的全链路验证（隔离实例 + CDP + 进程内 mock LLM）。
 *
 * 这轮重构把终端助手从**独立引擎**（services/ai/ai.ts，已删）并到工作区 Agent 的
 * `AgentService` 上，附带三件事，逐条验：
 *
 *   1. **存储边界**：终端会话落在独立的 `terminal-conversations/` 目录，
 *      **绝不进 agentConversations / AI Agent 侧边栏**（靠存储边界保证，不靠消费方过滤）；
 *   2. **作用域**：`agent:chat` 带 `scope:'terminal'` → 工具集是终端那组
 *      （run_in_terminal / send_keys / read_terminal_output / list_terminal_sessions），
 *      **工作区工具一个都不在**；
 *   3. **客户端工具（A 方案）**：定义随请求携带 → 主进程挂起广播 `clientTools:invoke`
 *      → 渲染端执行（权限按 aiSettings 判定）→ `clientTools:result` 回填，
 *      **同一个请求内**模型循环继续（不是客户端另起一次请求）。
 *
 * mock LLM 是进程内 OpenAI 兼容 SSE 服务器（openai-compatible + chat-completions
 * 走的是 deepseek 的 chat 实现，见 resolve-model.ts），按脚本逐次应答，
 * 并把**每次收到的请求体**记下来 —— 工具清单就是从那里断言的。
 *
 * 跑：先 `npm run build`，再
 *   node scripts/verify-terminal-chat.mjs
 */

import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { connect, sleep } from './lib/cdp.mjs'

const CDP_PORT = 9371
const userData = join(tmpdir(), 'dogi-terminal-chat-probe')
const LOG = join(tmpdir(), 'dogi-terminal-chat-probe.log')

let pass = 0
let fail = 0
const check = (label, ok, extra) => {
  if (ok) {
    pass++
    console.log('  ok  ' + label)
  } else {
    fail++
    console.log('  FAIL ' + label + (extra ? ' :: ' + String(extra).slice(0, 400) : ''))
  }
}

// ─────────────────────────── mock LLM（OpenAI 兼容 SSE） ───────────────────────────

/** 收到的每次请求（断言工具清单用） */
const requests = []
/** 按脚本逐次应答：数组下标 = 本次应答的序号（setScript 每次把游标归零） */
let script = []
let cursor = 0
let callIndex = 0
const setScript = (blocks) => {
  script = blocks
  cursor = 0
}

const chunk = (delta, finish = null) => ({
  id: 'chatcmpl-mock',
  object: 'chat.completion.chunk',
  created: Math.floor(Date.now() / 1000),
  model: 'mock-model',
  choices: [{ index: 0, delta, finish_reason: finish }]
})

/** 一条助手正文 */
const say = (text) => chunk({ role: 'assistant', content: text }, 'stop')
/** 一次工具调用（deepseek 的 chat 实现吃标准 OpenAI 的 tool_calls 增量） */
const callTool = (id, name, args) =>
  chunk(
    {
      tool_calls: [
        { index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }
      ]
    },
    'tool_calls'
  )
/** usage 收尾块（AI SDK 会读它填 token 统计） */
const usage = () => ({
  id: 'chatcmpl-mock',
  object: 'chat.completion.chunk',
  created: Math.floor(Date.now() / 1000),
  model: 'mock-model',
  choices: [],
  usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 }
})

const mockServer = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    if (!/\/chat\/completions$/.test(req.url ?? '')) {
      res.writeHead(404).end('{}')
      return
    }
    let parsed = {}
    try {
      parsed = JSON.parse(body)
    } catch {
      /* 探针不关心解析失败，请求体照样记下来 */
    }
    const n = callIndex++
    requests.push({ url: req.url, body: parsed, toolNames: (parsed.tools ?? []).map((t) => t.function?.name) })
    const blocks = script[cursor++] ?? [say('（脚本用尽，兜底文本）')]
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive'
    })
    for (const b of [...blocks, usage()]) res.write('data: ' + JSON.stringify(b) + '\n\n')
    res.write('data: [DONE]\n\n')
    res.end()
  })
})
await new Promise((r) => mockServer.listen(0, '127.0.0.1', r))
const mockPort = mockServer.address().port
const mockBase = `http://127.0.0.1:${mockPort}/v1`
console.log(`mock LLM: ${mockBase}`)

// ─────────────────────────── 启动隔离实例 ───────────────────────────

await fs.rm(userData, { recursive: true, force: true }).catch(() => {})
const logHandle = await fs.open(LOG, 'a')
let child = null

async function launch() {
  child = spawn(
    'node_modules/electron/dist/electron.exe',
    [
      '.',
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${userData}`,
      '--no-sandbox',
      '--in-process-gpu',
      '--disable-gpu-sandbox'
    ],
    { stdio: ['ignore', logHandle.fd, logHandle.fd], detached: true }
  )
  child.unref()
}

async function waitReady(cdp) {
  const start = Date.now()
  for (;;) {
    if ((await cdp.eval('!!(window.__store && window.__store.getState().shells !== null)')) === true) break
    if (Date.now() - start > 40000) throw new Error('等待 bootstrap 超时')
    await sleep(250)
  }
  // 隔离实例的首次 loadFile 不提交首帧（AGENTS.md 5.1）：必须 bringToFront + reload
  await cdp.bringToFront()
  await cdp.reload()
  await sleep(2500)
}

async function shutdown() {
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    try {
      child.kill('SIGKILL')
    } catch {
      /* 已经退了 */
    }
  }
  await sleep(1200)
}

/** 轮询直到 fn 返回真值（返回该值），超时抛错 */
async function until(cdp, expr, timeoutMs = 25000, label = expr) {
  const start = Date.now()
  for (;;) {
    const v = await cdp.eval(expr)
    if (v) return v
    if (Date.now() - start > timeoutMs) throw new Error(`等待超时：${label}`)
    await sleep(200)
  }
}

const state = (cdp, expr) => cdp.eval(`(() => { const s = window.__store.getState(); return (${expr}) })()`)

let cdp = null
try {
  await launch()
  cdp = await connect({ port: CDP_PORT })
  await waitReady(cdp)

  // ── 准备：模型配置指向 mock LLM + 开一个本地终端 + 开 AI 面板 ──
  await cdp.eval(`(async () => {
    const cfg = {
      id: 'probe-cfg', name: 'mock', kind: 'openai-compatible',
      apiKey: 'test', baseURL: ${JSON.stringify(mockBase)},
      model: 'mock-model', models: ['mock-model'], apiStyle: 'chat-completions'
    }
    await window.api.ai.saveConfig(cfg)
    const st = window.__store.getState()
    await st.refreshAiConfigs()
    await st.refreshAiSettings()
    await st.setActiveAiConfig('probe-cfg')
    await st.saveAiSettings({ permissionMode: 'full' })
    void st.createLocalSession()
    return 1
  })()`)
  const sessionId = await until(
    cdp,
    `(() => { const s = window.__store.getState().sessions.find(x => x.status === 'ready') ?? window.__store.getState().sessions[0]; return s ? s.id : null })()`,
    30000,
    '本地终端会话就绪'
  )
  await cdp.eval(
    `(() => { const st = window.__store.getState(); st.setSessionAiOpen(${JSON.stringify(sessionId)}, true); return 1 })()`
  )
  await sleep(600)
  // 面板自己会开草稿；这里等草稿就位（点开就能输入）
  const draftId = await until(
    cdp,
    `(() => { const s = window.__store.getState(); return s.terminalDrafts[${JSON.stringify(sessionId)}]?.id ?? null })()`,
    10000,
    '终端助手草稿'
  )
  check('打开 AI 面板自动开一个草稿会话（不落盘）', !!draftId, draftId)
  check(
    '草稿不进会话列表',
    (await state(cdp, 's.terminalConversations.length')) === 0,
    await state(cdp, 'JSON.stringify(s.terminalConversations.map(c=>c.id))')
  )

  // ── 1. 客户端工具回路（full 权限：直接执行，无确认卡） ──
  await cdp.eval(`(() => {
    window.__echoCalls = []
    window.__clientTools.register(
      {
        name: 'probe_ui_echo',
        description: '探针用的客户端工具：把入参回显到渲染端',
        inputSchema: { type: 'object', properties: { text: { type: 'string' } } }
      },
      async (input) => {
        window.__echoCalls.push(input)
        return 'echo:' + (input && input.text)
      }
    )
    return 1
  })()`)
  setScript([
    [callTool('call-echo-1', 'probe_ui_echo', { text: '你好' })],
    [say('客户端工具回显：你好')]
  ])
  const reqsBefore = requests.length
  await cdp.eval(
    `void window.__store.getState().sendTerminalMessage('用客户端工具回显一下', ${JSON.stringify(sessionId)})`
  )
  const convId = await until(
    cdp,
    `(() => { const s = window.__store.getState(); return s.terminalConversations[0]?.id ?? null })()`,
    25000,
    '草稿转正（进会话列表）'
  )
  check('发出首条消息后草稿转正、标题取消息', (await state(cdp, `s.terminalConversations[0].title`)) === '用客户端工具回显一下')
  await until(
    cdp,
    `(() => { const s = window.__store.getState(); return !s.agentRuns[${JSON.stringify(convId)}]?.streaming })()`,
    25000,
    '一轮跑完'
  )

  const toolNames = requests[reqsBefore]?.toolNames ?? []
  check('请求带上了终端作用域工具 run_in_terminal', toolNames.includes('run_in_terminal'), toolNames.join(','))
  check(
    '工作区工具不在终端工具集里（read_file / list_files 都缺席）',
    !toolNames.includes('read_file') && !toolNames.includes('list_files'),
    toolNames.join(',')
  )
  check('随请求携带的客户端工具进了工具集', toolNames.includes('probe_ui_echo'), toolNames.join(','))
  check(
    '同一请求内继续：模型第二轮（带工具结果）后才收尾',
    requests.length - reqsBefore === 2,
    `本轮请求数=${requests.length - reqsBefore}`
  )
  check('第二轮请求里带着客户端工具的结果', JSON.stringify(requests[reqsBefore + 1]?.body ?? {}).includes('echo:你好'))
  check('渲染端执行器被调用了一次', (await cdp.eval('JSON.stringify(window.__echoCalls)')) === '[{"text":"你好"}]', await cdp.eval('JSON.stringify(window.__echoCalls)'))
  const parts = await state(cdp, `JSON.stringify(s.terminalConversations.find(c=>c.id===${JSON.stringify(convId)}).messages.at(-1).parts)`)
  check('消息里有客户端工具的调用与结果', parts.includes('tool-call') && parts.includes('tool-result') && parts.includes('echo:你好'), parts)
  check('助手给出了收尾正文', parts.includes('客户端工具回显'), parts)
  check(
    'full 权限下没有弹确认框（权限在渲染端，full 直接放行）',
    (await cdp.eval(`!!document.querySelector('.ant-modal-confirm')`)) === false
  )

  // ── 2. 存储边界：终端会话落自己的目录，绝不进 agent 会话列表 ──
  const termList = await cdp.eval('window.api.agent.terminalConvs.list()')
  check('terminalConvs:list 能读回这条会话', (termList ?? []).some((c) => c.id === convId), JSON.stringify((termList ?? []).map((c) => c.id)))
  check('落盘的会话带着完整消息', (termList ?? []).find((c) => c.id === convId)?.messages?.length >= 2)
  const agentList = await cdp.eval('window.api.agent.listConversations()')
  check('agent 会话列表里没有终端会话', !(agentList ?? []).some((c) => c.id === convId), JSON.stringify((agentList ?? []).map((c) => c.id)))
  check(
    'store 的 agentConversations 里同样没有（侧边栏天然看不到）',
    (await state(cdp, `s.agentConversations.some(c => c.id === ${JSON.stringify(convId)})`)) === false
  )
  const files = await fs.readdir(join(userData, 'terminal-conversations')).catch(() => [])
  check('磁盘上是独立的 terminal-conversations 目录', files.length > 0, JSON.stringify(files))

  // ── 3. 终端工具真跑：run_in_terminal 写进真实 PTY ──
  setScript([
    [callTool('call-run-1', 'run_in_terminal', { command: 'echo DOGI_TERMINAL_CHAT_OK' })],
    [say('已在终端执行')]
  ])
  await cdp.eval(
    `void window.__store.getState().sendTerminalMessage('在终端里回显一个标记', ${JSON.stringify(sessionId)})`
  )
  await until(
    cdp,
    `(() => { const s = window.__store.getState(); return !s.agentRuns[${JSON.stringify(convId)}]?.streaming })()`,
    25000,
    'run_in_terminal 这一轮跑完'
  )
  try {
    await until(
      cdp,
      `(async () => ((await window.api.terminal.recentOutput(${JSON.stringify(sessionId)})) ?? '').includes('DOGI_TERMINAL_CHAT_OK'))()`,
      15000,
      '终端回显'
    )
  } catch (err) {
    // 诊断信息直接打出来：这一轮的工具结果最能说明问题（写失败 / 没写入 / 被确认卡挡住）
    console.log(
      '    [debug] 最后一轮 parts: ' +
        (await state(
          cdp,
          `JSON.stringify(s.terminalConversations.find(c=>c.id===${JSON.stringify(convId)}).messages.at(-1).parts)`
        ))
    )
    console.log(
      '    [debug] recentOutput: ' +
        ((await cdp.eval(`window.api.terminal.recentOutput(${JSON.stringify(sessionId)})`)) ?? '')
    )
    console.log(
      '    [debug] permissionMode: ' + (await state(cdp, 's.aiSettings.permissionMode'))
    )
    throw err
  }
  check('run_in_terminal 真的把命令写进了终端（回显出现在会话输出里）', true)

  // ── 3b. 超长输出走产物：给 id / 总长度，中段能用 read_tool_output 读回来 ──
  // 探针的终端是 PowerShell，直接喂它一条原生命令产出约 60000 字符，远超内联上限（12000）。
  // ⚠️ 不要再套 `powershell -NoProfile -Command "…"`：双引号里 `$_` 会被外层先展开，
  // 单引号里的 `"` 又会在组装原生参数行时被剥掉（两层壳各吃掉一层引号，实测都产不出内容）。
  const LONG_CMD = '1..3000 | ForEach-Object { "PADDED_${_}_END" }'
  setScript([
    [callTool('call-long-1', 'run_in_terminal', { command: LONG_CMD, waitMs: 20000 })],
    [say('输出很长，已落盘成产物')]
  ])
  await cdp.eval(
    `void window.__store.getState().sendTerminalMessage('跑一条输出很多行的命令', ${JSON.stringify(sessionId)})`
  )
  await until(
    cdp,
    `(() => { const s = window.__store.getState(); return !s.agentRuns[${JSON.stringify(convId)}]?.streaming })()`,
    40000,
    '超长输出这一轮跑完'
  )
  const inlineText = await state(
    cdp,
    `JSON.stringify(s.terminalConversations.find(c=>c.id===${JSON.stringify(convId)}).messages)`
  )
  check(
    '请求里带上了 read_tool_output 工具',
    requests.at(-1).toolNames.includes('read_tool_output'),
    requests.at(-1).toolNames.join(',')
  )
  // 产物指引是一段 JSON 字面量，而 inlineText 本身是 **JSON 字符串**（转义过一次），
  // 所以引号在文本里长成 `\"` —— 正则必须两边都容错，否则永远匹配不上。
  const GUIDANCE_RE = /\{\\?"id\\?":\\?"([a-z0-9-]{6,})\\?",\\?"offset\\?":/
  check(
    '工具结果给出了产物 id 与读取指引',
    GUIDANCE_RE.test(inlineText) && inlineText.includes('read_tool_output')
  )
  check(
    '内联里保留了开头与结尾',
    inlineText.includes('PADDED_1_END') && inlineText.includes('PADDED_3000_END')
  )
  check(
    '中段确实没进内联（否则这节没意义）',
    !inlineText.includes('PADDED_1500_END'),
    '中段出现在内联里了'
  )
  // ⚠️ 必须按产物指引里的 `{"id":"...","offset":…` 提取：整段 JSON 里
  // 消息自身的 id 也是 `"id":"<uuid>"`，宽松匹配会抓到第一条消息的 id。
  const artifactId = (inlineText.match(GUIDANCE_RE) ?? [])[1]
  check('解析出产物 id', !!artifactId, artifactId)

  if (artifactId) {
    setScript([
      [callTool('call-long-2', 'read_tool_output', { id: artifactId, offset: 3000, length: 20000 })],
      [say('已读完中段')]
    ])
    await cdp.eval(
      `void window.__store.getState().sendTerminalMessage('把中段读完', ${JSON.stringify(sessionId)})`
    )
    await until(
      cdp,
      `(() => { const s = window.__store.getState(); return !s.agentRuns[${JSON.stringify(convId)}]?.streaming })()`,
      30000,
      'read_tool_output 这一轮跑完'
    )
    const secondReq = JSON.stringify(requests.at(-1).body)
    // 正面证据取 PADDED_500_END（落在被内联掐掉的中段里，只可能来自 read_tool_output）。
    // ⚠️ 别用「某个行号不出现」当边界证据：这一轮请求里还带着上一轮的内联尾巴，
    // 里面的 PADDED_2500 本来就在。边界改断言读取头给出的下一个 offset。
    check(
      'read_tool_output 按 offset 把中段读回来了',
      secondReq.includes('PADDED_500_END') && secondReq.includes('offset=23000'),
      JSON.stringify({
        has500: secondReq.includes('PADDED_500_END'),
        nextOffset: /继续读请传 offset=(\d+)/.exec(secondReq)?.[1] ?? null
      })
    )
  }

  // ── 4. confirm 模式：确认在渲染端弹，拒绝对模型是一次正常结果 ──
  await cdp.eval(`void window.__store.getState().saveAiSettings({ permissionMode: 'confirm' })`)
  await sleep(500)
  setScript([
    [callTool('call-deny-1', 'probe_ui_echo', { text: '这次会被拒绝' })],
    [say('好的，我不重试了')]
  ])
  const reqsBefore2 = requests.length
  await cdp.eval(
    `void window.__store.getState().sendTerminalMessage('再来一次回显', ${JSON.stringify(sessionId)})`
  )
  await until(
    cdp,
    `!!document.querySelector('.ant-modal-confirm')`,
    20000,
    '渲染端权限确认框'
  )
  const modalTitle = await cdp.eval(`document.querySelector('.ant-modal-confirm-title')?.textContent ?? ''`)
  check('确认框由渲染端弹出且标题带工具名', modalTitle.includes('probe_ui_echo'), modalTitle)
  // 点「拒绝」（antd 给两个汉字按钮插空格，按去空白后的 textContent 匹配）
  await cdp.eval(`(() => {
    const btn = [...document.querySelectorAll('.ant-modal-confirm-btns button')]
      .find(b => b.textContent.replace(/\\s+/g, '') === '拒绝')
    if (!btn) return false
    btn.click()
    return true
  })()`)
  await until(
    cdp,
    `(() => { const s = window.__store.getState(); return !s.agentRuns[${JSON.stringify(convId)}]?.streaming })()`,
    25000,
    '被拒后这一轮仍要正常收尾'
  )
  const parts2 = await state(cdp, `JSON.stringify(s.terminalConversations.find(c=>c.id===${JSON.stringify(convId)}).messages.at(-1).parts)`)
  check('拒绝作为**正常工具结果**回给模型（不是报错）', parts2.includes('用户拒绝') && !parts2.includes('"isError":true'), parts2)
  check('被拒后执行器没跑', (await cdp.eval('window.__echoCalls.length')) === 1, await cdp.eval('JSON.stringify(window.__echoCalls)'))
  check('同一请求内继续（第二轮请求仍发生，模型看到了拒绝原因）', requests.length - reqsBefore2 === 2, `本轮请求数=${requests.length - reqsBefore2}`)
  check('第二轮请求里带着拒绝原因', JSON.stringify(requests[reqsBefore2 + 1]?.body ?? {}).includes('用户拒绝'))

  // ── 5. 界面：左侧会话列表 / 新开会话 / 删除 / 没有「清除历史」 ──
  const panelOpen = await cdp.eval(`!!document.querySelector('aside')`)
  check('AI 助手浮窗在终端页上渲染', panelOpen === true)
  // 卡片展开（默认最小化，只露输入条）→ 头部才有会话列表按钮
  await cdp.eval(`(() => {
    const st = window.__store.getState()
    st.setAiMinimized(${JSON.stringify(sessionId)}, false)
    return 1
  })()`)
  await sleep(500)
  await cdp.eval(`(() => {
    const btn = [...document.querySelectorAll('button')].find(b => b.title === '会话列表')
    if (!btn) return false
    btn.click()
    return true
  })()`)
  await until(cdp, `[...document.querySelectorAll('button')].some(b => b.textContent.includes('新开会话'))`, 8000, '左侧会话列表')
  check('左侧有「新开会话」入口', true)
  // 断言只能证明结构，配色 / 对齐 / 图标位置得靠眼睛（AGENTS.md 5.1）
  await cdp.emulateColorScheme('dark')
  await sleep(400)
  await cdp.screenshot(join(tmpdir(), 'dogi-terminal-chat-list.png'))
  // 会话行用属性选择器定位：class 里的 '/' 在 CSS 选择器中要转义，用 [class*=] 更省事
  const ROWS = `[...document.querySelectorAll('[class*="group/item"]')]`
  const listTitles = await cdp.eval(`${ROWS}.map(r => r.firstElementChild?.textContent ?? '').join('|')`)
  check('会话列表列出已落盘的会话', listTitles.includes('用客户端工具回显一下'), listTitles)
  check(
    '面板里没有「清除历史」入口（已移除，改成逐条删除）',
    (await cdp.eval(`[...document.querySelectorAll('button')].some(b => /清除历史|清空历史/.test(b.textContent + b.title))`)) === false
  )

  const draftsBefore = await state(cdp, `Object.keys(s.terminalDrafts).length`)
  await cdp.eval(`(() => {
    const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('新开会话'))
    btn.click()
    return 1
  })()`)
  await sleep(500)
  check(
    '点「新开会话」开的是草稿（不进列表、只是切指针）',
    (await state(cdp, `s.terminalConversations.length`)) === 1 &&
      (await state(cdp, `s.terminalDrafts[${JSON.stringify(sessionId)}]?.id`)) !== convId,
    `drafts=${draftsBefore} convs=${await state(cdp, 's.terminalConversations.length')}`
  )
  check('草稿不出现在左侧列表里', (await cdp.eval(`${ROWS}.length`)) === 1, await cdp.eval(`${ROWS}.length`))

  // 逐条删除：Popconfirm → 确认
  await cdp.eval(`(() => {
    const row = document.querySelector('[class*="group/item"]')
    row?.querySelector('[aria-label="删除会话"]')?.click()
    return 1
  })()`)
  await until(cdp, `!!document.querySelector('.ant-popconfirm')`, 8000, '删除确认框')
  await cdp.eval(`(() => {
    const btn = [...document.querySelectorAll('.ant-popconfirm-buttons button')]
      .find(b => b.textContent.replace(/\\s+/g, '') === '删除')
    if (!btn) return false
    btn.click()
    return true
  })()`)
  await until(cdp, `window.__store.getState().terminalConversations.length === 0`, 10000, '会话已删除')
  check('逐条删除把会话从列表与落盘里一起去掉', true)
  const termList2 = await cdp.eval('window.api.agent.terminalConvs.list()')
  check('删除后磁盘上也没有了', !(termList2 ?? []).some((c) => c.id === convId), JSON.stringify((termList2 ?? []).map((c) => c.id)))

  // ── 6. 重启后仍在（真的落盘了） ──
  // 重新发一轮留下会话，再重启实例读回
  await cdp.eval(
    `(() => { const st = window.__store.getState(); st.newTerminalConversation(${JSON.stringify(sessionId)}); return 1 })()`
  )
  await sleep(400)
  setScript([[say('重启前留下的会话')]])
  await cdp.eval(
    `void window.__store.getState().sendTerminalMessage('重启前留一句', ${JSON.stringify(sessionId)})`
  )
  const convId2 = await until(
    cdp,
    `(() => { const s = window.__store.getState(); return s.terminalConversations[0]?.id ?? null })()`,
    25000,
    '第二条会话'
  )
  await until(
    cdp,
    `(() => { const s = window.__store.getState(); return !s.agentRuns[${JSON.stringify(convId2)}]?.streaming })()`,
    25000,
    '第二轮跑完'
  )
  await cdp.eval(`(() => { window.__clientTools.unregister('probe_ui_echo'); return 1 })()`)
  await shutdown()
  await launch()
  cdp.close()
  cdp = await connect({ port: CDP_PORT })
  await waitReady(cdp)
  const afterRestart = await cdp.eval('window.api.agent.terminalConvs.list()')
  check('重启后终端会话仍在', (afterRestart ?? []).some((c) => c.id === convId2), JSON.stringify((afterRestart ?? []).map((c) => c.id)))
  check(
    '重启后仍然是终端会话，不会出现在 agent 列表里',
    !(await cdp.eval('window.api.agent.listConversations()')).some((c) => c.id === convId2)
  )
  check(
    '客户端工具注册表是内存态：重启后不再上报',
    ((await cdp.eval('window.__clientTools.list()')) ?? []).length === 0,
    JSON.stringify(await cdp.eval('window.__clientTools.list()'))
  )
} catch (err) {
  fail++
  console.log('  FAIL 探针异常：' + (err?.stack ?? err))
} finally {
  if (cdp) cdp.close()
  await shutdown()
  mockServer.close()
  await logHandle.close()
  await fs.rm(userData, { recursive: true, force: true }).catch(() => {})
}

console.log(`\n===== 通过 ${pass} / 失败 ${fail} =====`)
process.exit(fail === 0 ? 0 : 1)
