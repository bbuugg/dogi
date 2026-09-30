/**
 * Agent 会话「形态 / 模型选择」的持久化验证（真启动两次应用，同一个 userData 目录）。
 *
 * 起因一（AGENTS 4.3）：每个会话设置的模型，重启应用后恢复成默认 —— 根因是 **modelId 在
 * 整条落盘链路上都缺**（store 的 persistConversation → preload → ipc → storage），
 * 会话里换的模型永远写不进磁盘。
 *
 * 起因二（本轮架构调整）：会话形态从「工作区 / 会话各一个 backend」改成
 * **每个会话固定 `kind: 'mastra' | 'acp'`**，ACP 会话多出绑定关系（acpAgentId + acpSessionId），
 * 且**消息由 agent 自己管理、本地一律不存**。这些都是「只写不读回」的落盘语义，最容易回归。
 *
 * 覆盖：
 *   1. 保存时带 modelId → 读得回来（mastra）；
 *   2. 不带 modelId 再存一次（改标题、每轮结束落盘）→ **必须保留旧值**（`in` 语义，不是清空）；
 *   3. 显式传 `modelId: undefined` → 才允许清空；
 *   4. ACP 会话：kind / acpAgentId / acpSessionId 落盘，**messages 一律为空**（哪怕传了消息）；
 *   5. 重启后以上各项仍在（真的落盘了，不是只活在内存里）。
 *
 * 跑：node scripts/verify-agent-conversation-model.mjs（需先 npm run build 出产物）
 */

import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { connect, sleep } from './lib/cdp.mjs'

const CDP_PORT = 9366
const userData = join(tmpdir(), 'dogi-conv-model-probe')
const LOG = join(tmpdir(), 'dogi-conv-model-probe.log')

const check = (label, ok) => {
  assert.ok(ok, `FAIL: ${label}`)
  console.log(`  ok  ${label}`)
}

/** 两次启动共用同一个日志句柄（显式 close，别让它挂在 GC 上） */
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

async function waitReady(cdp) {
  const start = Date.now()
  for (;;) {
    if ((await cdp.eval('!!(window.__store && window.__store.getState().shells !== null)')) === true) return
    if (Date.now() - start > 30000) throw new Error('等待 bootstrap 超时')
    await sleep(250)
  }
}

const byId = async (cdp, id) =>
  (await cdp.eval('window.api.agent.listConversations()') ?? []).find((c) => c.id === id)

let child = null
let cdp = null
try {
  await fs.rm(userData, { recursive: true, force: true })

  // ---------- 第一次启动 ----------
  child = await launch()
  cdp = await connect({ port: CDP_PORT })
  await waitReady(cdp)

  // --- mastra 会话：形态 + 模型配置 + 具体模型 ---
  const saved = await cdp.eval(`window.api.agent.saveConversation({
    workspaceId: 'w-probe',
    title: '探针会话',
    messages: [],
    kind: 'mastra',
    configId: 'cfg-1',
    modelId: 'airouter/deepseek-flash'
  })`)
  check('新建会话返回的 kind / modelId 正确', saved?.kind === 'mastra' && saved?.modelId === 'airouter/deepseek-flash')
  check('新建会话返回的 configId 正确', saved?.configId === 'cfg-1')

  check(
    'listConversations 能读回 modelId',
    (await byId(cdp, saved.id))?.modelId === 'airouter/deepseek-flash'
  )

  // 模拟「改标题 / 一轮结束落盘」：不带 modelId
  await cdp.eval(`window.api.agent.saveConversation({
    id: ${JSON.stringify(saved.id)},
    workspaceId: 'w-probe',
    title: '改过名了',
    messages: []
  })`)
  const afterTitle = await byId(cdp, saved.id)
  check('不带 modelId 保存时保留旧值（in 语义）', afterTitle?.modelId === 'airouter/deepseek-flash')
  check('标题确实改了（确认这次保存真的生效）', afterTitle?.title === '改过名了')

  // 显式清空
  await cdp.eval(`window.api.agent.saveConversation({
    id: ${JSON.stringify(saved.id)},
    workspaceId: 'w-probe',
    configId: undefined,
    modelId: undefined
  })`)
  const cleared = await byId(cdp, saved.id)
  check('显式传 undefined 才清空 modelId / configId', cleared?.modelId === undefined && cleared?.configId === undefined)

  // 设回去，准备重启验证
  await cdp.eval(`window.api.agent.saveConversation({
    id: ${JSON.stringify(saved.id)},
    workspaceId: 'w-probe',
    kind: 'mastra',
    configId: 'cfg-2',
    modelId: 'm-after-restart'
  })`)

  // --- ACP 会话：绑定关系落盘、消息不由本应用管理 ---
  const acp = await cdp.eval(`window.api.agent.saveConversation({
    workspaceId: 'w-probe',
    title: '导入的 ACP 会话',
    kind: 'acp',
    acpAgentId: 'agent-1',
    acpSessionId: 'sess-abc',
    messages: [{ id: 'x', role: 'user', parts: [{ type: 'text', text: '不该被存下来' }], createdAt: 1 }]
  })`)
  check('ACP 会话 kind / acpAgentId 正确', acp?.kind === 'acp' && acp?.acpAgentId === 'agent-1')
  check('ACP 会话 acpSessionId 正确', acp?.acpSessionId === 'sess-abc')
  check('ACP 会话的消息不由本应用保存（messages 恒为空）', Array.isArray(acp?.messages) && acp.messages.length === 0)

  // 再存一次（不带 kind / 绑定）：形态与绑定都必须保留
  await cdp.eval(`window.api.agent.saveConversation({
    id: ${JSON.stringify(acp.id)},
    workspaceId: 'w-probe',
    title: '标题改了',
    messages: []
  })`)
  const acpAfter = await byId(cdp, acp.id)
  check(
    'ACP 会话不带 kind 保存时仍是 acp，绑定也保留',
    acpAfter?.kind === 'acp' && acpAfter?.acpAgentId === 'agent-1' && acpAfter?.acpSessionId === 'sess-abc'
  )

  cdp.close()
  cdp = null
  process.kill(child.pid)
  child = null
  await sleep(2000)

  // ---------- 第二次启动（同一个 userData）----------
  child = await launch()
  cdp = await connect({ port: CDP_PORT })
  await waitReady(cdp)

  const reopened = await byId(cdp, saved.id)
  check('重启后能按 id 找回会话', !!reopened)
  check('重启后 modelId 仍在（真的落盘了）', reopened?.modelId === 'm-after-restart')
  check(
    '重启后 kind / configId 也在',
    reopened?.kind === 'mastra' && reopened?.configId === 'cfg-2'
  )

  const reopenedAcp = await byId(cdp, acp.id)
  check('重启后 ACP 会话仍在且仍是 acp', reopenedAcp?.kind === 'acp')
  check('重启后 ACP 绑定仍在', reopenedAcp?.acpSessionId === 'sess-abc' && reopenedAcp?.acpAgentId === 'agent-1')
  check('重启后 ACP 会话依然没有本地消息', (reopenedAcp?.messages ?? []).length === 0)

  console.log('\nALL PASS')
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
