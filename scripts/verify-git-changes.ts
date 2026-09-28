/**
 * 源代码管理面板「更改」列表的数据验证：不起 Electron，直接跑主进程服务的真源码。
 *
 * 防两个坑（都会让面板只能显示「无可显示的差异」）：
 *   1. `git status --untracked-files=normal` 会把整个未跟踪目录折叠成 `dir/` 一条 ——
 *      面板上就是一个没内容、也没 diff 的「文件夹」，改的是目录下的一堆文件也看不出来。
 *      必须 `-uall`，把目录下每个文件各列一行（渲染端再折成目录树）。
 *   2. 未跟踪文件不在 git 的 index 里，`git diff -- path` 对它永远输出空。必须改用
 *      `--no-index` 跟空设备比，才能拿到「整份内容都是新增」的 diff。
 *
 * 跑：node --experimental-strip-types scripts/verify-git-changes.ts
 *（git.ts 只 import 类型与 node 内置模块，所以能直接跑，不需要打包）
 */

import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { getGitDiff, getGitStatus, listGitDir, runGitAction } from '../src/main/services/git.ts'

const run = (cwd: string, args: string[]): Promise<string> =>
  new Promise((resolve, reject) => {
    const p = spawn('git', args, { cwd, windowsHide: true })
    let out = ''
    let err = ''
    p.stdout.on('data', (d) => (out += d))
    p.stderr.on('data', (d) => (err += d))
    p.on('error', reject)
    p.on('close', (code) =>
      code === 0 ? resolve(out) : reject(new Error(`${args.join(' ')}: ${err || out}`))
    )
  })

const check = (label: string, ok: boolean): void => {
  assert.ok(ok, `FAIL: ${label}`)
  console.log(`  ok  ${label}`)
}

const dir = await mkdtemp(join(tmpdir(), 'dogi-git-changes-'))
try {
  await run(dir, ['init', '-q'])
  await run(dir, ['config', 'user.email', 'probe@local'])
  await run(dir, ['config', 'user.name', 'probe'])
  await writeFile(join(dir, 'tracked.txt'), 'v1\n')
  await run(dir, ['add', '.'])
  await run(dir, ['commit', '-qm', 'init'])

  // 用户报告的场景：一个还没被跟踪的新目录（里面多个文件、还有子目录）+ 一个已跟踪文件的改动
  await writeFile(join(dir, 'tracked.txt'), 'v2\n')
  await mkdir(join(dir, 'newdir', 'sub'), { recursive: true })
  await writeFile(join(dir, 'newdir', 'a.txt'), 'hello a\n')
  await writeFile(join(dir, 'newdir', 'sub', 'b.txt'), 'hello b\n')

  const st = await getGitStatus(dir)

  check('识别为 git 仓库', st.isRepo === true)
  const paths = st.changes.map((c) => c.path)
  console.log(`      变更条目：${paths.join(', ')}`)
  check(
    '未跟踪目录被摊平成目录下的每个文件',
    paths.includes('newdir/a.txt') &&
      paths.includes('newdir/sub/b.txt') &&
      paths.includes('tracked.txt')
  )
  check('没有「以 / 结尾的折叠目录」条目', !paths.some((p) => p.endsWith('/')))

  const newDiff = await getGitDiff(dir, 'newdir/a.txt', false)
  console.log(`      未跟踪文件 diff 首行：${JSON.stringify(newDiff.split('\n')[0] ?? '')}`)
  check('未跟踪文件能拿到「整份新增」的 diff', newDiff.includes('+hello a'))
  check('未跟踪文件的 diff 是新增形式（不显示为删除）', !newDiff.includes('-hello a'))

  const modDiff = await getGitDiff(dir, 'tracked.txt', false)
  check('已跟踪文件的改动 diff 仍正常', modDiff.includes('-v1') && modDiff.includes('+v2'))

  // ---------- 目录条目：未跟踪的嵌套仓库（git 即使 -uall 也不往里走）----------
  // 用户报告的坑：这种条目在列表里显示成「没有名字的文件行」。它必须是一条带尾斜杠的
  // `nested/`，渲染端才知道那是目录；回退要能递归删掉它（unlink 对目录会失败）。
  await mkdir(join(dir, 'nested'), { recursive: true })
  await run(join(dir, 'nested'), ['init', '-q'])
  await writeFile(join(dir, 'nested', 'inner.txt'), 'inner\n')

  const withNested = await getGitStatus(dir)
  const nestedEntry = withNested.changes.find((c) => c.path === 'nested/')
  console.log(`      嵌套仓库条目：${JSON.stringify(nestedEntry?.path ?? null)}`)
  check('未跟踪的嵌套仓库输出成带尾斜杠的目录条目', nestedEntry !== undefined)
  check('目录条目没有 diff（返回空，不按文件处理）', (await getGitDiff(dir, 'nested/', false)) === '')

  const listed = await listGitDir(dir, 'nested/')
  console.log(`      目录条目内容：${listed.join(', ')}`)
  check('能列出目录条目里的文件（跳过 .git，仅供展示）', listed.length === 1 && listed[0] === 'inner.txt')

  // 预览必须有上限：整目录列全会让「更改」区看起来像几百条改动（用户以为面板崩了）
  for (let i = 0; i < 30; i++) {
    await writeFile(join(dir, 'nested', `many-${String(i).padStart(2, '0')}.txt`), 'x\n')
  }
  const capped = await listGitDir(dir, 'nested/')
  check(`目录条目预览有上限（31 个文件只返回 ${capped.length} 项）`, capped.length === 20)

  await runGitAction(dir, { action: 'rollback', path: 'nested/', mode: 'worktree' })
  const afterRollback = await getGitStatus(dir)
  check(
    '回退能递归删掉整个未跟踪目录',
    !afterRollback.changes.some((c) => c.path.startsWith('nested'))
  )

  console.log('\nALL PASS')
} finally {
  await rm(dir, { recursive: true, force: true })
}
