/**
 * 镜像自带的「空工作区自动铺模板 → 装依赖 → 起 dev server」。
 *
 * 谁会用：镜像设了 `FIZZ_CONTAINER_AUTOSTART`（当前是 `fizz/agent-vite` 与
 * `fizz/agent-nextjs`），**并且**工作区里没有 `.fizz/container/start.mjs|cjs` —— 有启动脚本就
 * 完全按脚本走，这里一秒都不跑（两个都跑会抢同一个预览端口）。判定在 `bootstrap.mjs` 里。
 *
 * ⚠️ 与启动脚本同一层隔离：本文件整体在**子进程**里跑（见 bootstrap.mjs 的文件头），
 * 铺模板 / npm install / dev server 任何一步失败都只写 `[fizz-start]` 日志并退出，
 * **绝不影响容器与 Agent 控制面** —— 这是「内部程序挂了也要能起容器」的实现方式。
 *
 * 端口：`FIZZ_PREVIEW_PORT` 由宿主 `docker run -e` 注入（按镜像分配：Vite / Next.js 镜像都是 3000）。
 * 必须原样透给 dev server 并绑 `0.0.0.0`，否则宿主映射进来的流量到不了（页面空白且不报错）。
 */
import { spawn, spawnSync } from 'node:child_process'
import { cpSync, existsSync } from 'node:fs'

const WORKSPACE = '/workspace'
const STARTER = process.env.FIZZ_STARTER?.trim() || '/opt/fizz/starter'
const COMMAND = process.env.FIZZ_CONTAINER_AUTOSTART?.trim() || 'dev'
const PORT = process.env.FIZZ_PREVIEW_PORT?.trim() || '3000'

/*
 * 传给 dev server 的参数。
 *
 * 默认值就是 **Vite 的形状**（`--host 0.0.0.0 --port <p> --strictPort`），历史行为不变；
 * 但别的框架的 CLI 不认这套 —— `next dev` 的 host 是 `-H/--hostname`，而且**没有**
 * `--strictPort`（多给一个不认识的参数会直接报错退出）。所以镜像可以自带一份：
 *
 *   ENV FIZZ_AUTOSTART_ARGS="-H 0.0.0.0 -p {port}"
 *
 * `{port}` 在这里替换成实际的预览端口（镜像里写不了运行期才知道的值）。
 * 按空白切分，不支持带空格的单个参数 —— 参数本来就都是 `-H 0.0.0.0` 这种短片段。
 */
const RAW_ARGS = process.env.FIZZ_AUTOSTART_ARGS?.trim() || ''
const DEV_ARGS = RAW_ARGS
  ? RAW_ARGS.split(/\s+/).map((arg) => arg.replaceAll('{port}', PORT))
  : ['--host', '0.0.0.0', '--port', PORT, '--strictPort']

function log(message) {
  // 与 bootstrap 同一个前缀：`docker logs <容器>` 里一眼分清「启动相关」和「Agent 控制面」
  console.log(`[fizz-start] ${message}`)
}

/** 同步跑一条命令并记日志；失败只返回 false（调用方决定继续还是放弃） */
function run(cmd, args, label) {
  log(`${label}：${cmd} ${args.join(' ')}`)
  const result = spawnSync(cmd, args, { cwd: WORKSPACE, stdio: 'inherit', env: process.env })
  if (result.error) {
    log(`${label}失败：${result.error.message}`)
    return false
  }
  if (result.status !== 0) {
    log(`${label}失败（exit=${result.status}）`)
    return false
  }
  return true
}

/*
 * 1. 空工作区铺模板。
 *
 * 判据是 `package.json` 而不是「目录是不是空的」：用户可能先 `git clone` 了仓库、或者只建了
 * 一个 `.fizz/`，这时候模板不能进去捣乱。`force: false` + `errorOnExist: false` 保证
 * **只补缺的文件**，工作区里已有的内容一个字节都不覆盖。
 */
if (existsSync(`${WORKSPACE}/package.json`)) {
  log('工作区已有 package.json，跳过铺模板')
} else if (!existsSync(STARTER)) {
  log(`镜像里没有模板目录 ${STARTER}，跳过自动启动`)
  process.exit(0)
} else {
  log(`工作区还没有 package.json，铺模板：${STARTER} → ${WORKSPACE}`)
  try {
    cpSync(STARTER, WORKSPACE, { recursive: true, force: false, errorOnExist: false })
  } catch (err) {
    log(`铺模板失败（不影响容器）：${err?.message ?? err}`)
    process.exit(0)
  }
}

/*
 * 2. 依赖：镜像里的模板已经带 `node_modules`（构建时装好），拷过来就有；
 *    工作区是用户自己的代码时才会走到 install。失败仍然往下试 —— dev server 会自己报错，
 *    报错进日志比这里默默放弃有用。
 */
if (!existsSync(`${WORKSPACE}/node_modules`)) {
  run('npm', ['install', '--no-audit', '--no-fund'], '安装依赖')
}

/*
 * 3. 起 dev server。
 *
 * `detached` 让它自成进程组（npm 是组首）：容器停止时 bootstrap 只会给本进程发 SIGTERM，
 * 本进程再按组转发，npm 拉起的 dev server 才不会变成孤儿继续占着端口。
 * `DEV_ARGS` 默认带 `--strictPort`：端口被占就直接失败，别偷偷换一个 —— 换了 = 预览空白
 * 且无报错（Next 没有这个开关，它换端口同样会在这里表现为「端口对不上」，见镜像里的注释）。
 */
const child = spawn(
  'npm',
  ['run', COMMAND, '--', ...DEV_ARGS],
  {
    cwd: WORKSPACE,
    stdio: 'inherit',
    detached: true,
    env: { ...process.env, PORT, FIZZ_PREVIEW_PORT: PORT }
  }
)

let stopping = false
const stop = (signal) => {
  if (stopping) return
  stopping = true
  try {
    process.kill(-child.pid, signal)
  } catch {
    // 已经退了
  }
  process.exit(0)
}
process.once('SIGTERM', () => stop('SIGTERM'))
process.once('SIGINT', () => stop('SIGINT'))

child.on('error', (err) => {
  log(`dev server 起不来：${err?.message ?? err}`)
  // 起不来就别挂着空壳（bootstrap 那边据此记一行退出日志，容器本身照常跑）
  process.exit(0)
})
child.on('exit', (code, signal) => {
  log(`dev server 退出（code=${code} signal=${signal ?? '-'}），不影响容器；修好后重启容器即可`)
  // 别留一个空壳在这里，否则 docker logs 里看不出「服务已经没了」
  process.exit(0)
})
