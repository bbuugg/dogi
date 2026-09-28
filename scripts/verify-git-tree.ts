/**
 * 源代码管理列表「扁平路径 → 目录树」的折行验证（纯函数，直接跑真源码，不起 Electron）。
 *
 * 防的是**目录名显示异常**的坑：显示名必须在建树时按路径末段算好（`RowNode.name`），
 * 不能在渲染时用 `slice(lastIndexOf('/') + 1)` 现切 —— 那种算术在多层目录下很容易切错，
 * 二级目录名显示成问号／空串就是这么来的（用户报告）。中文目录名还要原样保留。
 *
 * 跑：node --experimental-strip-types scripts/verify-git-tree.ts
 */

import assert from 'node:assert/strict'
import { buildRows, type RowNode } from '../src/renderer/src/features/agent/git-tree.ts'
import type { GitChange } from '../src/shared/types.ts'

const check = (label: string, ok: boolean): void => {
  assert.ok(ok, `FAIL: ${label}`)
  console.log(`  ok  ${label}`)
}

const change = (path: string, extra: Partial<GitChange> = {}): GitChange => ({
  index: ' ',
  worktree: 'M',
  path,
  ...extra
})

const files = (paths: string[]): Array<{ change: GitChange; letter: string }> =>
  paths.map((p) => ({ change: change(p), letter: 'M' }))

/** 递归收集所有显示名（目录名 + 文件名） */
const allNames = (nodes: RowNode[]): string[] =>
  nodes.flatMap((n) => (n.kind === 'dir' ? [n.name, ...allNames(n.children)] : [n.name]))

const dirsOf = (nodes: RowNode[]): Array<Extract<RowNode, { kind: 'dir' }>> =>
  nodes.filter((n): n is Extract<RowNode, { kind: 'dir' }> => n.kind === 'dir')
const namesOf = (nodes: RowNode[]): string[] => nodes.map((n) => n.name)

// ---------- 多级 + 中文 + 根目录文件混在一起 ----------
const rows = buildRows(
  files([
    'README.md',
    'src/renderer/App.tsx',
    'src/renderer/index.ts',
    'docs/使用说明/入门.md'
  ])
)

check('顶层顺序：目录在前、文件在后', rows[0].kind === 'dir' && rows[rows.length - 1].kind === 'file')
check('顶层目录名取路径末段（src / docs）', namesOf(dirsOf(rows)).join(',') === 'src,docs')
check(
  '根目录文件的显示名就是文件名',
  namesOf(rows.filter((n) => n.kind === 'file')).join(',') === 'README.md'
)

const src = dirsOf(rows)[0]
const renderer = dirsOf(src.children)[0]
check('二级目录名取路径末段（renderer）', renderer?.name === 'renderer')
check(
  '二级目录下的文件显示短名（不是完整路径）',
  namesOf(renderer.children).join(',') === 'App.tsx,index.ts'
)
check(
  '目录保留完整路径（tooltip 用）',
  src.path === 'src' && renderer.path === 'src/renderer'
)
check(
  '目录节点带上其下全部变更路径（整目录暂存 / 回退用）',
  src.paths.join(',') === 'src/renderer/App.tsx,src/renderer/index.ts'
)

const docs = dirsOf(rows)[1]
const cn = dirsOf(docs.children)[0]
check('中文目录名原样保留（使用说明）', cn?.name === '使用说明')
check('中文文件名原样保留（入门.md）', namesOf(cn.children).join(',') === '入门.md')
check('中文目录的完整路径也保留（docs/使用说明）', cn?.path === 'docs/使用说明')

const everyName = allNames(rows)
check(
  `所有显示名非空、不含问号（${everyName.join(' / ')}）`,
  everyName.every((n) => n.length > 0 && !n.includes('?'))
)

// ---------- 同名目录要合并成一个节点 ----------
const merged = dirsOf(buildRows(files(['src/a.ts', 'src/b.ts', 'src/deep/c.ts'])))
check(
  '同一目录下的多个文件合并到同一个目录节点',
  merged.length === 1 && namesOf(merged[0].children).join(',') === 'deep,a.ts,b.ts'
)

// ---------- 重命名：按新路径折树，但 origPath 要留着显示 ----------
const renamed = buildRows([
  { change: change('src/new.ts', { index: 'R', origPath: 'src/old.ts' }), letter: 'R' }
])
const renamedFile = dirsOf(renamed)[0]?.children[0]
check(
  '重命名按新路径折树（new.ts），旧路径仍可读',
  renamedFile?.name === 'new.ts' && renamedFile?.change.origPath === 'src/old.ts'
)

// ---------- git 的目录条目：路径带尾斜杠（未跟踪的嵌套仓库 / 目录）----------
// 用户报告的坑：这种条目尾段是空串，当文件名用就会渲染出「没有名字的文件行」（前面是 ?）
const entries = buildRows([
  { change: change('nested/', { index: '?', worktree: '?' }), letter: '?' },
  { change: change('a/b/', { index: '?', worktree: '?' }), letter: '?' }
])
const topEntry = entries.find((n) => n.kind === 'dirEntry')
check(
  '目录条目有名字（nested），不是空串',
  topEntry?.kind === 'dirEntry' && topEntry.name === 'nested'
)
check(
  '目录条目的完整路径保留尾斜杠（暂存 / 回退要用）',
  topEntry?.change.path === 'nested/'
)
const outerA = dirsOf(entries)[0]
const innerEntry = outerA?.children[0]
check(
  '多级目录条目挂在父目录下，名字取到末段（a → b）',
  outerA?.name === 'a' && innerEntry?.kind === 'dirEntry' && innerEntry.name === 'b'
)
check(
  '目录条目的显示名也都不为空',
  allNames(entries).every((n) => n.length > 0)
)

console.log('\nALL PASS')
