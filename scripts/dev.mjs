/**
 * 开发编排（替代 electron-vite 的 dev 流程）：
 * 1. 启动 Vite dev server（渲染进程，端口 5173）
 * 2. 首次构建 main / preload，随后以 --watch 模式增量构建
 * 3. main/preload 每次重新构建后自动重启 Electron
 */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const VITE_BIN = fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url))
const ELECTRON_BIN = fileURLToPath(new URL('../node_modules/electron/cli.js', import.meta.url))
const DEV_URL = 'http://localhost:5173'

const children = new Set()

function run(cmd, args, label, onLine = null) {
  const child = spawn(process.execPath, [cmd, ...args], {
    cwd: process.cwd(),
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
  console.log('[electron] 启动...')
  electronProc = spawn(
    process.execPath,
    [ELECTRON_BIN, '.'],
    {
      cwd: process.cwd(),
      env: { ...process.env, VITE_DEV_SERVER_URL: DEV_URL, ELECTRON_ENABLE_LOGGING: '1' },
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

const viteDev = run(VITE_BIN, [], 'vite', (line) => {
  if (line.includes('Local:')) console.log('[dev] 渲染进程 dev server 已就绪')
})

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
run(VITE_BIN, ['build', '-c', 'vite.main.mts', '--watch'], 'main:watch', onWatchReady('main'))
run(
  VITE_BIN,
  ['build', '-c', 'vite.preload.mts', '--watch'],
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
