/**
 * AI Agent 侧边栏与 ACP 会话「登记 → 新建/导入 → 回放」的界面链路验证
 * （隔离实例 + CDP，见 AGENTS 5.1 / 4.3 / 4.18）。
 *
 * 没有真实的 ACP CLI 也能把两侧契约钉住：
 *   - 工作区行尾只有一个「更多操作」下拉，里面有 导入会话 / 新建会话 / 重命名 / 删除；
 *   - 设置 → ACP agent 里能手工登记 agent（会话页的模型来源就是它勾选的模型）；
 *   - **新建的会话形态待定**：选了内置模型 → 标识变成内置；预置/选中 ACP agent → 标识是该 agent；
 *   - 主进程下发的 `history` 事件能渲染成消息流，且 ACP 会话不提供「编辑重发 / 从这里重新开始」；
 *   - 会话页的模型下拉只列「设置里勾选的 ACP 模型」，且下拉宽度被限死（长模型名不再撑宽工具行）。
 *
 * 跑：node scripts/verify-agent-acp-import.mjs（需先 npm run build 出产物）
 */

import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect, sleep } from './lib/cdp.mjs'

const CDP_PORT = 9377
const userData = join(tmpdir(), 'dogi-acp-import-probe')
const LOG = join(tmpdir(), 'dogi-acp-import-probe.log')
/** 验证用的工作区目录：用仓库自己（只做只读操作，不会改文件） */
const WORKSPACE = process.cwd().replace(/\\/g, '/')

const failures = []
const check = (label, ok, extra) => {
  if (ok) {
    console.log(`  ok  ${label}`)
  } else {
    failures.push(label)
    console.error(`  FAIL ${label}${extra ? ` :: ${extra}` : ''}`)
  }
}

const logHandle = await fs.open(LOG, 'a')

async function launch() {
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
    { stdio: ['ignore', logHandle.fd, logHandle.fd], detached: true }
  )
  child.unref()
  return child
}

/** 轮询某个表达式直到为真（超时抛错并带上当前页面文本，便于定位） */
async function waitFor(cdp, expression, timeoutMs, label) {
  const start = Date.now()
  for (;;) {
    if ((await cdp.eval(`!!(${expression})`)) === true) return
    if (Date.now() - start > timeoutMs) {
      const body = await cdp.eval('document.body.innerText.slice(0, 300)').catch(() => '')
      throw new Error(`等待超时：${label}（当前页面：${String(body).slice(0, 200)}）`)
    }
    await sleep(200)
  }
}

async function waitReady(cdp) {
  const start = Date.now()
  for (;;) {
    if ((await cdp.eval('!!(window.__store && window.__store.getState().shells !== null)')) === true) break
    if (Date.now() - start > 30000) throw new Error('等待 bootstrap 超时')
    await sleep(250)
  }
  /**
   * ⚠️ 必须把页面带到前台：窗口在「隐藏 / 未激活」状态下 Chromium 不做首帧绘制，
   * React 的首次提交会一直挂着（表现是 DOM 全空、`button` 一个都查不到），
   * 而 store 里的状态却已经就绪 —— 只等 `window.__store` 是等不到界面出来的。
   *
   * ⚠️ 还要显式 reload 一次：隔离实例的**首次** loadFile 在这台机器上不提交首帧
   * （`#root` 一直是空的、控制台也没有任何报错），reload 之后一切正常。
   * 这是探针环境的特性，不是应用的 bug（用户常驻实例与 dev 都正常）。
   */
  await cdp.bringToFront()
  await cdp.send('Page.reload', { ignoreCache: true })
  await sleep(2500)
  await waitFor(cdp, 'document.querySelectorAll("button[title]").length > 0', 20000, '界面没有渲染出任何按钮')
}

