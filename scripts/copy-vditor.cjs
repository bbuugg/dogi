/**
 * 将 node_modules/vditor/dist 复制到渲染进程的 Vite publicDir。
 *
 * Vditor 运行时按 `${cdn}/dist/js/...` 动态插入 <script>（lute 解析器、图标、
 * i18n、highlight.js 以及公式 / 图表渲染器），默认指向 unpkg CDN；
 * 把 dist 拷到 public 目录后，配合 VditorEditor.tsx 的 `cdn` 选项即可让全部资源
 * 从本地静态路径加载，实现完全离线可用。
 *
 * 关键点：vite.config.ts 里 `root = src/renderer`，因此 publicDir 是
 * `src/renderer/public`（不是仓库根目录的 public）。
 *
 * 运行时机：package.json 的 predev / prebuild（npm 会自动在 dev/build 前执行）。
 */
const fs = require('fs')
const path = require('path')

// 源：node_modules/vditor/dist
const SRC = path.join(__dirname, '..', 'node_modules', 'vditor', 'dist')
// 目标：渲染进程的 publicDir（vite root = src/renderer）
const DEST = path.join(__dirname, '..', 'src', 'renderer', 'public', 'vditor', 'dist')

if (!fs.existsSync(SRC)) {
  console.warn('[copy-vditor] 未找到 vditor，请先执行 npm install。跳过：', SRC)
  process.exit(0)
}

// 读取 vditor 版本；命中已复制的版本则跳过（避免每次 dev 重复拷贝二十多 MB）
let version = 'unknown'
try {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(SRC, '..', 'package.json'), 'utf-8')
  )
  version = pkg.version || version
} catch {
  // 忽略：读不到版本时照常复制
}

const marker = path.join(DEST, '..', '.vditor-version')
if (fs.existsSync(marker) && fs.readFileSync(marker, 'utf-8').trim() === version) {
  console.log(`[copy-vditor] 已是最新（v${version}），跳过`)
  process.exit(0)
}

if (fs.existsSync(DEST)) {
  fs.rmSync(DEST, { recursive: true, force: true })
}
fs.mkdirSync(DEST, { recursive: true })
fs.cpSync(SRC, DEST, { recursive: true })
fs.writeFileSync(marker, version)
console.log(
  `[copy-vditor] 已复制 vditor/dist@${version} → src/renderer/public/vditor/dist`
)