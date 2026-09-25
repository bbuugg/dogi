/**
 * Agent 的「状态反馈」验证，分两段（隔离 Electron 实例 + CDP）：
 *
 * A. 系统通知：应用在前台时**不打扰**；关掉通知开关时不发；最小化（不在前台）后
 *    真正走通「渲染端凑内容 → 主进程判定 → 系统通知」整条链（主进程日志里能看到决策）。
 *    ⚠️ 会真的弹 1 条系统通知（这正是被测行为）；跑完记得看任务栏。
 * B. 会话列表状态图标：会话名左侧在「运行中」时转圈、在「等用户回答」时显示提问图标、
 *    空闲时回到普通图标；等回答优先级高于运行中。
 *
 * 跑：node scripts/verify-agent-status.mjs（在项目根目录执行）
 * ⚠️ 用独立的 --user-data-dir 起实例，不碰用户常驻的那个。
 */
import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

const PORT = 9333
const OUT_DIR = '.workbuddy-ai/shots'
const userData = join(tmpdir(), 'dogi-status-cdp')
const wsPath = join(tmpdir(), 'dogi-status-ws')
const logPath = join(OUT_DIR, 'agent-status.log')

const check = (label, ok) => {
  assert.ok(ok, `FAIL: ${label}`)
  console.log(`  ok  ${label}`)
}

await fs.rm(wsPath, { recursive: true, force: true })
await fs.mkdir(wsPath, { recursive: true })
// 每轮用干净的应用配置：否则上一次跑留下的会话会累积，store 里的「当前会话」
// 未必是本次新建的那个（断言会漂到别的会话上）
await fs.rm(userData, { recursive: true, force: true })
await fs.mkdir(OUT_DIR, { recursive: true })
// 每轮清空日志：断言的是「这一次运行里主进程怎么决策的」
await fs.writeFile(logPath, '', 'utf8')