/** 点一个菜单项 / 按钮（antd 会给两个汉字的按钮插空格，比对前先去空白） */
const clickByText = (scope, text) => `(function () {
  const btns = Array.from(document.querySelectorAll(${JSON.stringify(scope)}))
  // ⚠️ 模板字面量里的正则必须写 \\s：写 \s 的话求值前就被吃成 s（AGENTS 6.5 第 20 条）
  const hit = btns.find((b) => b.innerText.replace(/\\s/g, '') === ${JSON.stringify(text)})
  if (!hit) throw new Error('找不到可点元素：' + ${JSON.stringify(text)})
  hit.click()
})()`

/** 打开某个工作区行的「更多操作」下拉 */
const openWorkspaceMenu = `(function () {
  const btn = Array.from(document.querySelectorAll('button[title="更多操作"]'))[0]
  if (!btn) throw new Error('找不到「更多操作」按钮')
  btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
  btn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
})()`

const menuTexts = `Array.from(document.querySelectorAll('.ant-dropdown-menu-item')).map((i) => i.innerText.replace(/\\s/g, ''))`

let child = null
let cdp = null
try {
  await fs.rm(userData, { recursive: true, force: true })

  child = await launch()
  cdp = await connect({ port: CDP_PORT })
  await waitReady(cdp)

  // ---------- 准备：一个工作区 + 切到 AI Agent 功能区 ----------
  await cdp.eval(
    `window.api.agent.saveWorkspace({ name: 'probe-ws', path: ${JSON.stringify(WORKSPACE)} })`
  )
  await cdp.eval('window.__store.getState().loadAgentWorkspaces()')
  await sleep(600)
  await cdp.eval(`window.__store.getState().selectActivity('agent')`)
  await waitFor(
    cdp,
    `document.querySelectorAll('button[title="更多操作"]').length > 0`,
    10000,
    '工作区行没有渲染出来'
  )

  // ---------- 1. 工作区行的操作都收进「更多」下拉 ----------
  const staleButtons = await cdp.eval(
    `JSON.stringify(Array.from(document.querySelectorAll('button[title]')).map((b) => b.getAttribute('title')))`
  )
  check(
    '行尾不再平铺「导入会话 / 新建会话」等按钮',
    !/导入会话|新建会话|重命名工作区|删除工作区/.test(staleButtons),
    staleButtons
  )
  await cdp.eval(openWorkspaceMenu)
  await waitFor(cdp, `document.querySelectorAll('.ant-dropdown-menu-item').length > 0`, 5000, '下拉没展开')
  const items = await cdp.eval(menuTexts)
  check(
    '「更多」下拉里有 导入 / 新建会话 / 重命名 / 删除 四项',
    ['导入会话', '新建会话', '重命名工作区', '删除工作区'].every((t) => items.includes(t)),
    JSON.stringify(items)
  )
  await cdp.eval(`document.body.click()`)
  await sleep(400)

  // ---------- 2. 新建会话 = 打开「新建会话页」（草稿不进列表），形态待定 ----------
  /** 侧边栏里的会话行（草稿不进列表，所以它才是「列表里到底有几条会话」的真值） */
  const convRows = `Array.from(document.querySelectorAll('[data-conversation-id]'))`
  const rowsBefore = await cdp.eval(`${convRows}.length`)
  await cdp.eval(openWorkspaceMenu)
  await waitFor(cdp, `document.querySelectorAll('.ant-dropdown-menu-item').length > 0`, 5000, '下拉没展开')
  await cdp.eval(clickByText('.ant-dropdown-menu-item', '新建会话'))
  await sleep(700)

  const fresh = await cdp.eval(
    `window.__store.getState().agentConversations.find((c) => c.kind === undefined)?.id ?? null`
  )
  check('新建会话建出「形态待定」的会话页（kind 为 undefined）', !!fresh, String(fresh))
  const rowsAfter = await cdp.eval(`${convRows}.length`)
  check(
    '新建会话**不会**在列表里立刻多出一条空会话（草稿不进列表）',
    rowsAfter === rowsBefore,
    `${rowsBefore} -> ${rowsAfter}`
  )
  const draftPageText = await cdp.eval('document.body.innerText')
  check(
    '页面上说清了「发出第一条消息才建会话」',
    /选好模型后发出第一条消息/.test(draftPageText),
    draftPageText.slice(0, 120)
  )

  // 连点两次「新建会话」应当还是同一个空页（不攒看不见的草稿）
  await cdp.eval(openWorkspaceMenu)
  await waitFor(cdp, `document.querySelectorAll('.ant-dropdown-menu-item').length > 0`, 5000, '下拉没展开')
  await cdp.eval(clickByText('.ant-dropdown-menu-item', '新建会话'))
  await sleep(600)
  const draftCount = await cdp.eval(
    `window.__store.getState().agentConversations.filter((c) => c.kind === undefined).length`
  )
  check('同一工作区连点两次「新建会话」还是同一个空页', draftCount === 1, String(draftCount))

  // 选中一个内置模型：只写草稿的选择（形态要等首条消息才定；会话名右侧不再有类型标识）
  await cdp.eval(
    `window.__store.getState().setAgentConversationModel(${JSON.stringify(fresh)}, { configId: 'probe-cfg', modelId: 'probe-model' })`
  )
  await sleep(600)
  const drafted = await cdp.eval(
    `window.__store.getState().agentConversations.find((c) => c.id === ${JSON.stringify(fresh)}) ?? null`
  )
  check(
    '选中内置模型只写进草稿（configId / modelId 在、形态仍待定）',
    drafted?.configId === 'probe-cfg' && drafted?.modelId === 'probe-model' && drafted?.kind === undefined,
    JSON.stringify(drafted)?.slice(0, 160)
  )

  // 发出首条消息 = 草稿转正（标题取这条消息、形态落成 mastra、进列表 + 落盘）
  await cdp.eval(
    `window.__store.getState().sendAgentMessage('首条消息标题', ${JSON.stringify(fresh)})`
  )
  await sleep(2000)
  const allConversations = await cdp.eval('window.api.agent.listConversations()')
  const savedMastra = allConversations.find((c) => c.id === fresh)
  check(
    '未定形态 + 内置模型：首条消息落盘为 mastra',
    savedMastra?.kind === 'mastra' && savedMastra?.configId === 'probe-cfg',
    JSON.stringify(savedMastra)?.slice(0, 200)
  )
  check('会话名取自首条消息', savedMastra?.title === '首条消息标题', String(savedMastra?.title))
  const freshRow = await cdp.eval(
    `(document.querySelector('[data-conversation-id="${fresh}"]')?.innerText ?? '').replace(/\\s/g, '')`
  )
  check(
    '转正后出现在侧边栏列表里（且用的是同一个会话 id，标签不用重建）',
    /首条消息标题/.test(freshRow),
    freshRow
  )

  // ---------- 3. 导入弹窗：只保留 选 ACP → 拉取会话 → 导入；footer 有「ACP 设置」 ----------
  await cdp.eval(openWorkspaceMenu)
  await waitFor(cdp, `document.querySelectorAll('.ant-dropdown-menu-item').length > 0`, 5000, '下拉没展开')
  await cdp.eval(clickByText('.ant-dropdown-menu-item', '导入会话'))
  await waitFor(cdp, `!!document.querySelector('.ant-modal')`, 5000, '导入弹窗没打开')
  await sleep(700)
  let modal = await cdp.eval(`document.querySelector('.ant-modal').innerText.replace(/\\s/g, '')`)
  check('打开的是「导入会话」弹窗（标题带工作区名）', /导入会话·probe-ws/.test(modal), modal.slice(0, 80))
  // ⚠️ 断言看**按钮**而不是全文：提示文案里会提到「检测已安装 / 手动添加」（引导去设置页）
  const modalButtons = await cdp.eval(
    `Array.from(document.querySelector('.ant-modal').querySelectorAll('button')).map((b) => b.innerText.replace(/\\s/g, '')).join('|')`
  )
  check(
    '弹窗按钮只剩 ACP 设置 / 导入 / 取消（登记与新建都收敛走了）',
    /ACP设置/.test(modalButtons) &&
      /导入选中/.test(modalButtons) &&
      !/检测已安装|手动添加|新建会话/.test(modalButtons),
    modalButtons
  )
  check('没有登记 agent 时给出指向「ACP 设置」的提示', /还没有登记ACPagent/.test(modal), modal.slice(0, 160))

  // footer 的「ACP 设置」：打开设置弹窗并定位到 ACP agent 分组（导入弹窗保持打开）
  await cdp.eval(clickByText('.ant-modal-footer button', 'ACP设置'))
  await waitFor(cdp, `document.querySelectorAll('.ant-modal').length >= 2`, 5000, '设置弹窗没打开')
  await sleep(900)
  const settingsText = await cdp.eval(
    `Array.from(document.querySelectorAll('.ant-modal')).map((m) => m.innerText).join('\\n---\\n')`
  )
  check(
    '「ACP 设置」打开设置弹窗并定位到 ACP agent 分组（检测 / 新建配置都在）',
    /ACP agent/.test(settingsText) && /检测已安装/.test(settingsText),
    settingsText.slice(0, 200)
  )
  await cdp.eval(`window.__store.getState().setSettingsOpen(false)`)
  await sleep(600)

  // 登记 agent + 勾选模型（真实操作在设置页完成，这里直接写同一张表并刷新）。
  // ⚠️ Runtime.evaluate 按「脚本」求值，顶层 await 会语法报错 —— 必须包一层 async IIFE
  await cdp.eval(`(async () => {
    const s = await window.api.ai.getSettings()
    await window.api.ai.saveSettings({
      acpAgents: [
        ...(s.acpAgents ?? []).filter((a) => a.command !== 'smoke-acp'),
        {
          id: 'acp-smoke-1',
          name: 'Smoke ACP',
          command: 'smoke-acp',
          args: [],
          models: ['m-one', 'a-very-long-model-id-openrouter/anthropic/claude-4.5-sonnet:beta']
        }
      ]
    })
  })()`)
  await cdp.eval('window.__store.getState().refreshAiSettings()')
  await sleep(700)

  // 「拉取会话」：smoke-acp 并不存在，主进程起不来 → 弹窗里给出「没有可导入的会话」（有反馈，不静默）
  // 先在弹窗的 Select 里选中刚登记的 agent（拉取区只在选中 agent 后出现）
  await cdp.eval(`(function () {
    const sel = document.querySelector('.ant-modal .ant-select')
    sel.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    sel.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })()`)
  await waitFor(cdp, `document.querySelectorAll('.ant-select-item-option').length > 0`, 5000, 'agent 下拉没展开')
  await cdp.eval(`(function () {
    const opt = Array.from(document.querySelectorAll('.ant-select-item-option')).find((o) =>
      o.innerText.includes('Smoke ACP')
    )
    if (!opt) throw new Error('找不到 Smoke ACP 选项')
    opt.click()
  })()`)
  await sleep(600)
  await cdp.eval(clickByText('.ant-modal button', '拉取会话'))
  await sleep(2500)
  modal = await cdp.eval(`document.querySelector('.ant-modal').innerText.replace(/\\s/g, '')`)
  check('「拉取会话」对起不来的 agent 给出可感知的反馈', /该agent没有可导入的会话/.test(modal), modal.slice(0, 160))
  await cdp.eval(clickByText('.ant-modal-footer button', '取消'))
  await sleep(600)

  // ---------- 4. 新建 ACP 会话（真实路径）：新建会话 → 选该 agent 的模型 ----------
  await cdp.eval(`window.__store.getState().createAgentConversation()`)
  await sleep(600)
  const created = await cdp.eval(
    `window.__store.getState().agentConversations.find((c) => c.kind === undefined && !c.acpAgentId)?.id ?? null`
  )
  check(
    '上一条草稿转正后，「新建会话」能再开一个**新的**空页',
    !!created && created !== fresh,
    `${created} vs ${fresh}`
  )
  // 选里那个**很长的**模型 id：模型下拉的宽度断言才有意义（短名测不出「被限死」）
  await cdp.eval(
    `window.__store.getState().setAcpConversationModel(${JSON.stringify(created)}, { acpAgentId: 'acp-smoke-1', modelId: 'a-very-long-model-id-openrouter/anthropic/claude-4.5-sonnet:beta' })`
  )
  await sleep(600)
  const acpDraft = await cdp.eval(
    `window.__store.getState().agentConversations.find((c) => c.id === ${JSON.stringify(created)}) ?? null`
  )
  check(
    '未定会话选中 ACP 模型 = 预置 agent（类型由所选模型 / ACP agent 决定）',
    acpDraft?.acpAgentId === 'acp-smoke-1' && acpDraft?.kind === undefined && !acpDraft?.configId,
    JSON.stringify(acpDraft)?.slice(0, 160)
  )

  // ---------- 4. 模型下拉：只列设置里勾选的模型 + 宽度被限死 ----------
  // 会话页的模型下拉：`.bare-select.max-w-44`（宽度被限死的那个）。
  // ⚠️ 多标签并存时**每个标签都渲染一份**，必须取「可见」的那个 —— 隐藏标签里那份的选项
  // 是按它自己的会话算的（这里会是一个没有 AI 配置的 mastra 会话 → 暂无数据）
  const MODEL_SELECT = `(Array.from(document.querySelectorAll('.bare-select.max-w-44')).find((s) => s.offsetParent !== null) ?? null)`
  await cdp.eval(`(function () {
    const sel = ${MODEL_SELECT}
    if (!sel) throw new Error('找不到会话页的模型下拉')
    const targets = [sel, sel.querySelector('.ant-select-content')].filter(Boolean)
    for (const t of targets) {
      t.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      t.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    }
  })()`)
  await waitFor(cdp, `document.querySelectorAll('.ant-select-item-option').length > 0`, 5000, '模型下拉没有展开')
  const options = await cdp.eval(
    `Array.from(document.querySelectorAll('.ant-select-item-option')).map((o) => o.innerText).join('|')`
  )
  check('模型下拉列出设置里勾选的 ACP 模型', /m-one/.test(options), options)
  const selectWidth = await cdp.eval(`Math.round(${MODEL_SELECT}.getBoundingClientRect().width)`)
  check('模型下拉宽度被限死（长模型名不再撑宽工具行）', selectWidth <= 200, `${selectWidth}px`)
  await cdp.eval(`document.body.click()`)
  await sleep(300)

  // ---------- 5. 历史回放（模拟主进程下发）+ 折叠行为 + ACP 不可编辑 ----------
  const convId = created
  // ⚠️ 先发首条消息（此时还没有任何历史），再注入回放历史 —— 否则「已有历史不改名」
  // 的既有规则会让标题停在新会话上，测不出「会话名取自首条消息」
  await cdp.eval(`window.__store.getState().sendAgentMessage('rpc 首条', ${JSON.stringify(convId)})`)
  await sleep(2000)
  /**
   * 与主进程装配器产出的 parts 同形（见 4.18 / scripts/verify-acp-history.ts）：
   * - h2：思考 + 工具 → **正文** → 末尾两步工具 —— 用户报告里「正文被折进折叠条」的形态
   *   （正文后面还跟着工具，只按「末尾连续正文」算就会把整条消息折起来）；
   * - h3：纯思考 + 工具调用（没有正文）—— 整条折叠是正常形态，也不该出现复制按钮。
   */
  const historyFixture = [
    { id: 'h1', role: 'user', parts: [{ type: 'text', text: '历史里的用户问题' }], createdAt: 1 },
    {
      id: 'h2',
      role: 'assistant',
      parts: [
        { type: 'reasoning', text: '先读一下文件' },
        { type: 'tool-call', toolCallId: 'c0', toolName: 'Read', input: { path: 'a.ts' } },
        { type: 'tool-result', toolCallId: 'c0', toolName: 'Read', output: { ok: true } },
        { type: 'text', text: '历史里的助手回答' },
        { type: 'tool-call', toolCallId: 'c1', toolName: 'Edit', input: { path: 'a.ts' } },
        { type: 'tool-result', toolCallId: 'c1', toolName: 'Edit', output: { ok: true } },
        { type: 'tool-call', toolCallId: 'c2', toolName: 'Bash', input: { command: 'npm test' } },
        { type: 'tool-result', toolCallId: 'c2', toolName: 'Bash', output: { ok: true } }
      ],
      createdAt: 2
    },
    {
      id: 'h3',
      role: 'assistant',
      parts: [
        { type: 'reasoning', text: '先想一想' },
        { type: 'tool-call', toolCallId: 'c3', toolName: 'Bash', input: { command: 'ls' } },
        { type: 'tool-result', toolCallId: 'c3', toolName: 'Bash', output: { ok: true } }
      ],
      createdAt: 3
    }
  ]
  await cdp.eval(
    `window.__store.setState({ agentAcpMessages: { ${JSON.stringify(convId)}: ${JSON.stringify(historyFixture)} } })`
  )
  await sleep(900)
  const pageText = await cdp.eval('document.body.innerText')
  check(
    'session/load 回放出来的历史能渲染成消息流',
    /历史里的用户问题/.test(pageText) && /历史里的助手回答/.test(pageText)
  )

  // 折叠条是消息里的第一个 button；它后面那个 grid 就是折叠体（收起时高度 0，但内容仍在 DOM 里）
  const foldProbe = await cdp.eval(`(function () {
    const msg = document.querySelector('[data-message-id="h2"]')
    if (!msg) return { ok: false, why: '找不到 h2' }
    const bar = msg.querySelector('button')
    if (!bar) return { ok: false, why: 'h2 没有折叠条' }
    const body = bar.nextElementSibling
    return {
      ok: true,
      summary: bar.innerText.replace(/\\s/g, ''),
      textVisible: msg.innerText.includes('历史里的助手回答'),
      textHidden: body ? body.innerText.includes('历史里的助手回答') : null,
      copyButtons: msg.querySelectorAll('button[aria-label="复制原文（Markdown）"]').length
    }
  })()`)
  check(
    '末尾是工具调用时，正文**不会**被折进折叠条（用户报告）',
    foldProbe.ok && foldProbe.textVisible === true && foldProbe.textHidden === false,
    JSON.stringify(foldProbe)
  )
  check(
    '折叠条摘要给出被折起的过程（正文前那一步思考与工具）',
    /思考×1/.test(foldProbe.summary ?? '') && /工具调用×1/.test(foldProbe.summary ?? ''),
    String(foldProbe.summary)
  )
  check('有正文 ⇒ 复制按钮在（复制的正是可见的那段）', foldProbe.copyButtons === 1, String(foldProbe.copyButtons))

  const noTextProbe = await cdp.eval(`(function () {
    const msg = document.querySelector('[data-message-id="h3"]')
    if (!msg) return { ok: false }
    return {
      ok: true,
      summary: (msg.querySelector('button')?.innerText ?? '').replace(/\\s/g, ''),
      copyButtons: msg.querySelectorAll('button[aria-label="复制原文（Markdown）"]').length
    }
  })()`)
  check(
    '纯思考 + 工具调用：整条折叠（正常形态）且没有可复制的正文就不给复制按钮',
    noTextProbe.ok && /思考×1/.test(noTextProbe.summary) && noTextProbe.copyButtons === 0,
    JSON.stringify(noTextProbe)
  )

  const msgBtns = await cdp.eval(
    `Array.from(document.querySelectorAll('[data-message-id] button[title]')).map((b) => b.getAttribute('title')).join('|')`
  )
  check('ACP 会话不提供「编辑重发 / 从这里重新开始」', !/编辑|重新开始/.test(msgBtns), msgBtns)

  // ---------- 6. ACP 草稿转正：kind=acp、agent 绑定带上、消息不落盘、进列表 ----------
  const savedAcp = (await cdp.eval('window.api.agent.listConversations()')).find((c) => c.id === convId)
  check(
    '未定形态 + ACP 模型：首条消息落盘为 acp（agent 绑定带上）',
    savedAcp?.kind === 'acp' && !!savedAcp?.acpAgentId,
    JSON.stringify(savedAcp)?.slice(0, 200)
  )
  check('ACP 会话的消息仍然不落盘', (savedAcp?.messages ?? []).length === 0)
  const acpRow = await cdp.eval(
    `(document.querySelector('[data-conversation-id="${convId}"]')?.innerText ?? '').replace(/\\s/g, '')`
  )
  check('ACP 草稿转正后同样进列表（会话名取自首条消息）', /rpc首条/.test(acpRow), acpRow)
  const draftsLeft = await cdp.eval(
    `window.__store.getState().agentConversations.filter((c) => c.kind === undefined).length`
  )
  check('两条草稿都转正了，没有残留', draftsLeft === 0, String(draftsLeft))

  // ---------- 7. 设置 → ACP agent（模型来源就在这里勾选） ----------
  await cdp.eval(`window.__store.getState().setSettingsOpen(true, 'acp')`)
  await waitFor(cdp, `!!document.querySelector('.ant-modal')`, 5000, '设置弹窗没打开')
  await sleep(900)
  const settingsPageText = await cdp.eval(`document.querySelector('.ant-modal').innerText`)
  check(
    '设置页能打开「ACP agent」分组（检测 / 新建配置都在）',
    /ACP agent/.test(settingsPageText) && /检测已安装/.test(settingsPageText),
    settingsPageText.slice(0, 140)
  )
  check(
    '列出的 agent 带有已勾选的模型（会话页模型下拉的来源）',
    /Smoke ACP/.test(settingsPageText) && /m-one/.test(settingsPageText),
    settingsPageText.slice(0, 220)
  )
  // 关掉设置弹窗：下一节的右键菜单要用**真鼠标事件**悬停子菜单，遮罩不关会拦住鼠标
  await cdp.eval(`window.__store.getState().setSettingsOpen(false)`)
  await sleep(600)

  // ---------- 8. 标签右键菜单：一级只留「关闭标签」，其余关闭方式收进「关闭」二级 ----------
  // ⚠️ 右键也要用 CDP 真事件：合成 contextmenu 没有 clientX/Y，菜单会弹在 (0,0)，
  // 后续对子菜单的「真悬停」坐标全是错的
  const tabPos = await cdp.eval(`(() => {
    const el = document.querySelector('[data-tab-id]')
    if (!el) throw new Error('找不到标签')
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
  })()`)
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: tabPos.x,
    y: tabPos.y,
    button: 'right',
    clickCount: 1
  })
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: tabPos.x,
    y: tabPos.y,
    button: 'right',
    clickCount: 1
  })
  await waitFor(cdp, `document.querySelectorAll('.ant-dropdown-menu-item').length > 0`, 5000, '标签右键菜单没打开')
  // 根菜单 = 含「拆分」的那个 dropdown（子菜单的弹出层是单独的 portal，不在这里面）
  const tabMenu = await cdp.eval(`(function () {
    const root = Array.from(document.querySelectorAll('.ant-dropdown')).find(
      (d) => d.offsetParent !== null && d.innerText.includes('拆分')
    )
    if (!root) return { ok: false, why: '找不到根菜单' }
    const items = Array.from(root.querySelectorAll('.ant-dropdown-menu-item')).map((i) =>
      i.innerText.replace(/\\s/g, '')
    )
    const submenuTitles = Array.from(root.querySelectorAll('.ant-dropdown-menu-submenu-title')).map((t) =>
      t.innerText.replace(/\\s/g, '')
    )
    return { ok: true, items, submenuTitles }
  })()`)
  check(
    '右键菜单一级：有「关闭标签」，其余关闭方式不再平铺',
    tabMenu.ok &&
      tabMenu.items.includes('关闭标签') &&
      !['关闭其他标签', '关闭左侧标签', '关闭右侧标签', '关闭整个组'].some((t) => tabMenu.items.includes(t)) &&
      tabMenu.submenuTitles.includes('关闭'),
    JSON.stringify(tabMenu)
  )
  // 悬停「关闭」展开二级，四个子项都在。
  // ⚠️ 必须用 CDP 真鼠标事件：antd 的 hover 弹层走 React onMouseEnter（合成 mouseover 推不出来）
  const hoverPos = await cdp.eval(`(() => {
    const root = Array.from(document.querySelectorAll('.ant-dropdown')).find(
      (d) => d.offsetParent !== null && d.innerText.includes('拆分')
    )
    const title = Array.from(root.querySelectorAll('.ant-dropdown-menu-submenu-title')).find(
      (t) => t.innerText.replace(/\\s/g, '') === '关闭'
    )
    if (!title) return null
    const r = title.getBoundingClientRect()
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
  })()`)
  if (!hoverPos) throw new Error('找不到「关闭」子菜单标题')
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: hoverPos.x,
    y: hoverPos.y
  })
  await sleep(600)
  // ⚠️ 真鼠标移动在某些合成环境下推不出 React 的 onMouseEnter —— 直接对标题元素
  // 派发带 relatedTarget 的 mouseover（React 据此合成 title 上的 onMouseEnter）
  await cdp.eval(`(function () {
    const root = Array.from(document.querySelectorAll('.ant-dropdown')).find(
      (d) => d.offsetParent !== null && d.innerText.includes('拆分')
    )
    const title = Array.from(root.querySelectorAll('.ant-dropdown-menu-submenu-title')).find(
      (t) => t.innerText.replace(/\\s/g, '') === '关闭'
    )
    if (!title) throw new Error('找不到「关闭」子菜单标题')
    title.dispatchEvent(new MouseEvent('mouseover', {
      bubbles: true,
      cancelable: true,
      relatedTarget: document.body
    }))
  })()`)
  // ⚠️ antd 6 的子菜单弹出层类名是 `.ant-dropdown-menu-submenu-popup`
  //   （PopupTrigger 的 prefixCls = ant-dropdown-menu-submenu，不是老的 submenu-popup）
  await waitFor(
    cdp,
    `(() => {
      const popups = Array.from(document.querySelectorAll('.ant-dropdown-menu-submenu-popup'))
      return popups.some((p) => p.innerText.replace(/\\s/g, '').includes('关闭其他标签'))
    })()`,
    5000,
    '「关闭」二级菜单没展开'
  )
  const subItems = await cdp.eval(
    `(() => {
      const popup = Array.from(document.querySelectorAll('.ant-dropdown-menu-submenu-popup')).find((p) =>
        p.innerText.replace(/\\s/g, '').includes('关闭其他标签')
      )
      return Array.from(popup.querySelectorAll('.ant-dropdown-menu-item')).map((i) => i.innerText.replace(/\\s/g, '')).join('|')
    })()`
  )
  check(
    '「关闭」二级里有 关闭其他 / 关闭左侧 / 关闭右侧 / 关闭整个组',
    ['关闭其他标签', '关闭左侧标签', '关闭右侧标签', '关闭整个组'].every((t) => subItems.includes(t)),
    subItems
  )
  await cdp.eval(`document.body.click()`)
  await sleep(300)

  console.log(failures.length === 0 ? '\nSMOKE PASS' : `\nSMOKE FAIL: ${failures.join(' / ')}`)
  if (failures.length > 0) process.exitCode = 1
} catch (err) {
  console.error('\nFAIL:', err?.message ?? String(err))
  process.exitCode = 1
} finally {
  try {
    cdp?.close()
  } catch {
    // 忽略
  }
  try {
    if (child) process.kill(child.pid)
  } catch {
    // 已退出
  }
  await logHandle.close().catch(() => {})
  process.exit(process.exitCode ?? 0)
}
