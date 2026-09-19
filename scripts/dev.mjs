/**
 * 开发编排（替代 electron-vite 的 dev 流程）：
 * 1. 启动 Vite dev server（渲染进程，端口 5174）
 * 2. 首次构建 main / preload，随后以 --watch 模式增量构建
 * 3. main/preload 每次重新构建后自动重启 Electron
 */
import { spawn, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const VITE_BIN = fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url))
const ELECTRON_BIN = fileURLToPath(new URL('../node_modules/electron/cli.js', import.meta.url))
const DEV_URL = 'http://localhost:5174'
const PLUGINS_DIR = resolve(fileURLToPath(new URL('..', import.meta.url)), 'plugins')

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

// 构建 webview 模式插件（dist 产物由 webview 加载）
buildWebviewPlugins()

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

/**
 * 构建 webview 模式插件：扫描 plugins 目录，对含有 vite.config.ts 的插件
 * 执行 npm install（首次）+ vite build --watch，让 dev 期间改插件源码即时刷新。
 */
function buildWebviewPlugins() {
  if (!existsSync(PLUGINS_DIR)) return
  const entries = readdirSync(PLUGINS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
  for (const name of entries) {
    const dir = join(PLUGINS_DIR, name)
    const pkgPath = join(dir, 'package.json')
    const viteConfigPath = join(dir, 'vite.config.ts')
    if (!existsSync(pkgPath) || !existsSync(viteConfigPath)) continue

    // 首次安装依赖
    const nodeModulesPath = join(dir, 'node_modules')
    if (!existsSync(nodeModulesPath)) {
      console.log(`[plugins] 安装依赖：${name}`)
      try {
        execFileSync('npm', ['install', '--no-fund', '--no-audit'], {
          cwd: dir,
          stdio: 'inherit',
          shell: true
        })
      } catch (e) {
        console.error(`[plugins] ${name} 安装依赖失败`, e)
        continue
      }
    }

    // watch 模式构建
    console.log(`[plugins] 启动构建 watch：${name}`)
    const child = spawn(process.execPath, [VITE_BIN, 'build', '--watch'], {
      cwd: dir,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    children.add(child)
    const prefix = `[plugin:${name}]`
    const pipe = (stream, isError) => {
      stream.setEncoding('utf8')
      stream.on('data', (chunk) => {
        for (const line of chunk.split('\n')) {
          if (line.trim()) {
            if (isError) console.error(prefix, line)
            else console.log(prefix, line)
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
  }
}

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
