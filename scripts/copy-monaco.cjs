/**
 * 将 node_modules/monaco-editor/min 复制到渲染进程的 Vite publicDir。
 *
 * Monaco Editor 默认从 CDN（cdn.jsdelivr.net）加载资源；把 min 产物拷贝到
 * public 目录后，配合 MonacoEditor.tsx 里的 loader.config({ paths })，
 * 即可让 Monaco 从本地静态路径加载，实现完全离线可用。
 *
 * 关键点：vite.config.ts 里 `root = src/renderer`，因此 publicDir 是
 * `src/renderer/public`（不是仓库根目录的 public）。
 *
 * 运行时机：package.json 的 predev / prebuild（npm 会自动在 dev/build 前执行）。
 */
const fs = require('fs')
const path = require('path')

// 源：node_modules/monaco-editor/min
const SRC = path.join(__dirname, '..', 'node_modules', 'monaco-editor', 'min')
// 目标：所有用得到 Monaco 的宿主 publicDir（各宿主独立静态目录）：
// - web：vite root = apps/web → public 在 apps/web/public
// - desktop：vite root = apps/desktop（index.html 在仓库根级）→ public 在 apps/desktop/public
// - mobile：独立 vite 工程，public 在 apps/mobile/public（**已 ignore**：纯生成物，
//   与 web / desktop 那两份入库的不一样 —— 多一份 152 文件的 vendored 副本没必要）
const DESTS = [
  path.join(__dirname, '..', 'apps', 'web', 'public', 'monaco-editor'),
  path.join(__dirname, '..', 'apps', 'desktop', 'public', 'monaco-editor'),
  path.join(__dirname, '..', 'apps', 'mobile', 'public', 'monaco-editor')
]

if (!fs.existsSync(SRC)) {
  console.warn('[copy-monaco] 未找到 monaco-editor，请先执行 npm install。跳过：', SRC)
  process.exit(0)
}

// 读取 monaco-editor 版本；命中已复制的版本则跳过（避免每次 dev 重复拷贝几十 MB）
let version = 'unknown'
try {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(SRC, '..', 'package.json'), 'utf-8')
  )
  version = pkg.version || version
} catch {
  // 忽略：读不到版本时照常复制
}

const allFresh =
  DESTS.every((dest) => {
    const m = path.join(dest, '.monaco-version')
    return fs.existsSync(m) && fs.readFileSync(m, 'utf-8').trim() === version
  })
if (allFresh) {
  console.log(`[copy-monaco] 已是最新（v${version}），跳过`)
  process.exit(0)
}

for (const DEST of DESTS) {
  if (fs.existsSync(DEST)) {
    fs.rmSync(DEST, { recursive: true, force: true })
  }
  fs.mkdirSync(DEST, { recursive: true })
  fs.cpSync(SRC, DEST, { recursive: true })
  // ⚠️ 版本标记写进**各自的** DEST：以前写的是 `DESTS[0]` 的标记，
  // 于是除 web 之外的目标永远「不新鲜」，每次 dev / build 都要重拷几十 MB
  // （并顺手把 desktop 的标记删掉 —— git 里那个删除就是这么来的）
  fs.writeFileSync(path.join(DEST, '.monaco-version'), version)
  console.log(`[copy-monaco] 已复制 monaco-editor/min@${version} → ${path.relative(path.join(__dirname, '..'), DEST)}`)
}
