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
import { getGitBranches, getGitDiff, getGitStatus, listGitDir, runGitAction } from '../src/main/services/git.ts'

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

/** 断言「这个写操作会失败」，且报错里含指定的话（缺省只要失败即可） */
async function rejects(label: string, fn: () => Promise<unknown>, match?: RegExp): Promise<void> {
  let message = ''
  try {
    await fn()
  } catch (err) {
    message = err instanceof Error ? err.message : String(err)
  }
  assert.ok(message !== '', `FAIL: ${label} —— 本该报错，却成功了`)
  if (match) {
    assert.match(message, match)
  }
  console.log(`  ok  ${label}（${message.split('\n')[0].slice(0, 60)}）`)
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

  // ---------- 分支增删 ----------
  //
  // 面板的分支下拉里每行都有个垃圾桶，误点就是丢分支 —— 所以这里把「拦得住」的那些都钉住：
  // 当前分支不能删、没合并的不给强推就删不掉、名字非法直接报错。
  const branchesOf = async (): Promise<string[]> =>
    (await getGitBranches(dir)).branches
  const base = (await branchesOf())[0]

  await runGitAction(dir, { action: 'create-branch', name: 'feature/a' })
  check('新建分支并切过去', (await getGitStatus(dir)).branch === 'feature/a')

  // ⚠️ 必须在新分支上真的提交一次：刚建出来、还指着同一个提交的分支对 git 来说是
  // 「已合并」，`branch -d` 本来就该放行 —— 想验证「未合并拦得住」得先造出未合并的提交。
  await writeFile(join(dir, 'feat.txt'), 'feat\n')
  await run(dir, ['add', 'feat.txt'])
  await run(dir, ['commit', '-qm', 'feat'])
  await runGitAction(dir, { action: 'checkout', ref: base })
  check('切回基准分支', (await getGitStatus(dir)).branch === base)

  await rejects('不能删除当前所在的分支', () =>
    runGitAction(dir, { action: 'delete-branch', name: base })
  )

  // feature/a 上有 base 没有的提交：默认删不掉，且报错要指向面板上的「强制删除」勾选项
  await rejects(
    '未合并分支不给强推就删不掉（报错指向强制删除）',
    () => runGitAction(dir, { action: 'delete-branch', name: 'feature/a' }),
    /强制删除/
  )
  check('没删掉还在（失败即没生效）', (await branchesOf()).includes('feature/a'))
  await runGitAction(dir, { action: 'delete-branch', name: 'feature/a', force: true })
  check('勾了强制删除就能删（-D）', !(await branchesOf()).includes('feature/a'))

  await rejects('分支名以 - 开头被拒（否则会被 git 当成选项）', () =>
    runGitAction(dir, { action: 'create-branch', name: '-evil' })
  )
  await rejects('分支名含空格被拒', () =>
    runGitAction(dir, { action: 'delete-branch', name: 'has space' })
  )
  await rejects('删不存在的分支给出人话', () =>
    runGitAction(dir, { action: 'delete-branch', name: 'nope' }),
    /不存在/
  )

  // ---------- 远端增删 ----------
  await runGitAction(dir, { action: 'set-remote', name: 'origin', url: 'https://example.invalid/x.git' })
  check('设置远端后能看到它', (await getGitStatus(dir)).remotes.some((r) => r.name === 'origin'))
  await runGitAction(dir, { action: 'set-remote', name: 'origin', url: 'https://example.invalid/y.git' })
  check(
    '同名远端改的是地址而不是新增一个',
    (await getGitStatus(dir)).remotes.filter((r) => r.name === 'origin').length === 1
  )
  await rejects('删不存在的远端要报错', () =>
    runGitAction(dir, { action: 'remove-remote', name: 'upstream2' })
  )
  await runGitAction(dir, { action: 'remove-remote', name: 'origin' })
  check('删除远端', (await getGitStatus(dir)).remotes.length === 0)

  // ---------- 贮藏 ----------
  await writeFile(join(dir, 'tracked.txt'), 'v3\n')
  await writeFile(join(dir, 'fresh.txt'), 'new\n')
  await runGitAction(dir, { action: 'stash-push', message: '临时收起', includeUntracked: true })
  const afterStash = await getGitStatus(dir)
  check('贮藏后工作区干净', afterStash.changes.length === 0)
  check(
    '贮藏栈里有这一条（说明里带着给的那句文案）',
    afterStash.stashes.length === 1 &&
      afterStash.stashes[0].ref === 'stash@{0}' &&
      afterStash.stashes[0].message.includes('临时收起'),
    JSON.stringify(afterStash.stashes)
  )
  check('贮藏序号从 0 起（就是 git 的 stash@{0}）', afterStash.stashes[0].index === 0)

  await runGitAction(dir, { action: 'stash-pop', ref: 'stash@{0}' })
  const afterPop = await getGitStatus(dir)
  // 弹回来的是**这一次贮藏收走的全部内容** —— 不只是刚写的两个文件：
  // 前面几段测试留下的 newdir/… 与 tracked.txt 的改动当时也一并被收进去了。
  check('弹出后改动全部回到工作区', afterPop.changes.length === 4, `${afterPop.changes.length} 项`)
  check(
    '其中包含未跟踪的新文件（-u 收进来的）',
    afterPop.changes.some((c) => c.path === 'fresh.txt')
  )
  check('弹出后贮藏栈空了（pop 会删掉这一条）', afterPop.stashes.length === 0)

  await runGitAction(dir, { action: 'stash-push', includeUntracked: true })
  await runGitAction(dir, { action: 'stash-apply', ref: 'stash@{0}' })
  const afterApply = await getGitStatus(dir)
  check('应用后改动回到工作区', afterApply.changes.length === 4, `${afterApply.changes.length} 项`)
  check('应用不删栈里的条目（这正是与 pop 的区别）', afterApply.stashes.length === 1)

  await runGitAction(dir, { action: 'stash-drop', ref: 'stash@{0}' })
  check('删除贮藏', (await getGitStatus(dir)).stashes.length === 0)

  // stash 的 ref 是拼进命令行的，只认 stash@{n} —— 挡下「ref 变成任意参数」
  await runGitAction(dir, { action: 'stash-push', includeUntracked: true })
  await rejects('非法的贮藏引用被拒', () =>
    runGitAction(dir, { action: 'stash-apply', ref: '--all' }),
    /不合法/
  )
  await runGitAction(dir, { action: 'stash-drop' })

  console.log('\nALL PASS')
} finally {
  await rm(dir, { recursive: true, force: true })
}
