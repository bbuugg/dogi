/**
 * 容器启动入口（镜像 `CMD` 就是它）。
 *
 * 顺序：
 * 1. 若工作区里有 `.fizz/container/start.mjs`（或 `start.cjs`），**后台**起它 —— 不等待、
 *    不阻塞；它崩溃 / 报错 / 语法非法 / 非 0 退出，都只写一行日志，绝不影响下一步。
 * 1'. 没有启动脚本、但镜像设了 `FIZZ_CONTAINER_AUTOSTART`（当前只有 Web 栈镜像的 `dev`）时，
 *    同一层里起 `/app/autostart.mjs`：空工作区铺内置模板 → 装依赖 → `npm run dev`。
 *    两者**互斥**：有启动脚本就完全听脚本的，两个都跑会抢同一个预览端口。
 * 2. 无论如何都加载 `/app/agent-host.mjs`（容器内 agent 控制面，常驻 HTTP 服务）。
 *
 * 为什么入口脚本必须跑在**子进程**里：需求是「脚本失败也不影响容器启动」，那就不能和
 * agent-host 待在同一个进程里 —— 入口脚本里一句 `process.exit()` 就能把整个控制面带下去。
 * 子进程天然隔离，退出码只用来打日志。自动启动同理（`npm install` 就可能跑几分钟，
 * 放在主线程里容器会一直是「不健康」）。
 *
 * ⚠️ 路径 `.fizz/container/start.mjs` 是**约定**，`@fizz/agent` 的系统提示词里有一份
 * （`buildContainerStartSection`），改名要两边一起改，否则模型会去写一个没人执行的文件。
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const WORKSPACE = '/workspace'
/** 优先 ESM（`start.mjs`），其次 CJS（`start.cjs`）—— `.js` 的语义取决于 package.json，不猜 */
const CANDIDATES = ['start.mjs', 'start.cjs'].map((file) => `${WORKSPACE}/.fizz/container/${file}`)
/** 镜像自带的自动启动命令（`ENV FIZZ_CONTAINER_AUTOSTART`）；缺省 = 不自动启动 */
const AUTOSTART = process.env.FIZZ_CONTAINER_AUTOSTART?.trim()

function log(message) {
  // 统一前缀：`docker logs <容器>` 里能一眼分出「启动脚本」和「Agent 控制面」的输出
  console.log(`[fizz-start] ${message}`)
}

/** 后台起一个进程；出错 / 退出都只打日志，返回 child（失败返回 null） */
function spawnBackground(label, file, args, env) {
  try {
    const child = spawn(file, args, {
      cwd: WORKSPACE,
      // inherit：脚本的 stdout / stderr 直接进容器日志（用户排查全靠它）
      stdio: 'inherit',
      env: { ...process.env, ...env }
    })
    child.on('error', (err) => log(`${label}无法执行（不影响容器）：${err?.message ?? err}`))
    child.on('exit', (code, signal) => {
      if (code === 0) log(`${label}已退出（code=0）`)
      else log(`${label}退出（code=${code} signal=${signal ?? '-'}），不影响容器继续运行`)
    })
    return child
  } catch (err) {
    log(`${label}执行失败（不影响容器）：${err?.message ?? err}`)
    return null
  }
}

/** 所有后台子进程，容器停止时一起收掉 */
const children = []

const script = CANDIDATES.find((path) => existsSync(path))

if (script) {
  log(`发现启动脚本：${script}`)
  const child = spawnBackground('启动脚本', process.execPath, [script], { FIZZ_CONTAINER_START: '1' })
  if (child) children.push(child)
} else if (AUTOSTART) {
  log(`没有 .fizz/container/start.mjs，走镜像自动启动（${AUTOSTART}）`)
  const child = spawnBackground('自动启动', process.execPath, ['/app/autostart.mjs'], {
    FIZZ_CONTAINER_AUTOSTART: AUTOSTART
  })
  if (child) children.push(child)
} else {
  log('没有 .fizz/container/start.mjs，跳过启动脚本')
}

/*
 * 容器停止时把后台进程一起收掉。**必须显式 process.exit()**：一旦给 SIGTERM 挂了 handler，
 * Node 的默认「收到就退」就被取消了 —— 不 exit 的话 `docker stop` 要干等 10s 再被 SIGKILL。
 * `autostart.mjs` 自己会把 npm 那一组一起收掉（见该文件），这里只负责把信号转下去。
 */
const forward = (signal) => {
  for (const child of children) {
    try {
      child.kill(signal)
    } catch {
      // 已经退了
    }
  }
  process.exit(0)
}
process.once('SIGTERM', () => forward('SIGTERM'))
process.once('SIGINT', () => forward('SIGINT'))

/*
 * 控制面：`agent-host.mjs` 顶层 `createServer().listen()`，import 进来即常驻。
 * 用 `pathToFileURL` 而不是直接 `import('/app/agent-host.mjs')`：绝对路径的 specifier
 * 在各平台上的解析规则不一样，转成 file URL 最稳。
 */
await import(pathToFileURL('/app/agent-host.mjs').href)
