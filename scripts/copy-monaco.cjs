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
// 目标：渲染进程的 publicDir（vite root = src/renderer）
const DEST = path.join(__dirname, '..', 'src', 'renderer', 'public', 'monaco-editor')

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

const marker = path.join(DEST, '.monaco-version')
if (fs.existsSync(marker) && fs.readFileSync(marker, 'utf-8').trim() === version) {
  console.log(`[copy-monaco] 已是最新（v${version}），跳过`)
  process.exit(0)
}

if (fs.existsSync(DEST)) {
  fs.rmSync(DEST, { recursive: true, force: true })
}
fs.mkdirSync(DEST, { recursive: true })
fs.cpSync(SRC, DEST, { recursive: true })
fs.writeFileSync(marker, version)
console.log(
  `[copy-monaco] 已复制 monaco-editor/min@${version} → src/renderer/public/monaco-editor`
)
