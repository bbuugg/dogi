/**
 * 终端命令历史（services/terminal/history.ts）的持久化验证：
 * 不起 Electron，直接跑真源码 —— history.ts 不 import electron（落盘路径由 init 注入），
 * type-only 的 @shared/types import 会被 --experimental-strip-types 擦掉，纯 Node 可跑。
 *
 * 覆盖：空启动、去重置顶（重复执行刷新时间）、trim 与空串拒绝、超长截断、
 * 条数上限（最旧的先丢）、落盘文件内容、「重启」后再 init 读回一致、
 * 单条删除（含不存在静默）、清空后文件为空数组、损坏 / 非数组 / 坏条目文件的降级。
 *
 * 跑：node --experimental-strip-types scripts/verify-command-history.ts
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import {
  COMMAND_HISTORY_MAX,
  COMMAND_HISTORY_MAX_CHARS,
  CommandHistoryStore,
  commandHistory
} from '../src/main/services/terminal/history.ts'

const checks: string[] = []
const ok = (name: string) => {
  checks.push(name)
  console.log(`  ✓ ${name}`)
}

const dir = await mkdtemp(join(tmpdir(), 'dogi-cmd-history-'))
const filePath = join(dir, 'command-history.json')

try {
  // ---- 空启动（文件不存在） ----
  const store = new CommandHistoryStore()
  await store.init(filePath)
  assert.deepEqual(store.list(), [])
  ok('空启动：文件不存在时历史为空')

  // ---- 记录 + 落盘 ----
  const e1 = store.add('git status')
  assert.ok(e1 && e1.cmd === 'git status' && e1.ts > 0)
  await store.flush()
  const onDisk1 = JSON.parse(await readFile(filePath, 'utf8'))
  assert.deepEqual(onDisk1, [{ cmd: 'git status', ts: e1.ts }])
  ok('add 记录并落盘（JSON 数组、最新在前）')

  // ---- 去重置顶 + 时间刷新 ----
  store.add('ls -la')
  const bumpTs = Date.now() + 5
  const origNow = Date.now
  Date.now = () => bumpTs
  try {
    const again = store.add('git status')
    assert.ok(again && again.ts === bumpTs, '重复执行应刷新时间戳')
  } finally {
    Date.now = origNow
  }
  assert.deepEqual(
    store.list().map((e) => e.cmd),
    ['git status', 'ls -la']
  )
  ok('去重置顶：重复执行移到最前且只保留一条')

  // ---- trim / 空串 ----
  const trimmed = store.add('   npm run dev   ')
  assert.ok(trimmed && trimmed.cmd === 'npm run dev')
  assert.equal(store.add('   \t '), null)
  assert.equal(store.list().length, 3)
  ok('trim 后记录；纯空白拒绝且不改变条数')

  // ---- 超长截断 ----
  const long = store.add('x'.repeat(COMMAND_HISTORY_MAX_CHARS + 500))
  assert.ok(long && long.cmd.length === COMMAND_HISTORY_MAX_CHARS)
  ok(`超长命令截断到 ${COMMAND_HISTORY_MAX_CHARS} 字符`)

  // ---- 条数上限：最旧的先丢 ----
  const before = store.list().map((e) => e.cmd)
  for (let i = 0; i < COMMAND_HISTORY_MAX; i++) store.add(`cmd-${i}`)
  assert.equal(store.list().length, COMMAND_HISTORY_MAX)
  assert.ok(store.list().some((e) => e.cmd === 'cmd-0'))
  assert.ok(!store.list().some((e) => e.cmd === before[0]), '最早的一条应被挤出')
  ok(`上限 ${COMMAND_HISTORY_MAX} 条：超限丢最旧的`)

  // ---- 「重启」：新实例从文件读回一致（先 flush，落盘链是异步的） ----
  await store.flush()
  const rebooted = new CommandHistoryStore()
  await rebooted.init(filePath)
  assert.deepEqual(rebooted.list(), store.list())
  ok('重启后再 init：从落盘文件读回一致')

  // ---- 单条删除 ----
  rebooted.remove('cmd-1')
  assert.ok(!rebooted.list().some((e) => e.cmd === 'cmd-1'))
  await rebooted.flush()
  const rebooted2 = new CommandHistoryStore()
  await rebooted2.init(filePath)
  assert.ok(!rebooted2.list().some((e) => e.cmd === 'cmd-1'))
  const sizeBeforeNoop = rebooted2.list().length
  rebooted2.remove('不存在的命令')
  assert.equal(rebooted2.list().length, sizeBeforeNoop)
  ok('remove 删除单条并落盘；不存在时静默不变')

  // ---- 清空 ----
  rebooted2.clear()
  await rebooted2.flush()
  assert.deepEqual(await readFile(filePath, 'utf8'), '[]')
  const afterClear = new CommandHistoryStore()
  await afterClear.init(filePath)
  assert.deepEqual(afterClear.list(), [])
  ok('clear：内存与文件都清空（文件为空数组）')

  // ---- 坏文件降级：损坏 JSON / 非数组 / 坏条目 ----
  await writeFile(filePath, '{oops')
  const corrupt = new CommandHistoryStore()
  await corrupt.init(filePath)
  assert.deepEqual(corrupt.list(), [])
  await writeFile(filePath, '{"a":1}')
  const nonArray = new CommandHistoryStore()
  await nonArray.init(filePath)
  assert.deepEqual(nonArray.list(), [])
  await writeFile(
    filePath,
    JSON.stringify([
      { cmd: 'ok', ts: 1 },
      { cmd: '   ', ts: 2 },
      { cmd: 'no-ts' },
      { nope: true },
      'plain-string'
    ])
  )
  const mixed = new CommandHistoryStore()
  await mixed.init(filePath)
  assert.deepEqual(mixed.list(), [{ cmd: 'ok', ts: 1 }])
  ok('坏文件降级：损坏 / 非数组 / 坏条目逐条校验，绝不抛错')

  // ---- 单例冒烟 ----
  assert.ok(Array.isArray(commandHistory.list()))
  ok('导出单例 commandHistory 可用')
} finally {
  await rm(dir, { recursive: true, force: true }).catch(() => {})
}

console.log(`\n全部通过：${checks.length} 项检查`)
