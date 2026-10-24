/**
 * Fizz 服务端入口：装配应用 → 起 HTTP + WebSocket → 拉起「服务开着就该跑」的后台维护。
 *
 * 与 Next 版的分工对照：
 * - `server.mjs`（Next 自定义 server）→ 这里的 `createServer` 装配；
 * - `proxy.ts`（鉴权中间件）→ `app.ts` 里的 Hono 中间件；
 * - `instrumentation.ts`（启动钩子）→ 本文件末尾的后台启动段；
 * - `lib/server/ws.ts`（WS 分流）→ `attachWebSockets(server)`，一模一样。
 */
import { createServer } from 'node:http'
import { networkInterfaces } from 'node:os'
import { getRequestListener } from '@hono/node-server'
import { resolveDataDir } from '@fizz/workspace'
import { createApp, SERVER_INFO } from './app'
import { authEnabled } from './lib/auth-jwt'
import { captchaEnabled } from './lib/captcha'
import { attachWebSockets } from './server/ws'
import { installShutdownHandlers } from './server/shutdown'
import { killAllTerminalSessions } from './server/terminal/pty'
import { startBackgroundServices } from './server/background'
import { ENV_FILE, TOKEN } from './server/state'

/** 端口与监听地址：都有环境变量开关（部署时给固定值） */
const PORT = Number(process.env.FIZZ_PORT ?? 7801)
const HOST = process.env.FIZZ_HOST ?? '127.0.0.1'

/**
 * 绑到 0.0.0.0 时，从非回环网卡挑一个 IPv4 当「外部访问地址」打印出来：
 * 部署在服务器上时，这就是别人能用浏览器打开的入口。
 */
function externalUrl(port: number): string | null {
  if (HOST !== '0.0.0.0') return null
  const interfaces = networkInterfaces()
  for (const addrs of Object.values(interfaces)) {
    for (const addr of addrs ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) {
        return `http://${addr.address}:${port}`
      }
    }
  }
  return null
}

/** 起一个后台维护物：同步抛错与异步拒绝都只记日志，绝不拖住服务就绪 */
function runBackground(label: string, start: () => unknown): void {
  try {
    void Promise.resolve(start()).catch((err: unknown) => {
      console.error(`[${label}] 启动失败：`, err)
    })
  } catch (err) {
    console.error(`[${label}] 启动失败：`, err)
  }
}

const app = createApp()
const requestListener = getRequestListener(app.fetch)
/**
 * 主 HTTP 服务只服务**工作台**（Hono）。
 *
 * 容器预览走**独立的公网入口监听器**（`FIZZ_PUBLIC_HTTP_PORT`，见
 * `container-projects/public-gateway.ts`，由 `startBackgroundServices` 拉起），
 * 与这里各占一个端口 —— 主服务不再按 Host 分派预览。
 */
const server = createServer((req, res) => {
  requestListener(req, res)
})

// 所有 WS 端点（终端 / 节点工作台 / 全局状态 / 浏览器画面…）挂同一个端口
attachWebSockets(server)

server.listen(PORT, HOST, () => {
  console.log(`\n${SERVER_INFO.name} v${SERVER_INFO.version} 已启动`)
  console.log(`  监听：http://${HOST}:${PORT}`)
  const extUrl = externalUrl(PORT)
  if (extUrl) console.log(`  对外：${extUrl}  （浏览器打开即可使用）`)
  console.log(`  数据：${resolveDataDir()}`)
  if (authEnabled()) {
    console.log('  鉴权：已启用（用户名/密码换 JWT，见 FIZZ_AUTH_* / FIZZ_JWT_SECRET）')
    console.log(
      captchaEnabled()
        ? '  验证码：已启用（进程内滑块，FIZZ_AUTH_CAPTCHA=0 可关）'
        : '  验证码：已关闭（FIZZ_AUTH_CAPTCHA）'
    )
  } else {
    console.log('  ⚠️ 鉴权：未启用（未配置 FIZZ_AUTH_USER / FIZZ_AUTH_PASS / FIZZ_JWT_SECRET，全部放行）')
  }
  // 容器内 bridge 回传节点事件用的固定 token（不是登录用的 JWT，别混淆）
  console.log(`  容器回调 token：${TOKEN}`)
  if (ENV_FILE) {
    console.log(`  · 已加载 ${ENV_FILE.file}（补齐 ${ENV_FILE.keys.length} 项：${ENV_FILE.keys.join(', ')}）`)
  }
  console.log('')
})

// ---------------------------------------------------------------------------
// 后台维护（等价于 Next 版的 instrumentation.register）：不依赖有没有人打开浏览器
// ---------------------------------------------------------------------------

// 后台维护（定时任务调度器 / Flow 对账 / 性能采样器）—— 与桌面端
// 进程内后端共用同一份启动清单（见 ./server/background.ts）
runBackground('background', startBackgroundServices)

// ---------------------------------------------------------------------------
// 退出收尾
// ---------------------------------------------------------------------------

/**
 * 收尾顺序（见 `./server/shutdown.ts`）：停止接受新连接 → 收终端子进程 → 停任务轮询 →
 * 中止在跑的对话并等半截正文落盘 → 关队列 → `store.flush()`。整体 15 秒硬上限。
 *
 * ⚠️ `installShutdownHandlers` 里**已经**装了 `uncaughtException`（崩之前走一遍收尾）
 * 与 `unhandledRejection`（只记日志），所以这里不要再装一遍。
 */
installShutdownHandlers(
  () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve())
    })
)

// 进程退出前收掉所有 shell 子进程（Windows 不显式 kill 会留孤儿）
process.on('exit', killAllTerminalSessions)
