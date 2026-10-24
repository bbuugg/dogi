/**
 * 开发编排（替代 electron-vite 的 dev 流程）：
 * 1. 启动 Vite dev server（渲染进程）
 * 2. 首次构建 main / preload，随后以 --watch 模式增量构建
 * 3. main/preload 每次重新构建后自动重启 Electron
 *
 * 默认编排**根应用**；`--app <dir>` 可换成 workspace 里的另一个 Electron 应用
 * （如 `npm run dev:desktop` → `--app apps/desktop`）：渲染端 vite 配置、dev 端口与
 * Electron 启动目录都跟着它走，vite / electron 二进制仍从仓库根解析。
 */
import { spawn, spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// 启动前把 Windows 控制台代码页切到 UTF-8（65001）。
// dev 用 stdio:'inherit' 把 Electron 输出直接继承到当前终端，
// 若终端是 GBK/CP936，main/preload 里的中文 console.log 会被当成 GBK 显示成乱码。
if (process.platform === 'win32') {
  try {
    spawnSync('cmd', ['/c', 'chcp', '65001'], { stdio: 'inherit' })
  } catch {
    /* 失败也不阻塞启动 */
  }
}

const VITE_BIN = fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url))
const ELECTRON_BIN = fileURLToPath(new URL('../node_modules/electron/cli.js', import.meta.url))
/** 仓库根（scripts/ 的上一级）；npm 脚本的 cwd 就是它 */
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))

/** `--app apps/desktop`：为空表示编排根应用 */
function parseAppDir(argv) {
  const index = argv.indexOf('--app')
  const value = index >= 0 ? argv[index + 1] : ''
  return value ? value.replace(/\\/g, '/').replace(/\/+$/, '') : ''
}

const APP_DIR = parseAppDir(process.argv.slice(2))
/** 应用目录（绝对路径）：Electron 在这里启动，读它的 package.json main */
const APP_ROOT = APP_DIR ? resolve(REPO_ROOT, APP_DIR) : REPO_ROOT
/** 相对应用目录的 vite 配置名（根应用用仓库根的默认配置） */
const MAIN_CONFIG = APP_DIR ? `${APP_DIR}/vite.main.mts` : 'vite.main.mts'
const PRELOAD_CONFIG = APP_DIR ? `${APP_DIR}/vite.preload.mts` : 'vite.preload.mts'
/** 渲染端：根应用靠默认的 vite.config.ts；子应用显式指定 */
const RENDERER_ARGS = APP_DIR ? ['--config', `${APP_DIR}/vite.config.ts`] : []
const DEV_URL = APP_DIR ? 'http://localhost:5175' : 'http://localhost:5174'

const children = new Set()

function run(cmd, args, label, onLine = null) {
  const child = spawn(process.execPath, [cmd, ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  children.add(child)
  const prefix = `[${label}]`
  const pipe = (stream, isError) => {
    let buffer = ''
    stream.setEncoding('utf8')
    stream.on('data', (chunk) => {
      buffer += chunk
      let index
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        if (line.trim()) {
          if (isError) console.error(prefix, line)
          else console.log(prefix, line)
          onLine?.(line)
        }
      }
    })
  }
  pipe(child.stdout, false)
  pipe(child.stderr, true)
  child.on('exit', (code) => {
    children.delete(child)
    if (code !== null && code !== 0 && !shuttingDown) {
      console.error(`${prefix} 异常退出，退出码 ${code}`)
    }
  })
  return child
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

let shuttingDown = false
let electronProc = null
let restartTimer = null

function startElectron() {
  killTree(electronProc)
  console.log(`[electron] 启动（${APP_DIR || '根应用'}）...`)
  electronProc = spawn(
    process.execPath,
    [ELECTRON_BIN, '.'],
    {
      cwd: APP_ROOT,
      env: {
        ...process.env,
        VITE_DEV_SERVER_URL: DEV_URL,
        // 渲染端 console 也进当前终端（桌面端的请求走 IPC，DevTools 的 Network 面板是空的）
      },
      stdio: 'inherit'
    }
  )
  electronProc.on('exit', (code) => {
    if (!shuttingDown) console.log(`[electron] 退出（${code}）`)
  })
}

function scheduleElectronRestart() {
  clearTimeout(restartTimer)
  restartTimer = setTimeout(() => {
    console.log('[dev] main/preload 已重建，重启 Electron')
    startElectron()
  }, 400)
}

const viteDev = run(VITE_BIN, RENDERER_ARGS, 'vite', (line) => {
  if (line.includes('Local:')) console.log('[dev] 渲染进程 dev server 已就绪')
})
void viteDev

// 等 main / preload 的 watch 模式各自完成首次构建后再启动 Electron，之后重建则自动重启
const watchedReady = new Set()
let electronStarted = false
function onWatchReady(label) {
  return (line) => {
    if (!/built in/i.test(line)) return
    watchedReady.add(label)
    if (!electronStarted && watchedReady.size === 2) {
      electronStarted = true
      startElectron()
    } else if (electronStarted) {
      scheduleElectronRestart()
    }
  }
}
run(VITE_BIN, ['build', '-c', MAIN_CONFIG, '--watch'], 'main:watch', onWatchReady('main'))
run(
  VITE_BIN,
  ['build', '-c', PRELOAD_CONFIG, '--watch'],
  'preload:watch',
  onWatchReady('preload')
)

function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  console.log('\n[dev] 正在退出...')
  clearTimeout(restartTimer)
  for (const child of children) killTree(child)
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
