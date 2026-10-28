/**
 * 容器运行时产物（`docker/container-project/runtime/*.mjs`）的第三方依赖校验。
 *
 * ## 为什么需要它
 * `runtime.mjs` 是 vite 库构建的产物，**非 `@fizz/*` 的裸导入一律 external**
 * （见同目录 `vite.config.ts` 的 `rollupOptions.external`）。也就是说这些包不会被
 * 打进 bundle，而是靠镜像里 `npm i` 装 `docker/container-project/runtime/package.json`
 * 的 dependencies 来提供。两处清单一旦漂移，症状是**容器起来后才炸**：
 *
 *     Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'xxx' imported from /app/runtime.mjs
 *
 * 构建期跑一遍这个脚本，就能把「代码里 import 了、清单里没声明」挡在 `npm run build:runtime`。
 *
 * ## 校验方向（只有第一个方向会失败）
 * 1. `产物 import 了 → 清单里没有` → **error，退出码 1**。这就是上面那个容器崩溃。
 * 2. `清单里有 → 产物没用到` → 仅提示。有些包是运行时按需 `import()` 或由
 *    `agent-host.mjs` / `bootstrap.mjs` 之外的代码路径用的，不能据此判死。
 *
 * ## 为什么不用正则直接扫原文
 * 注意：`runtime.mjs` 里内置的提示词模板含
 * `move items from "In Progress" to "Done"`，朴素正则会把它当成包名 `In Progress`，
 * 于是每次构建都报一个不存在的依赖。所以这里先做一遍**轻量词法扫描**，把注释、字符串、
 * 模板字面量、正则字面量摘出去，只在「剩下的代码影子」上匹配 import/export/require。
 * 摘掉的字符串按下标存起来，匹配到 `\u0001<索引>\u0001` 时再回查 → 既不误报也不漏报。
 *
 * 扫描器覆盖：`//` `/* *\/` 注释、`'` `"` 字符串、带 `${}` 插值的模板、
 * 以及「/ 是除号还是正则字面量」的判定（靠前一个有意义字符猜测）。
 * 不追求成为完整 JS parser —— 它只服务这 ONE 个用途：找模块说明符。
 */
