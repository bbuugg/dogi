/**
 * 将 node_modules/ironrdp-wasm 的 WASM 产物复制到渲染进程的 Vite publicDir。
 *
 * 嵌入式 RDP 客户端（ironrdp-wasm）默认按 `new URL('rdp_client_bg.wasm',
 * import.meta.url)` 取 wasm 文件，但打在 Electron 渲染端（file:// / 打包后 asar）
 * 里这条路径不可靠（包的 exports 也不允许直接引子路径），因此把 wasm 拷到
 * public 的 `rdp/` 下，由 RdpPage 显式 `init(wasmUrl)` 传入本地静态路径。
 *
 * 关键点：vite.config.ts 里 `root = src/renderer`，因此 publicDir 是
 * `src/renderer/public`（不是仓库根目录的 public）。
 *
 * 运行时机：package.json 的 predev / prebuild（npm 会自动在 dev/build 前执行）。
 */
const fs = require('fs')
const path = require('path')

// 源：node_modules/ironrdp-wasm/pkg
const PKG_DIR = path.join(__dirname, '..', 'node_modules', 'ironrdp-wasm', 'pkg')
const SRC = path.join(PKG_DIR, 'rdp_client_bg.wasm')
// 目标：渲染进程的 publicDir（vite root = src/renderer）
const DEST_DIR = path.join(__dirname, '..', 'src', 'renderer', 'public', 'rdp')
const DEST = path.join(DEST_DIR, 'rdp_client_bg.wasm')

if (!fs.existsSync(SRC)) {
  console.warn('[copy-rdp] 未找到 ironrdp-wasm，请先执行 npm install。跳过：', SRC)
  process.exit(0)
}

// 读取 ironrdp-wasm 版本；命中已复制的版本则跳过（避免每次 dev 重复拷贝）
let version = 'unknown'
try {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(PKG_DIR, '..', 'package.json'), 'utf-8')
  )
  version = pkg.version || version
} catch {
  // 忽略：读不到版本时照常复制
}

const marker = path.join(DEST_DIR, '.rdp-version')
if (fs.existsSync(marker) && fs.readFileSync(marker, 'utf-8').trim() === version) {
  console.log(`[copy-rdp] 已是最新（v${version}），跳过`)
  process.exit(0)
}

if (fs.existsSync(DEST_DIR)) {
  fs.rmSync(DEST_DIR, { recursive: true, force: true })
}
fs.mkdirSync(DEST_DIR, { recursive: true })
fs.copyFileSync(SRC, DEST)
fs.writeFileSync(marker, version)
console.log(`[copy-rdp] 已复制 ironrdp-wasm@${version} 的 wasm → src/renderer/public/rdp`)
