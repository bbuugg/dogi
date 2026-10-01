/**
 * 多开一个 dev 实例（配合 `npm run dev` 使用，可重复执行若干次）。
 *
 * 为什么不直接再跑一次 `npm run dev`：dev.mjs 里 dev server 端口（5174）写死，
 * 第二个 Vite 会抢端口；而且两个 main/preload watcher 会同时往 out/ 写构建产物互相覆盖。
 * 所以本脚本**只**起 Electron，复用已经在跑的 5174 dev server：不启 vite、不 watch。
 *
 * 代价（知情再用）：
 * - dev 模式下主进程不申请单实例锁（见 src/main/index.ts），所以这个窗口能正常起来。
 * - 额外实例跑的是**启动那一刻**的 main/preload 构建产物；dev.mjs 的自动重启只管它自己
 *   那个实例，改了 main 想让这个窗口也拿到新代码，重跑一次本脚本即可（渲染端是 HMR，不受影响）。
 * - 所有实例共用同一份 userData（%APPDATA%\dogi），配置 / 标签页状态 / 窗口位置会互相覆盖。
 *
 * 用法：先 `npm run dev`，再另开一个终端 `npm run dev:extra`（可多次）。
 */
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// 与 dev.mjs 保持一致：dev 用 stdio:'inherit' 把 Electron 输出继承到当前终端，
// 终端是 GBK/CP936 时 preload/main 里的中文日志会显示成乱码。
if (process.platform === 'win32') {
  try {
    spawnSync('cmd', ['/c', 'chcp', '65001'], { stdio: 'inherit' })
  } catch {
    /* 失败也不阻塞启动 */
  }
}

const ELECTRON_BIN = fileURLToPath(new URL('../node_modules/electron/cli.js', import.meta.url))
const DEV_URL = 'http://localhost:5174'

/** 确认 dev server 已经起来了 —— 否则 Electron 会 loadURL 失败，窗口一直白屏很难排查 */
async function ensureDevServer() {
  try {
    await fetch(DEV_URL, { signal: AbortSignal.timeout(2000) })
  } catch {
    console.error(`[dev:extra] ${DEV_URL} 没响应，请先在另一个终端跑 \`npm run dev\``)
    process.exit(1)
  }
}

function killTree(child) {
  if (!child || child.exitCode !== null) return
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {
      child.kill('SIGKILL')
    }
  }
}

await ensureDevServer()
console.log(`[dev:extra] 复用 ${DEV_URL} 再起一个 Electron 实例（关掉本窗口 / Ctrl+C 即结束该实例）`)

const electronProc = spawn(process.execPath, [ELECTRON_BIN, '.'], {
  cwd: process.cwd(),
  env: { ...process.env, VITE_DEV_SERVER_URL: DEV_URL, ELECTRON_ENABLE_LOGGING: '1' },
  stdio: 'inherit'
})

let shuttingDown = false
function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  killTree(electronProc)
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

electronProc.on('exit', (code) => {
  console.log(`[dev:extra] 实例已退出（${code}）`)
  if (!shuttingDown) process.exit(code ?? 0)
})
