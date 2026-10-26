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
  path.join(__dirname, '..', 'apps', 'mobile', 'public', 'monaco-editor'),
  // Chrome 扩展（apps/extension）：同样是生成物、不入库。扩展的页面在
  // `chrome-extension://<id>/` 下，`/monaco-editor/vs` 照样能解析到它 —— 不铺这份的话，
  // 文件面板里的代码编辑器会 404（界面还在，只是编辑区空着）。
  path.join(__dirname, '..', 'apps', 'extension', 'public', 'monaco-editor')
]

if (!fs.existsSync(SRC)) {
  console.warn('[copy-monaco] 未找到 monaco-editor，请先执行 npm install。跳过：', SRC)
  process.exit(0)
}

// 生成物模式号：改下面的「拷贝后处理」逻辑时 +1，让所有 DEST 的版本标记失配、强制重拷
// （不改的话旧标记 = 纯版本号，命中 `allFresh` 会直接跳过，新产物永远落不了地）。
const COPY_SCHEMA = 2

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

const marker = `${version}+schema${COPY_SCHEMA}`
const allFresh =
  DESTS.every((dest) => {
    const m = path.join(dest, '.monaco-version')
    return fs.existsSync(m) && fs.readFileSync(m, 'utf-8').trim() === marker
  })
if (allFresh) {
  console.log(`[copy-monaco] 已是最新（${marker}），跳过`)
  process.exit(0)
}

for (const DEST of DESTS) {
  if (fs.existsSync(DEST)) {
    fs.rmSync(DEST, { recursive: true, force: true })
  }
  fs.mkdirSync(DEST, { recursive: true })
  fs.cpSync(SRC, DEST, { recursive: true })
  writeCspWorkerShim(DEST)
  // ⚠️ 版本标记写进**各自的** DEST：以前写的是 `DESTS[0]` 的标记，
  // 于是除 web 之外的目标永远「不新鲜」，每次 dev / build 都要重拷几十 MB
  // （并顺手把 desktop 的标记删掉 —— git 里那个删除就是这么来的）
  fs.writeFileSync(path.join(DEST, '.monaco-version'), marker)
  console.log(`[copy-monaco] 已复制 monaco-editor/min@${version} → ${path.relative(path.join(__dirname, '..'), DEST)}`)
}

/**
 * 拷贝后处理：为 **CSP 严格的环境**（Chrome 扩展 MV3）补两个小文件。
 *
 * 背景：monaco 的 worker 是「blob 包一层」—— `new Worker(URL.createObjectURL(new Blob([
 * "importScripts('<真实的 worker 文件>');postMessage({type:'vscode-worker-ready'})"])))`。
 * worker 本体本来就躺在同源的 `vs/assets/*.worker-*.js`，blob 纯粹是个引导壳。
 * 但 MV3 扩展页面的 CSP 不允许 `worker-src blob:`（Chrome 直接拒装："Insecure CSP value
 * \"blob:\" in directive 'worker-src'"）。
 *
 * 所以这里生成两份东西，让宿主在 CSP 下把 blob 壳换成「同源代理文件」：
 *
 * 1. `vs/worker-proxy.js` —— 经典脚本 worker，从查询串读目标 worker 文件地址，原样复刻
 *    monaco blob 壳的三行语义（ttPolicy → importScripts → 发 ready 握手）；
 * 2. `vs/assets/worker-map.json` —— 把带哈希的 worker 文件名记成 `{editor,json,css,html,ts}`，
 *    哈希随版本变，宿主没法写死，这里拷贝时扫出来。
 *
 * 消费方在 `packages/agent-kit/src/features/files/MonacoEditor.tsx`（只在
 * `chrome-extension://` 下生效）。web / desktop 没有这份 CSP，继续走 monaco 原生 blob 壳。
 */
function writeCspWorkerShim(dest) {
  const vsDir = path.join(dest, 'vs')
  const assetsDir = path.join(vsDir, 'assets')
  if (!fs.existsSync(assetsDir)) return // 布局变了就不硬塞，免得写出半套坏产物

  // ① worker 文件名映射（哈希段 `[\w-]+` 兼容各版本的命名）
  const map = {}
  for (const file of fs.readdirSync(assetsDir)) {
    const m = /^(editor|json|css|html|ts)\.worker-[\w-]+\.js$/.exec(file)
    if (m) map[m[1]] = `assets/${file}`
  }
  if (Object.keys(map).length === 0) return
  fs.writeFileSync(path.join(vsDir, 'worker-map.json'), `${JSON.stringify(map, null, 2)}\n`)

  // ② 代理壳：与 monaco 的 blob 内容逐行对应（见 editor.main.js 里 defaultWorkerFactory）
  const proxy = `/*
 * Monaco worker 的同源代理壳（scripts/copy-monaco.cjs 生成，勿手改）。
 *
 * 与 monaco 自带的 blob 壳语义一致：注册 trustedTypes 策略 -> importScripts 目标 worker
 * -> 发 ready 握手。区别只有一处 —— 这里是**同源文件**（worker-src 'self' 可放行），
 * 而 blob 在 MV3 扩展页面的 CSP 下被 Chrome 禁掉。目标地址从查询串 ?u= 读（绝对地址、
 * 由宿主按 worker-map.json 算好），同源才放行，防滥用。
 */
const requested = new URLSearchParams(self.location.search).get('u')
if (!requested || !requested.startsWith(self.location.origin + '/')) {
  throw new Error('monaco-worker-proxy: 非同源的目标地址被拒绝：' + requested)
}
globalThis.workerttPolicy = globalThis.trustedTypes?.createPolicy('defaultWorkerFactory', {
  createScriptURL: (value) => value
})
importScripts(requested)
globalThis.postMessage({ type: 'vscode-worker-ready' })
`
  fs.writeFileSync(path.join(vsDir, 'worker-proxy.js'), proxy)
}