import { existsSync, readFileSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 仓库根（scripts/ 的上一级）；npm 脚本的 cwd 就是它 */
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const RUNTIME_DIR = resolve(REPO_ROOT, 'docker/container-project/runtime')

/** 随镜像 COPY 进 `/app` 的产物。`runtime.mjs` 是 vite 产物，`agent-host.mjs` 是手写入口 */
const ARTIFACTS = ['runtime.mjs', 'agent-host.mjs']

/** 前一个是这些字符时，`/` 是正则字面量的开头而不是除号 */
const REGEX_LEAD = new Set('(,=:[!&|?{};+-*%^~<>'.split(''))
/** 前一个是这些关键字时同理 */
const REGEX_KEYWORDS = new Set([
  'return',
  'typeof',
  'instanceof',
  'case',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'yield',
  'await',
  'do',
  'else'
])

const MARK = '\u0001'

/**
 * 把源码切成「代码影子」+「字符串字面量表」。
 *
 * 影子里的每个字符串字面量被替换成 `\u0001<索引>\u0001`，注释替换成空格。
 * 这样后续正则只在真代码上匹配，字符串内容不可能冒充模块说明符。
 */
function tokenize(src) {
  const strings = []
  let shadow = ''
  let i = 0
  const n = src.length

  /** 影子尾巴上前一个有意义的字符 / 词，用来判断 `/` 的语义 */
  function prevToken() {
    let j = shadow.length - 1
    while (j >= 0 && /\s/.test(shadow[j])) j--
    if (j < 0) return { char: '', word: '' }
    const char = shadow[j]
    if (/[\w$]/.test(char)) {
      let k = j
      while (k >= 0 && /[\w$]/.test(shadow[k])) k--
      return { char, word: shadow.slice(k + 1, j + 1) }
    }
    return { char, word: '' }
  }

  function regexAllowed() {
    const { char, word } = prevToken()
    if (!char) return true
    if (REGEX_KEYWORDS.has(word)) return true
    return REGEX_LEAD.has(char)
  }

  /** 读一段引号字符串；返回字面量值（已处理常见转义） */
  function readQuoted(quote, sink) {
    let value = ''
    i++ // 跳过开引号
    while (i < n) {
      const c = src[i]
      if (c === '\\') {
        value += src[i + 1] ?? ''
        i += 2
        continue
      }
      if (c === quote) {
        i++
        break
      }
      // 未闭合（构建产物里不该出现）：吞到结尾，别死循环
      value += c
      i++
    }
    if (!sink) return value
    strings.push(value)
    shadow += `${MARK}${strings.length - 1}${MARK}`
    return value
  }

  /** 读模板字面量：`${}` 里的代码递归当代码扫（不进入影子） */
  function readTemplate() {
    i++ // 跳过反引号
    let value = ''
    let interpolated = false
    while (i < n) {
      const c = src[i]
      if (c === '\\') {
        value += src[i + 1] ?? ''
        i += 2
        continue
      }
      if (c === '`') {
        i++
        break
      }
      if (c === '$' && src[i + 1] === '{') {
        interpolated = true
        i += 2
        scanCode({ sink: false, stopAtBrace: true })
        continue
      }
      value += c
      i++
    }
    // 带插值的模板不可能是完整模块说明符，直接丢弃以免被当成包名
    if (interpolated) {
      shadow += ' '
      return
    }
    strings.push(value)
    shadow += `${MARK}${strings.length - 1}${MARK}`
  }

  function readRegex() {
    i++ // 跳过开头的 /
    let inClass = false
    while (i < n) {
      const c = src[i]
      if (c === '\\') {
        i += 2
        continue
      }
      if (c === '[') inClass = true
      else if (c === ']') inClass = false
      else if (c === '/' && !inClass) {
        i++
        while (i < n && /[a-z]/.test(src[i])) i++ // flags
        break
      }
      i++
    }
    shadow += ' '
  }

  function scanCode({ sink, stopAtBrace }) {
    let depth = 0
    while (i < n) {
      const c = src[i]

      if (c === '/' && src[i + 1] === '/') {
        while (i < n && src[i] !== '\n') i++
        if (sink) shadow += '\n'
        continue
      }
      if (c === '/' && src[i + 1] === '*') {
        i += 2
        while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++
        i += 2
        if (sink) shadow += ' '
        continue
      }
      if (c === '"' || c === "'") {
        readQuoted(c, sink)
        continue
      }
      if (c === '`') {
        // 模板里的插值不参与「找 import」，但内容也别污染影子
        readTemplate()
        continue
      }
      if (c === '/' && regexAllowed()) {
        readRegex()
        continue
      }
      if (stopAtBrace) {
        if (c === '{') depth++
        else if (c === '}') {
          if (depth === 0) {
            i++
            return
          }
          depth--
        }
      }

      if (sink) shadow += c
      i++
    }
  }

  scanCode({ sink: true, stopAtBrace: false })
  return { shadow, strings }
}

/**
 * 从源码里取出所有**模块说明符**（尚未过滤相对路径 / 内置模块）。
 *
 * 三种形态：
 * - `import x from 'pkg'` / `export { x } from 'pkg'`（含多行括号，`from` 前不吃换行保险起见放宽）
 * - `import 'pkg'`（副作用导入）
 * - `import('pkg')` / `require('pkg')`（动态）
 */
function moduleSpecifiers(src) {
  const { shadow, strings } = tokenize(src)
  const at = (idx) => strings[Number(idx)] ?? ''
  const out = []
  // 注意：分隔符是 \u0001，不能写进正则字面量（那样 MARK 就是四个字母），必须用构造器拼
  const SLOT = `${MARK}(\\d+)${MARK}`

  const patterns = [
    // 静态 import / re-export：`from '<pkg>'`（`from` 与字符串之间是代码，已无字符串干扰）
    new RegExp(`(?<![\\w$.])from\\s*${SLOT}`, 'g'),
    // 副作用导入：import '<pkg>'
    new RegExp(`(?<![\\w$.])import\\s*${SLOT}`, 'g'),
    // 动态导入 / CJS require
    new RegExp(`(?<![\\w$.])(?:import|require)\\s*\\(\\s*${SLOT}\\s*\\)`, 'g')
  ]

  for (const re of patterns) {
    let m
    while ((m = re.exec(shadow))) out.push(at(m[1]))
  }
  return out
}

/** 裸导入（需要由 node_modules 提供）判定；返回包名，非裸导入返回 null */
const BUILTINS = new Set(builtinModules.map((m) => m.replace(/^node:/, '')))

function packageNameOf(spec) {
  if (!spec) return null
  // 相对路径 / 绝对路径 / 盘符路径 / 导入映射（#xxx）/ URL scheme（data: file: http: node:）
  if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('#')) return null
  if (/^[A-Za-z]:[\\/]/.test(spec)) return null
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(spec)) return null
  if (BUILTINS.has(spec)) return null
  const parts = spec.split('/')
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

