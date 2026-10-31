/**
 * 服务端开发编排：`vite build --watch` + 产物变化后自动重启。
 *
 * 为什么需要它：`dev:server` 原本是 `node apps/server/dist/index.js`，跑的是构建产物，
 * 改 `packages/*` 或 `apps/server/src` **不会**生效 —— 必须手动 `build:server` 再重启，
 * 忘了就会对着旧代码排查（踩过：改完后端重试逻辑，实际跑的还是前一天打进去的代码）。
 *
 * 这里的做法与 `scripts/dev.mjs`（桌面端）同构：vite 自己的 `--watch` 负责增量构建，
 * 我们从它的输出里认 `built in` 那一行，等构建**落盘完成**再重启 node —— 不额外引
 * chokidar / nodemon 之类依赖，也不用猜 dist 里哪个 chunk 变了。
 */
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// 与 dev.mjs 同一个理由：Windows 控制台默认 GBK，服务端日志里的中文会成乱码
if (process.platform === 'win32') {
  try {
    spawnSync('cmd', ['/c', 'chcp', '65001'], { stdio: 'inherit' })
  } catch {
    /* 失败也不阻塞启动 */
  }
}

const VITE_BIN = fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url))
/** 仓库根（scripts/ 的上一级）；npm 脚本的 cwd 就是它 */
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const SERVER_CONFIG = 'apps/server/vite.config.ts'
const SERVER_ENTRY = 'apps/server/dist/index.js'
/** 构建完成到重启之间的静默窗口：一次改动常触发多轮增量构建，攒一攒再重启 */
const RESTART_DELAY_MS = 400

const children = new Set()
let shuttingDown = false

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

/** Windows 上 kill 单个 pid 杀不掉它的孙子进程（服务端会起子进程 / PTY），这里整棵树杀 */
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

let serverProc = null
let restartTimer = null
let started = false

/**
 * 启动服务端。`stdio: 'inherit'`：它的日志直接进当前终端（排查一轮对话时最常看的就是它）。
 */
function startServer() {
  killTree(serverProc)
  serverProc = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: REPO_ROOT,
    env: { ...process.env },
    stdio: 'inherit'
  })
  serverProc.on('exit', (code) => {
    if (shuttingDown) return
    // 非 0 多半是端口被占 / 配置写错：不要自动重启，否则会一秒钟刷满屏
    if (code !== null && code !== 0) {
      console.error(`[server] 退出，退出码 ${code}（改动文件后会自动重启）`)
    }
  })
}

function scheduleRestart() {
  clearTimeout(restartTimer)
  restartTimer = setTimeout(() => {
    if (shuttingDown) return
    console.log('[dev] 服务端已重建，重启')
    startServer()
  }, RESTART_DELAY_MS)
}

console.log('[dev] 首次构建中（约 7s），完成后启动服务端…')
run(VITE_BIN, ['build', '-c', SERVER_CONFIG, '--watch'], 'server:watch', (line) => {
  if (!/built in/i.test(line)) return
  // 首次构建只启动一次；之后的每次重建都重启（`started` 保证不会被首轮的多次输出骗到）
  if (!started) {
    started = true
    console.log('[dev] 首次构建完成，启动服务端')
    startServer()
    return
  }
  scheduleRestart()
})

function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  console.log('\n[dev] 正在退出...')
  clearTimeout(restartTimer)
  killTree(serverProc)
  for (const child of children) killTree(child)
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
