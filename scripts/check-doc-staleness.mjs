#!/usr/bin/env node
/**
 * 文档过时扫描：AGENTS.md 与 docs/ 下分册里提到的文件 / 包名，逐个对磁盘核一遍。
 *
 * 为什么要有这个：这些文档是**每轮注入模型上下文**的（见 4.31），里面一个过时的
 * 文件名会让模型去找不存在的模块，或者照着已删掉的实现做判断 —— 而文档越写越大，
 * 靠人肉复查必然漏。本脚本把「文档说的」和「代码有的」对齐，漏的那条直接报出来。
 *
 * 覆盖三类引用：
 *   1. 反引号里的**仓库内路径**（`src/main/...`、`features/agent/x.ts`）→ 文件是否存在
 *   2. 反引号里的**包名**（`@xterm/xterm`、`use-stick-to-bottom`）→ 在不在依赖树里
 *   3. 反引号里的**裸文件名**（`pane-layout.ts`）→ 仓库任意位置找同名文件
 *
 * 误报白名单见 IGNORE；有意留档的历史条目靠行内的「已移除 / 已删除」标注豁免。
 *
 * 用法：node scripts/check-doc-staleness.mjs        # 有过时项时 exit 1
 *      node scripts/check-doc-staleness.mjs --quiet # 只在有问题时输出
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, resolve, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 文档正文（分册 + 根 AGENTS.md） */
const DOCS = ['AGENTS.md', ...walk('docs').filter((f) => f.endsWith('.md'))]

/** 不在仓库里、也不该当代码路径核的引用（运行时产物 / 外部资源 / 历史留档） */
const IGNORE = new Set([
  // 运行时产物与用户数据
  'out/preload/index.cjs', 'out/main/index.js', 'out/renderer/index.html',
  'userData/command-history.json', 'hosts.json', 'notes.json', 'api.json',
  'workspace.json', '.dogi/workspace.json', '.dogi.json',
  'latest.yml', 'app-update.yml', 'package.json', 'package-lock.json',
  // 第三方 / 外部资源
  'SKILL.md', 'CLAUDE.md', 'AGENTS.md', 'zmodem.js', 'node_modules/electron/install.js',
  '@lydell/node-pty', '@dogi/ai-agent', 'agent-BOxKOk3n.js',
  // 示例 / 占位 / 构建产物名
  'scripts/xxx.mjs', 'runner.ts', 'xxx.js', 'bin/vite.js',
])

/** `tmp/` `out/` 下都是探针跑出来的中间产物（esbuild 出来的 .mjs 之类），不核 */
const GENERATED = /^(tmp|out)\//

/** node_modules / 产物目录不进「同名文件」索引 */
const SKIP_DIR = /\/(node_modules|out|dist|build|\.git|tmp|screenshots)\//

function walk(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    return statSync(p).isDirectory() ? walk(p) : [p]
  })
}

const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const DEPS = new Set([
  ...Object.keys(PKG.dependencies ?? {}),
  ...Object.keys(PKG.devDependencies ?? {}),
])

/**
 * `@shared/*` 不是包，是 vite / tsconfig 的别名（见 3.1）→ 当路径核。
 * 传递依赖（如 `@lydell/node-pty`，node-pty 的子依赖）算「存在」，
 * 否则「node-pty 装在哪」这类结论会被误报成过时。
 */
