/**
 * Agent 会话「模型选择」的持久化验证（真启动两次应用，同一个 userData 目录）。
 *
 * 用户报告：每个会话设置的模型，重启应用后恢复成默认。根因是 **modelId 在整条落盘链路上
 * 都缺**（store 的 persistConversation → preload → ipc → storage.saveAgentConversation），
 * 会话里换的模型永远写不进磁盘；重启后只剩 configId，于是回退成「配置的默认模型」。
 *
 * 覆盖四条（第 2 条是 AGENTS 4.3 特别强调的覆盖语义，最容易回归）：
 *   1. 保存时带 modelId → 读得回来；
 *   2. 不带 modelId 再存一次（改标题、每轮结束落盘）→ **必须保留旧值**（`in` 语义，不是清空）；
 *   3. 显式传 `modelId: undefined` → 才允许清空；
 *   4. 重启后仍在（真的落盘了，不是只活在内存里）。
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

  const saved = await cdp.eval(`window.api.agent.saveConversation({
    workspaceId: 'w-probe',
    title: '探针会话',
    messages: [],
    backend: 'acp',
    configId: 'acp-1',
    modelId: 'airouter/deepseek-flash'
  })`)
  check('新建会话返回的 modelId 正确', saved?.modelId === 'airouter/deepseek-flash')
  check('新建会话返回的 configId / backend 正确', saved?.configId === 'acp-1' && saved?.backend === 'acp')

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
    backend: 'acp',
    configId: 'acp-2',
    modelId: 'm-after-restart'
  })`)
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
    '重启后 backend / configId 也在',
    reopened?.backend === 'acp' && reopened?.configId === 'acp-2'
  )

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
