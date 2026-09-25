// 扫描「用了但 Tailwind 没生成」的颜色工具类：
// 语义色令牌（--color-*）没在 @theme 里映射时，对应的 text-/bg-/border- 类会被静默丢弃，
// 界面上表现为「底色出来了、文字色没变」这类只有肉眼能看出的偏差。
// 用法：node scripts/check-missing-color-utils.mjs
import { readFileSync, readdirSync, writeFileSync, mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const SRC = 'src/renderer/src'
const PREFIXES = ['text', 'bg', 'border', 'ring', 'fill', 'stroke', 'outline', 'from', 'to', 'via']

/** 遍历目录下所有 tsx */
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (name.endsWith('.tsx')) out.push(p)
  }
  return out
}

/** 类名 → 去掉变体前缀（hover:/dark:/group-hover/… 与 !、/opacity）与解析残留（引号、中文等） */
function stripVariants(cls) {
  // 先裁掉不属于类名的字符（引号 / 中文 / 标点都是字符串解析残留）
  const clean = String(cls).replace(/^!/, '').split(/[^a-zA-Z0-9\-_.:/[\]()#%]/)[0]
  let c = clean.split(':').pop() ?? ''
  // 去掉透明度修饰 /40、/[0.04]
  c = c.replace(/\/\d+(\.\d+)?$/, '')
  c = c.replace(/\/\[[^\]]+\]$/, '')
  return c
}

const used = new Set()
for (const file of walk(SRC)) {
  const text = readFileSync(file, 'utf8')
  // class 字符串里的类名
  for (const m of text.matchAll(/'([^']*)'|"([^"]*)"/g)) {
    const chunk = m[1] ?? m[2] ?? ''
    if (!/[\s-]/.test(chunk)) continue
    for (const tok of chunk.split(/\s+/)) {
      const c = stripVariants(tok)
      const [prefix] = c.split('-')
      if (PREFIXES.includes(prefix) && c.includes('-')) used.add(c)
    }
  }
  // cn(...) / 模板串里的裸类名（如 `bg-primary/15`）也抓一遍
  for (const m of text.matchAll(/`([^`]*)`/g)) {
    for (const tok of m[1].split(/\s+/)) {
      const c = stripVariants(tok)
      const [prefix] = c.split('-')
      if (PREFIXES.includes(prefix) && c.includes('-')) used.add(c)
    }
  }
}

// 找到 index.html 引用的 CSS 产物
const html = readFileSync('out/renderer/index.html', 'utf8')
const cssName = html.match(/href="\.\/assets\/(index-[^"]+\.css)"/)?.[1]
if (!cssName) throw new Error('未找到产物 CSS，先跑 npx vite build --no-emptyOutDir')
const css = readFileSync(join('out/renderer/assets', cssName), 'utf8')

/** CSS 里类名会被转义：/ → \/、. → \.、[ ] 也要转义 */
const escapeClass = (c) => c.replace(/([./[\]()#%:,+*~>])/g, '\\$1')

// ⚠️ 用「转义后的类名子串」判断，而不是 `.类名`：只带变体使用的类（hover:text-x）
// 在产物里只有 `.hover\:text-x:hover`，没有裸 `.text-x`，按裸类名判会误报
const missing = [...used].filter((c) => !css.includes(escapeClass(c))).sort()
console.log(`产物 CSS: ${cssName}`)
console.log(`待检类名: ${used.size}`)
console.log(`未生成: ${missing.length}`)
for (const c of missing) console.log('  MISSING', c)
mkdirSync('.workbuddy-ai', { recursive: true })
writeFileSync('.workbuddy-ai/missing-color-utils.txt', missing.join('\n'))
process.exit(missing.length === 0 ? 0 : 0)