const LOCK = existsSync(join(ROOT, 'package-lock.json'))
  ? Object.keys(JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8')).packages ?? {})
  : []
function packageExists(name) {
  return DEPS.has(name) || LOCK.some((k) => k.endsWith('node_modules/' + name))
}

/** 仓库内所有文件名的索引，用于裸文件名反查 */
const NAME_INDEX = new Map()
for (const f of walk('.')) {
  const rel = f.replace(/^\.\//, '')
  if (!SKIP_DIR.test('/' + rel)) NAME_INDEX.set(basename(rel), rel)
}

/** 从一行里抠出反引号内容，按分隔符切成候选 token */
function* tokens(line) {
  for (const m of line.matchAll(/`([^`\n]+)`/g)) {
    for (const raw of m[1].split(/[\s,，、；;]+/)) {
      const t = raw.trim().replace(/^[('"“]+|[)'"”]+$/g, '')
      if (t) yield t
    }
  }
}

const FILE_RE = /^[\w./@-]+\.(?:ts|tsx|mjs|mts|cjs|js|json|css|html|md|ya?ml)$/

/** 文档里给的路径可能是相对仓库根、也可能只给了末两段（`features/agent/x.ts`） */
function resolveRef(ref) {
  if (existsSync(join(ROOT, ref))) return ref
  const base = basename(ref)
  return NAME_INDEX.get(base) ?? null
}

const problems = []

/**
 * 「已移除 / 已删除」的标注按**整块**判定，而不是按行。踩过两层坑：
 *   1. 清单类条目写成多行折行（「实测清掉 13 个：a、b、c … 已移除」），
 *      只看单行会把前面几行的包名全报成过时；
 *   2. 标注常写在块的末行（收尾），不在块首行。
 * 所以先切成「块」（以 `-` / `1.` / `|` 开头，到下一个块首或空行为止），
 * 块里任意一行带标注 → 整块视为有意留档的历史。
 */
const BLOCK_START = /^\s*(?:[-*]\s|\d+\.\s|\|)/
const isArchiveNote = (line) => /已移除|已删除|已被.*取代/.test(line)

function blocks(lines) {
  const out = []
  let cur = null
  for (const [i, line] of lines.entries()) {
    if (BLOCK_START.test(line)) {
      if (cur) out.push(cur)
      cur = { lines: [{ line, i }], archived: isArchiveNote(line) }
    } else if (cur && line.trim() !== '') {
      cur.lines.push({ line, i })
      if (isArchiveNote(line)) cur.archived = true
    } else {
      if (cur) out.push(cur)
      cur = null
    }
  }
  if (cur) out.push(cur)
  return out
}

function check(doc, i, ref) {
  if (IGNORE.has(ref) || GENERATED.test(ref)) return

  // 路径别名：`@shared/x.ts` → src/shared/x.ts（别名定义见 3.1）
  if (ref === '@shared/*') return // 别名定义本身（3.1）
  if (ref.startsWith('@shared/')) {
    const stem = ref.replace(/^@shared\//, '').replace(/\.(ts|tsx)$/, '')
    if (!NAME_INDEX.has(stem + '.ts') && !NAME_INDEX.has(stem + '.tsx')) {
      problems.push({ doc, i, ref, why: `别名指向的 src/shared/${stem}.ts 不存在` })
    }
    return
  }

  // 包名：@scope/name 或裸包名
  if (/^@[\w.-]+\/[\w.-]+$/.test(ref)) {
    if (!packageExists(ref)) problems.push({ doc, i, ref, why: '依赖树里没有这个包' })
    return
  }

  if (!FILE_RE.test(ref)) return
  if (!resolveRef(ref)) problems.push({ doc, i, ref, why: '仓库里找不到同名文件' })
}

for (const doc of DOCS) {
  for (const block of blocks(readFileSync(join(ROOT, doc), 'utf8').split('\n'))) {
    for (const { line, i } of block.lines) {
      if (block.archived) continue // 有意留档的历史条目
      for (const ref of tokens(line)) check(doc, i + 1, ref)
    }
  }
}

if (!problems.length) {
  if (!process.argv.includes('--quiet')) {
    console.log(`✓ 文档引用与代码一致（${DOCS.length} 个文档）`)
  }
} else {
  const byDoc = new Map()
  for (const p of problems) {
    if (!byDoc.has(p.doc)) byDoc.set(p.doc, [])
    byDoc.get(p.doc).push(p)
  }
  console.error(`✗ 文档里有 ${problems.length} 处引用对不上代码：\n`)
  for (const [doc, list] of byDoc) {
    console.error(`  ${doc}`)
    for (const p of list) console.error(`    ${p.ref}  (${doc}:${p.i})  —— ${p.why}`)
    console.error('')
  }
  console.error('修法：改文档（首选），或确认该条目确已废弃 → 加进脚本顶部的 IGNORE。')
  process.exit(1)
}