/** 读 runtime 的依赖清单（缺失就是配置问题，直接抛） */
function readDeclared() {
  const manifestPath = resolve(RUNTIME_DIR, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const declared = Object.keys(manifest.dependencies ?? {})
  return { manifestPath, declared, declaredSet: new Set(declared) }
}

function main() {
  const { manifestPath, declared, declaredSet } = readDeclared()
  const used = new Map() // 包名 -> Set<产物文件>
  const missingPaths = []

  for (const name of ARTIFACTS) {
    const file = resolve(RUNTIME_DIR, name)
    if (!existsSync(file)) {
      missingPaths.push(name)
      continue
    }
    const src = readFileSync(file, 'utf8')
    for (const spec of moduleSpecifiers(src)) {
      const pkg = packageNameOf(spec)
      if (!pkg) continue
      if (!used.has(pkg)) used.set(pkg, new Set())
      used.get(pkg).add(name)
    }
  }

  if (missingPaths.length) {
    console.error(`✗ 缺少产物：${missingPaths.join('、')}`)
    console.error(`  先跑 vite 构建（\`npm run build:runtime\` 的前半段），产物目录：${RUNTIME_DIR}`)
    process.exit(1)
  }

  const missing = [...used.keys()].filter((pkg) => !declaredSet.has(pkg)).sort()
  const unused = declared.filter((pkg) => !used.has(pkg)).sort()

  console.log(`容器运行时依赖校验：${ARTIFACTS.join(' + ')}`)
  console.log(`  声明清单：${manifestPath}`)
  console.log(`  产物里用到的第三方包（${used.size}）：${[...used.keys()].sort().join(', ')}`)

  if (unused.length) {
    console.log(`  · 清单里声明但产物未直接导入（${unused.length}，仅提示）：${unused.join(', ')}`)
  }

  if (missing.length) {
    console.error(`\n✗ 有 ${missing.length} 个包被产物导入但未在 dependencies 里声明：`)
    for (const pkg of missing) {
      console.error(`    ${pkg}   ← 出现在 ${[...used.get(pkg)].join(', ')}`)
    }
    console.error('\n  不补的后果：容器镜像里没有这个包，`/app/runtime.mjs` 一被 import 就')
    console.error("  ERR_MODULE_NOT_FOUND。把它加进上面那份 package.json 的 dependencies 即可。")
    process.exit(1)
  }

  console.log('  ✓ 全部裸导入都已在 dependencies 中声明')
}

main()
