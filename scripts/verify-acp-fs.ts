/**
 * ACP 客户端文件访问（`services/ai/acp-fs.ts`）验证：不起 Electron，直接跑真源码。
 *
 * 这两个能力是 ACP agent（opencode 等）读写文件必须的：我们在 initialize 里广告了
 * `fs` 能力，agent 就会发 `fs/read_text_file` / `fs/write_text_file`；此前两个 handler
 * 都没实现，agent 侧收到的是 `RequestError: "Method not found": fs/write_text_file`
 * （用户报告，opencode 写文件时那一轮直接失败）。
 *
 * 另一条不能破的底线：**只允许工作区内的路径** —— agent 是外部进程，不能借这条通道
 * 读写工作区外的文件。
 *
 * 跑：node --experimental-strip-types scripts/verify-acp-fs.ts
 */

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  readWorkspaceTextFile,
  resolveInsideWorkspace,
  writeWorkspaceTextFile
} from '../src/main/services/ai/acp-fs.ts'

const check = (label: string, ok: boolean): void => {
  assert.ok(ok, `FAIL: ${label}`)
  console.log(`  ok  ${label}`)
}

/** 断言这段访问**必须被拒绝**（抛错），返回错误信息 */
const mustReject = async (label: string, run: () => Promise<unknown>): Promise<void> => {
  try {
    await run()
  } catch (err) {
    console.log(`  ok  ${label}（${err instanceof Error ? err.message : String(err)}）`)
    return
  }
  assert.fail(`FAIL: ${label} —— 竟然放行了`)
}

const root = await mkdtemp(join(tmpdir(), 'dogi-acp-fs-'))
try {
  // ---------- 正常读写 ----------
  await writeWorkspaceTextFile(root, 'sub/dir/a.txt', 'line1\nline2\nline3\n')
  check(
    '写文件：工作区内相对路径，父目录自动创建',
    (await readWorkspaceTextFile(root, 'sub/dir/a.txt')) === 'line1\nline2\nline3\n'
  )

  // ACP 实际发过来的是绝对路径
  const abs = join(root, 'abs.txt')
  await writeWorkspaceTextFile(root, abs, 'abs-content')
  check('绝对路径落在工作区内时放行', (await readWorkspaceTextFile(root, abs)) === 'abs-content')

  await writeWorkspaceTextFile(root, 'sub/dir/a.txt', 'v2')
  check(
    '覆盖写：同路径再写一次取最新内容',
    (await readWorkspaceTextFile(root, 'sub/dir/a.txt')) === 'v2'
  )

  // ---------- 行范围（ACP 的 line 是 1-based，limit 是行数）----------
  await writeWorkspaceTextFile(root, 'lines.txt', 'l1\nl2\nl3\nl4\n')
  check('line + limit 按行截取', (await readWorkspaceTextFile(root, 'lines.txt', 2, 2)) === 'l2\nl3')
  check('只给 line：读到末尾', (await readWorkspaceTextFile(root, 'lines.txt', 3)) === 'l3\nl4\n')
  check('line 超出范围：返回空串', (await readWorkspaceTextFile(root, 'lines.txt', 99)) === '')

  // ---------- 越界必须拒绝 ----------
  await mustReject('拒绝 ../ 逃出工作区', () => readWorkspaceTextFile(root, '../outside.txt'))
  await mustReject('拒绝工作区外的绝对路径（写）', () =>
    writeWorkspaceTextFile(root, join(tmpdir(), 'dogi-acp-outside.txt'), 'x')
  )
  await mustReject('拒绝工作区根目录本身', async () => resolveInsideWorkspace(root, root))
  await mustReject('拒绝绝对前缀相同但实际是兄弟目录的路径', async () =>
    resolveInsideWorkspace(root, `${root}-sibling/x.txt`)
  )
  await mustReject('拒绝路径里的 .. 绕过（子目录回跳）', async () =>
    resolveInsideWorkspace(root, 'sub/../../x.txt')
  )

  console.log('\nALL PASS')
} finally {
  await rm(root, { recursive: true, force: true })
}