const log = await fs.open(logPath, 'a')
const child = spawn(
  'node_modules/electron/dist/electron.exe',
  [
    '.',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${userData}`,
    '--no-sandbox',
    '--in-process-gpu',
    '--disable-gpu-sandbox'
  ],
  { stdio: ['ignore', log.fd, log.fd], detached: true }
)
child.unref()

const readLog = () => fs.readFile(logPath, 'utf8')

async function pageTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page
    } catch {
      // 还没起来
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error('没有等到可调试的页面')
}

const page = await pageTarget()
const socket = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.onopen = resolve
  socket.onerror = reject
})

let msgId = 0
const pending = new Map()
socket.onmessage = (event) => {
  const msg = JSON.parse(event.data)
  const entry = pending.get(msg.id)
  if (!entry) return
  pending.delete(msg.id)
  msg.error ? entry.reject(new Error(JSON.stringify(msg.error))) : entry.resolve(msg.result)
}
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++msgId
    pending.set(id, { resolve, reject })
    socket.send(JSON.stringify({ id, method, params }))
  })

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'evaluate 失败')
  return r.result.value
}

const finish = async (code) => {
  try {
    socket.close()
  } catch {
    // 忽略
  }
  try {
    process.kill(child.pid)
  } catch {
    // 已退出
  }
  await log.close()
  process.exit(code)
}

try {
  await new Promise((r) => setTimeout(r, 1500))

  // ---------- 准备一个工作区（会自动带一个会话）并切到 Agent 页 ----------
  const setup = await evaluate(`
    (async () => {
      await window.__store.getState().saveAgentWorkspace({ name: 'status-ws', path: ${JSON.stringify(wsPath)} })
      const s = window.__store.getState()
      window.__store.setState({ ui: { ...s.ui, activeActivity: 'agent', sidebarCollapsed: false } })
      const conv = window.__store.getState().agentConversations.find((c) => c.workspaceId === s.activeAgentWorkspaceId)
      await window.__store.getState().renameAgentConversation(conv.id, '状态演示会话')
      return { cid: conv.id }
    })()
  `)
  check('准备工作区与会话', !!setup.cid)

  // ---------- B. 会话列表状态图标 ----------
  console.log('\n[B] 会话列表状态图标')
  await new Promise((r) => setTimeout(r, 900))

  const iconState = () =>
    evaluate(`
      (() => ({
        asking: document.querySelectorAll('[title="等待你的回答"]').length,
        running: document.querySelectorAll('[title="正在运行"]').length,
        spinning: document.querySelectorAll('[title="正在运行"] .animate-spin').length,
        plain: document.querySelectorAll('.lucide-message-square').length
      }))()
    `)

  const idle = await iconState()
  check('空闲时是普通会话图标（没有转圈 / 提问）', idle.plain >= 1 && idle.running === 0 && idle.asking === 0)

  // 造「运行中」：直接把运行态灌进 store（真实场景由 sendAgentMessage 建立）
  await evaluate(`
    (() => {
      const cid = ${JSON.stringify(setup.cid)}
      const s = window.__store.getState()
      window.__store.setState({
        agentRuns: { ...s.agentRuns, [cid]: { streaming: true, requestId: 'req-fake', error: null } }
      })
      return true
    })()
  `)
  await new Promise((r) => setTimeout(r, 500))
  const running = await iconState()
  check('运行中显示 loading 图标（带旋转动画）', running.running === 1 && running.spinning === 1)
  check('运行中不再显示普通图标', running.plain === 0)

  // 造「等用户回答」：该会话当前请求上挂着一张提问卡
  await evaluate(`
    (() => {
      const s = window.__store.getState()
      window.__store.setState({
        followupRequests: {
          'tc-1': {
            id: 'f-1',
            requestId: 'req-fake',
            toolCallId: 'tc-1',
            questions: [{ question: '要部署到哪个环境？', header: '环境', options: ['预发', '生产'] }]
          }
        }
      })
      return true
    })()
  `)
  await new Promise((r) => setTimeout(r, 500))
  const asking = await iconState()
  check('等回答时显示提问图标', asking.asking === 1)
  check('等回答优先于运行中（不再转圈）', asking.running === 0 && asking.spinning === 0)

  // 浅色截图（等回答这一态最有信息量）
  await send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: 'light' }]
  })
  await new Promise((r) => setTimeout(r, 600))
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  await fs.writeFile(join(OUT_DIR, 'agent-sidebar-status.png'), Buffer.from(shot.data, 'base64'))
  console.log(`  ok  截图已落盘 ${OUT_DIR}/agent-sidebar-status.png`)

  // 清空后再回到普通图标
  await evaluate(`
    (() => {
      const cid = ${JSON.stringify(setup.cid)}
      const s = window.__store.getState()
      window.__store.setState({
        agentRuns: { ...s.agentRuns, [cid]: { streaming: false, requestId: null, error: null } },
        followupRequests: {}
      })
      return true
    })()
  `)
  await new Promise((r) => setTimeout(r, 500))
  const back = await iconState()
  check('结束 / 回答后回到普通图标', back.plain >= 1 && back.running === 0 && back.asking === 0)

  // ---------- A. 系统通知 ----------
  console.log('\n[A] 系统通知')

  // A1. 应用在前台：不打扰（这条最常发生，错了会天天弹通知）
  const focused = await evaluate(`
    window.api.app.notify({ title: '前台不该弹', body: 'x' })
  `)
  check('应用在前台时 notify 返回 false（不发通知）', focused === false)
  check('主进程日志记录了跳过原因', (await readLog()).includes('应用在前台，跳过通知'))

  // A2. 关掉通知开关
  await evaluate(`window.api.prefs.save({ notifyOnAgentFinish: false })`)
  const muted = await evaluate(`window.api.app.notify({ title: '开关关了不该弹', body: 'x' })`)
  check('通知开关关闭时不发通知', muted === false)
  check('主进程日志记录了开关原因', (await readLog()).includes('通知开关已关闭'))
  await evaluate(`window.api.prefs.save({ notifyOnAgentFinish: true })`)

  /** 等主进程日志里出现某段文本（最多 10s） */
  const waitLog = async (needle) => {
    for (let i = 0; i < 20; i++) {
      const text = await readLog()
      if (text.includes(needle)) return text
      await new Promise((r) => setTimeout(r, 500))
    }
    return readLog()
  }

  // A3. 真跑一轮对话（隔离实例没配 AI 模型，必然走 error → finish(error)）：
  //     先在前台验证「渲染端确实会在 finish 时请求通知」，但它被前台判定挡下
  await fs.writeFile(logPath, '', 'utf8')
  await evaluate(`window.__store.getState().sendAgentMessage('你好')`)
  const frontLog = await waitLog('[notify]')
  if (!frontLog.includes('应用在前台')) {
    // 失败时把「事件到底有没有落到渲染端」打出来，省得只剩一句断言失败
    const diag = await evaluate(`
      (() => {
        const s = window.__store.getState()
        const conv = s.agentConversations.find((c) => c.id === ${JSON.stringify(setup.cid)})
        return {
          run: s.agentRuns[${JSON.stringify(setup.cid)}],
          parts: (conv?.messages ?? []).map((m) => m.role + ':' + m.parts.map((p) => p.type).join(','))
        }
      })()
    `)
    console.error('  诊断：', JSON.stringify(diag))
    console.error(`  主进程日志：\n${frontLog.slice(-500)}`)
  }
  // 注意 console.log 多参数之间会插一个空格（'跳过通知：' + ' ' + 标题），别按整句比对
  check(
    '一轮结束后渲染端确实发起了通知请求（前台被挡下）',
    frontLog.includes('应用在前台，跳过通知') && frontLog.includes('Agent 执行出错')
  )

  // A4. 最小化（不在前台）→ 同一轮流程应该真的发出系统通知
  await fs.writeFile(logPath, '', 'utf8')
  await evaluate(`window.api.window.minimize()`)
  await new Promise((r) => setTimeout(r, 1200))
  await evaluate(`window.__store.getState().sendAgentMessage('再试一次')`)
  const noticeLog = await waitLog('[notify]')
  if (!noticeLog.includes('已发送系统通知')) console.error(`  主进程日志：\n${noticeLog.slice(-600)}`)
  check(
    '最小化（不在前台）时一轮结束真的发出了系统通知',
    noticeLog.includes('已发送系统通知') && noticeLog.includes('Agent 执行出错')
  )

  console.log('\nALL PASS')
  await finish(0)
} catch (err) {
  console.error(`\n${err.stack ?? err}`)
  await finish(1)
}
