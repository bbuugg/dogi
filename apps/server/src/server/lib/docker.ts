/**
 * docker 封装 —— 只做「探测 / 起停容器 / 看状态 / 收尸」这几件通用的事。
 *
 * 使用方：容器型项目（`container-projects/*`）。
 * 具体怎么起容器（挂载、环境变量、端口）由调用方拼 `CreateContainerSpec`，这里不掺业务语义。
 *
 * ## 为什么是 dockerode（而不是 `docker` CLI）
 *
 * CLI 每次调用都要 spawn 一个 `docker.exe`：Windows 上一条 `docker ps` 光进程创建就
 * 80–150ms，而 `state-ws` 稳态 10s 一拍、变化期 1.5s 一拍，每拍两条命令 —— 这是纯 CPU 浪费
 * （历史上「无条件 1.5s 一拍把 dockerd 顶满一个核」就是它）。dockerode 复用一条
 * npipe / unix socket 连接，同样的 `ps` 约 1–3ms。
 *
 * ## 镜像构建不在这里
 *
 * 容器型项目的镜像构建（`docker build` 仍走 CLI，理由见 `container-projects/image.ts`）
 * 由那个模块自己管 —— 这里只提供 `findRepoRoot()` 与探测原语。
 *
 * ## 一个出口
 *
 * 全仓库只许从这里碰 docker。`container-projects/lifecycle.ts` 以前自己复制了一份
 * `dockerRun`，现在统一走下面的语义方法。
 */
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import Docker from 'dockerode'

// ---------- 连接 ----------

/**
 * 进程内唯一的 dockerode 实例。
 *
 * 不传参：dockerode 自己读 `DOCKER_HOST`，没有就按平台取默认值
 * （Windows `//./pipe/docker_engine`，macOS / Linux 优先 Docker Desktop 的
 * `$HOME/.docker/run/docker.sock`，回落到 `/var/run/docker.sock`）。
 * 连接是**惰性**的 —— `new Docker()` 不碰 socket，第一次请求才连，
 * 所以「Docker Desktop 没启动」不会在模块加载时炸。
 */
let instance: Docker | null = null

function client(): Docker {
  instance ??= new Docker()
  return instance
}

/** socket 层连不上的 errno（Docker Desktop 没启动 / 管道不存在 / 没权限） */
const CONNECTION_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOENT',
  'EPIPE',
  'ETIMEDOUT',
  'EACCES',
  'EHOSTUNREACH'
])

/**
 * 是不是「引擎连不上」这类错误。
 *
 * 判 errno 优先，正则只作兜底：dockerode 在 socket 出错时会把底层 errno 挂在 `err.code`，
 * 但 Windows 命名管道不存在时报的是 `ENOENT`，而某些代理层只会留下一句文本。
 */
export function isDockerConnectionError(err: unknown, depth = 0): boolean {
  if (!err || typeof err !== 'object') return false
  const code = (err as { code?: unknown }).code
  if (typeof code === 'string' && CONNECTION_CODES.has(code)) return true
  const message = err instanceof Error ? err.message : String(err)
  if (
    /error during connect|cannot connect|connection refused|pipe is closed|socket hang up|ECONNREFUSED|ENOENT/i.test(
      message
    )
  ) {
    return true
  }
  // `startContainer` / `stopContainer` 会把原始错误包一层，errno 留在 cause 里
  return depth < 3 && isDockerConnectionError((err as { cause?: unknown }).cause, depth + 1)
}

/** 把 dockerode 的错误翻成一句能直接显示给人看的话 */
function dockerErrorMessage(err: unknown): string {
  if (isDockerConnectionError(err)) {
    return '连不上 docker 引擎（Docker Desktop 没启动，或当前用户没有访问它的权限）'
  }
  // daemon 的 `{"message": "..."}` 比 dockerode 拼的 `(HTTP code 404) ...` 好读
  const json = (err as { json?: { message?: unknown } } | null)?.json
  if (json && typeof json.message === 'string' && json.message) return json.message
  return err instanceof Error ? err.message : String(err)
}

/** dockerode 的 404 */
function isNotFound(err: unknown): boolean {
  return (err as { statusCode?: unknown } | null)?.statusCode === 404
}

/** dockerode 的 304（start / stop 撞上「已经在这个状态」） */
function isNotModified(err: unknown): boolean {
  return (err as { statusCode?: unknown } | null)?.statusCode === 304
}

/**
 * Windows 盘符路径 → 正斜杠。
 *
 * Docker Desktop 的 bind 挂载认 `D:/a/b` 这种形式；反斜杠会被当成转义，直接报
 * `invalid volume specification`。非 Windows 原样返回。
 */
export function toDockerPath(path: string): string {
  return process.platform === 'win32' ? path.replace(/\\/g, '/') : path
}

// ---------- 探测 ----------

let lastDockerError: string | undefined

/**
 * `docker version` 成功结果的缓存（毫秒）。
 *
 * 这条命令的答案几十秒内不会变，而它**每条消息都要跑一次**（`doStart` /
 * `ensureContainerImage` / 设置页快照）。换成 dockerode 后单次只要 1–3ms，
 * 但「每条消息都问一次 daemon」仍然没有必要 —— 按时间缓存，代价是零。
 *
 * **只缓存成功**：失败必须现问（daemon 什么时候挂的说不准）。「docker 不可用」那层
 * 60s 的失败缓存在 `container-projects/lifecycle.ts` 的 `dockerReason` 里，不在这里。
 */
const DOCKER_VERSION_TTL_MS = 30_000
let dockerVersionCache: { at: number; version: string } | null = null

/**
 * Windows 上 Docker Desktop 的命名管道**不止一个**：
 *
 * - `//./pipe/docker_engine` —— 旧版 / 兼容别名，dockerode 的默认值；
 * - `//./pipe/dockerDesktopLinuxEngine` —— 4.x 的 Linux 容器模式，`docker` CLI 按
 *   context（`desktop-linux`）解析到这里。
 *
 * ⚠️ dockerode **不读** `~/.docker/config.json` 的 `currentContext`，只会用默认那个。
 * 于是可能出现「`docker ps` 能跑、服务端连不上」的回归。默认管道连不上时按这张表
 * 再探一次，探到就换掉单例（见 `probeWindowsPipes`）。
 */
const WINDOWS_PIPE_CANDIDATES = [
  '//./pipe/docker_engine',
  '//./pipe/dockerDesktopLinuxEngine'
] as const

/**
 * 换一个 Windows 管道再试（只在默认值失败后调用）。
 *
 * 返回换成功后的 daemon 版本；全都连不上返回 null（**不动**原来的单例，让调用方
 * 走「docker 不可用」那条路）。`DOCKER_HOST` 已显式指定时不参与 —— 用户说了算。
 */
async function probeWindowsPipes(): Promise<string | null> {
  if (process.platform !== 'win32' || process.env.DOCKER_HOST?.trim()) return null
  for (const socketPath of WINDOWS_PIPE_CANDIDATES) {
    // 第一个就是默认值，刚失败过，跳过
    if (socketPath === WINDOWS_PIPE_CANDIDATES[0]) continue
    const candidate = new Docker({ socketPath })
    try {
      const info = await candidate.version()
      instance = candidate
      return info?.Version || 'unknown'
    } catch {
      // 这个管道也没有，继续
    }
  }
  return null
}

/**
 * docker 守护进程版本；不可达返回 null 并把原因记在 `lastDockerError`。
 *
 * 注意探的是 **daemon**（`version()` 的 `Version`）而不是客户端：Docker Desktop
 * 没启动时连 socket 都打不开，这里直接进 catch。
 */
export async function dockerVersion(): Promise<string | null> {
  const cached = dockerVersionCache
  if (cached && Date.now() - cached.at < DOCKER_VERSION_TTL_MS) return cached.version
  try {
    const info = await client().version()
    lastDockerError = undefined
    const version = info?.Version || 'unknown'
    dockerVersionCache = { at: Date.now(), version }
    return version
  } catch (err) {
    // 失败就别留着旧的成功结果：下一次必须真的去问
    dockerVersionCache = null
    // Windows：dockerode 不读 docker context，默认管道名可能不是 Desktop 实际用的那个
    const fallback = await probeWindowsPipes()
    if (fallback) {
      lastDockerError = undefined
      dockerVersionCache = { at: Date.now(), version: fallback }
      return fallback
    }
    lastDockerError = dockerErrorMessage(err)
    return null
  }
}

export function dockerUnavailableReason(): string | undefined {
  return lastDockerError
}

/**
 * 把「刚才那条 docker 调用」的错误记进 `dockerUnavailableReason` —— **只在连接类错误时**。
 *
 * 为什么需要：`dockerVersion()` 是唯一会清 `lastDockerError` 的入口，而它成功与否是另一件
 * 事。典型场景：容器**在跑**，之后 Docker Desktop 被关掉 —— `dockerVersion()` 有 30s 成功
 * 缓存（见 `DOCKER_VERSION_TTL_MS`），这期间它照旧回答「有 docker」，可真去 `docker ps` /
 * `docker stop` 时连接已经断了。不记下来，界面就只有一句「容器还在跑」，而实际点停止会
 * 静默失败、点启动也起不来。
 *
 * 非连接类错误（404 / 409 / 304 这类业务错）**不记**：它们说明引擎是活的，记成「不可用」
 * 会把一个能自愈的问题放大成「整块功能没装」。
 */
export function noteDockerFailure(err: unknown): void {
  if (isDockerConnectionError(err)) lastDockerError = dockerErrorMessage(err)
}

// ---------- 镜像 ----------

/**
 * 镜像是否存在。
 *
 * **任何失败都当「不存在」**（与 CLI 版的 `code !== 0` 同口径）：调用方紧接着会去
 * `docker build`，构建失败时给出的错误比「inspect 失败」更具体。
 */
export async function imageExists(tag: string): Promise<boolean> {
  try {
    await client().getImage(tag).inspect()
    return true
  } catch {
    return false
  }
}

/** 镜像的两个可展示事实（设置页「容器」用；不存在时返回 null） */
export interface DockerImageFacts {
  /** 字节 */
  sizeBytes: number
  /** 构建时间（毫秒） */
  createdAt: number
}

/**
 * 读镜像的大小与构建时间。**不存在 / 输出形状不对一律 null** —— 调用方只把它当展示信息，
 * 不该因为一条解析失败把整个快照打成错误。
 */
export async function inspectImage(tag: string): Promise<DockerImageFacts | null> {
  try {
    const info = await client().getImage(tag).inspect()
    const sizeBytes = Number(info?.Size)
    const createdAt = Date.parse(String(info?.Created ?? ''))
    if (!Number.isFinite(sizeBytes) || !Number.isFinite(createdAt)) return null
    return { sizeBytes, createdAt }
  } catch {
    return null
  }
}

// ---------- 容器 ----------

/** `listContainers` 的一行（把 dockerode 的 `ContainerInfo` 收成我们关心的四个字段） */
export interface ListedContainer {
  /** 容器名（去掉了 API 返回的前导 `/`） */
  name: string
  /** `running` / `exited` / `created` … */
  state: string
  running: boolean
  labels: Record<string, string>
  /** 容器内端口 → 宿主端口。**停着的容器这里是空的**（`docker ps` 不给未运行容器的映射） */
  ports: Map<number, number>
}

/**
 * 列容器（一条请求拿全，与项目数量无关）。
 *
 * `all` 默认 true：冷启动要 `start` 停着的容器，得先看见它。
 */
export async function listContainers(
  opts: { all?: boolean; label?: string } = {}
): Promise<ListedContainer[]> {
  const filters: Record<string, string[]> = {}
  if (opts.label) filters.label = [opts.label]
  const raw = await client().listContainers({ all: opts.all ?? true, filters })
  return raw.map((item) => {
    const ports = new Map<number, number>()
    for (const port of item.Ports ?? []) {
      if (port.Type !== 'tcp' || !port.PublicPort) continue
      ports.set(Number(port.PrivatePort), Number(port.PublicPort))
    }
    return {
      name: String(item.Names?.[0] ?? '').replace(/^\//, ''),
      state: String(item.State ?? ''),
      running: item.State === 'running',
      labels: item.Labels ?? {},
      ports
    }
  })
}

/** 容器状态（`inspect` 的子集）+ 端口映射 */
export interface ContainerState {
  /** docker 的 .State.Status：created / running / exited / dead … */
  status: string
  running: boolean
  exitCode: number
  startedAt?: string
  finishedAt?: string
  error?: string
  oomKilled?: boolean
  /** 容器内端口 → 宿主端口（inspect 对停着的容器也给，比 `docker ps` 全） */
  ports: Map<number, number>
  /**
   * bind 挂载的原始串（`宿主机路径:容器内路径[:ro]`）。
   *
   * 目前只有一个用途：判断一个容器是不是**本实例**的（宿主侧路径落在本项目的数据目录下）。
   * `listContainers` 不返回挂载，所以只有 inspect 拿得到。
   */
  binds: string[]
}

/**
 * 容器状态；容器不存在返回 null（不算错误 —— 容器跑完被清掉是正常的）。
 *
 * 与 `listContainers` 的分工：这个多给 `exitCode` / `oomKilled` / 停止容器的端口，
 * 但一次只问一个容器 —— 批量场景用 `listContainers`，别在循环里调它。
 */
export async function inspectContainer(name: string): Promise<ContainerState | null> {
  try {
    const info = await client().getContainer(name).inspect()
    const state = info.State
    const ports = new Map<number, number>()
    for (const [key, bindings] of Object.entries(info.NetworkSettings?.Ports ?? {})) {
      const containerPort = Number(key.split('/')[0])
      const hostPort = Number(bindings?.[0]?.HostPort ?? NaN)
      if (Number.isFinite(containerPort) && Number.isFinite(hostPort)) {
        ports.set(containerPort, hostPort)
      }
    }
    return {
      status: String(state?.Status ?? 'unknown'),
      running: state?.Running === true,
      exitCode: typeof state?.ExitCode === 'number' ? state.ExitCode : 0,
      ...(state?.StartedAt ? { startedAt: state.StartedAt } : {}),
      ...(state?.FinishedAt ? { finishedAt: state.FinishedAt } : {}),
      ...(state?.Error ? { error: state.Error } : {}),
      ...(state?.OOMKilled === true ? { oomKilled: true } : {}),
      ports,
      binds: info.HostConfig?.Binds ?? []
    }
  } catch {
    return null
  }
}

/** 容器现在在跑吗（不存在 / 连不上都算「没在跑」） */
export async function isContainerRunning(name: string): Promise<boolean> {
  const state = await inspectContainer(name)
  return state?.running === true
}

/** 一个端口映射：容器内 `containerPort` → 宿主 `hostPort` */
export interface PortBindingSpec {
  containerPort: number
  hostPort: number
  /**
   * 绑到哪个宿主地址。默认 `0.0.0.0`（与 `docker -p 8080:80` 一致）。
   *
   * 只给回环用的服务（agent 控制面、预览服务）**必须显式传 `127.0.0.1`** ——
   * 否则等于把它开在局域网上。
   */
  hostIp?: string
}

/**
 * 起一个容器所需的全部输入（`container-projects/lifecycle.ts`）。
 *
 * 字段与 `docker run` 的开关一一对应，改这里时对照 `createSpecOf` 的注释。
 */
export interface CreateContainerSpec {
  name: string
  image: string
  /** 空值会被丢掉（与 `docker run -e KEY=` 不同：这里不注入空串） */
  env?: Record<string, string>
  labels?: Record<string, string>
  /** `宿主机路径:/容器内路径`，宿主机路径要先过 `toDockerPath` */
  binds?: string[]
  ports?: PortBindingSpec[]
  /** `unless-stopped` / `always` … 不给 = docker 默认（no） */
  restartPolicy?: string
  /** 容器里会 spawn 子进程时开它（负责收尸，避免僵尸） */
  init?: boolean
  /** 内存上限（MB）；0 / 不给 = 不限制 */
  memoryMb?: number
  /** CPU 上限（核数）；0 / 不给 = 不限制 */
  cpus?: number
  /** `host.docker.internal:host-gateway` 这类额外 hosts 项 */
  extraHosts?: string[]
}

/**
 * 建容器（**不启动**）。
 *
 * 拆成 create + start 两步而不是一个 `run`：调用方需要区分「建失败」（镜像/参数问题）
 * 和「启动失败」（端口冲突 / 半截容器），而且重建前要先 `removeContainer`。
 */
export async function createContainer(spec: CreateContainerSpec): Promise<string> {
  const exposedPorts: Record<string, Record<string, never>> = {}
  const portBindings: Record<string, Array<{ HostIp: string; HostPort: string }>> = {}
  for (const port of spec.ports ?? []) {
    const key = `${port.containerPort}/tcp`
    exposedPorts[key] = {}
    portBindings[key] = [{ HostIp: port.hostIp ?? '0.0.0.0', HostPort: String(port.hostPort) }]
  }
  const env = Object.entries(spec.env ?? {})
    .filter(([, value]) => value)
    .map(([key, value]) => `${key}=${value}`)

  const created = await client().createContainer({
    name: spec.name,
    Image: spec.image,
    ...(env.length ? { Env: env } : {}),
    ...(spec.labels ? { Labels: spec.labels } : {}),
    ...(spec.ports?.length ? { ExposedPorts: exposedPorts } : {}),
    HostConfig: {
      ...(spec.binds?.length ? { Binds: spec.binds } : {}),
      ...(spec.ports?.length ? { PortBindings: portBindings } : {}),
      ...(spec.restartPolicy ? { RestartPolicy: { Name: spec.restartPolicy } } : {}),
      ...(spec.extraHosts?.length ? { ExtraHosts: spec.extraHosts } : {}),
      ...(spec.init ? { Init: true } : {}),
      // 只在给了正数时才限制，否则留给 docker 默认（无限）
      ...(spec.memoryMb && spec.memoryMb > 0
        ? { Memory: Math.floor(spec.memoryMb) * 1024 * 1024 }
        : {}),
      ...(spec.cpus && spec.cpus > 0 ? { NanoCpus: Math.floor(spec.cpus * 1e9) } : {})
    }
  })
  return created.id
}

/**
 * 启动容器。
 *
 * ⚠️ **304 必须当成功**：dockerode 把 `304 container already started` 包成 error
 * （`modem.buildPayload` 里 `statusCodes[304]` 是字符串而非 `true`），而 CLI 版的
 * `docker start` 在同样情况下退出码是 0。不吞掉这个 304，调用方就会把「已经在跑」
 * 判成启动失败。
 */
export async function startContainer(name: string): Promise<void> {
  try {
    await client().getContainer(name).start()
  } catch (err) {
    if (isNotModified(err)) return
    throw new Error(`启动容器 ${name} 失败：${dockerErrorMessage(err)}`, { cause: err })
  }
}

/**
 * 优雅停止；超时后 daemon 自己 SIGKILL。
 *
 * 304（本来就没在跑）/ 404（已经没了）都当成功 —— 这是收尾动作，不该因为
 * 「它已经停了」而报错。
 */
export async function stopContainer(name: string, timeoutSec = 5): Promise<void> {
  try {
    await client().getContainer(name).stop({ t: timeoutSec })
  } catch (err) {
    if (isNotModified(err) || isNotFound(err)) return
    throw new Error(`停止容器 ${name} 失败：${dockerErrorMessage(err)}`, { cause: err })
  }
}

/**
 * 强杀 + 删除（不存在时静默成功）。
 *
 * ⚠️ **失败也静默** —— 这是有意为之：删除几乎总是「尽力而为」的收尾动作（收尾路径、
 * 启动回滚），那里抛错只会把主流程带崩，而容器删不掉并不会让状态更糟。
 */
export async function removeContainer(name: string): Promise<void> {
  try {
    await client().getContainer(name).remove({ force: true })
  } catch {
    /* 收尾动作，失败不抛（见上） */
  }
}

/**
 * 删容器的**要回执**版本：删掉（或本来就不存在）返回 null，失败返回一句人话。
 *
 * 与上面那个的分工：`removeContainer` 用于「收尾失败也无所谓」的路径（启动回滚、重建前
 * 清理）；**删项目**不是那种路径 —— 记录一摘，容器就成了谁也管不着的孤儿（还占着宿主
 * 端口），所以那里必须知道有没有删掉，好在日志里说清楚、并让启动时的清扫兜住。
 */
export async function removeContainerReporting(name: string): Promise<string | null> {
  try {
    await client().getContainer(name).remove({ force: true })
    return null
  } catch (err) {
    if (isNotFound(err)) return null
    return dockerErrorMessage(err)
  }
}

/**
 * 把 docker 的多路复用日志拆成纯文本。
 *
 * `container.logs({follow:false})` 返回的是**原始字节 Buffer**（dockerode 的
 * `isStream` 只在 follow 时为真），每帧 8 字节头：`[流类型, 0, 0, 0, 长度(4字节BE)]`，
 * 流类型 1 = stdout、2 = stderr。
 *
 * 容器若开了 TTY 就没有这层封装（裸文本）—— 首字节不是 0/1/2 就整段当文本返回。
 */
function demuxLogs(buffer: Buffer): string {
  if (buffer.length === 0) return ''
  if (buffer.length < 8) return buffer.toString('utf8')
  const parts: string[] = []
  let offset = 0
  while (offset + 8 <= buffer.length) {
    const streamType = buffer[offset]
    if (streamType !== 0 && streamType !== 1 && streamType !== 2) {
      // 不是多路复用帧：整段是裸文本
      return buffer.toString('utf8')
    }
    const size = buffer.readUInt32BE(offset + 4)
    const start = offset + 8
    const end = Math.min(start + size, buffer.length)
    parts.push(buffer.subarray(start, end).toString('utf8'))
    offset = end
  }
  return parts.join('')
}

/** 容器日志（stdout + stderr 合并）；容器不在 / 连不上返回空串 */
export async function containerLogs(name: string, tail = 500): Promise<string> {
  try {
    const raw = await client()
      .getContainer(name)
      .logs({ stdout: true, stderr: true, follow: false, tail })
    return demuxLogs(Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw)))
  } catch {
    return ''
  }
}

// ---------- 仓库根（构建上下文） ----------

/**
 * 仓库根的判据文件：容器型项目基础镜像的 Dockerfile。
 *
 * 选它而不是 `.git` / `package.json`：构建上下文是仓库根，这个文件**必然在**，
 * 且它一被改名就说明构建链路已经变了，判据跟着改才对。
 */
const REPO_ROOT_MARKER = 'docker/container-project/runtime.Dockerfile'

/**
 * 定位仓库根目录 —— 构建上下文要用它（`docker build ... <repoRoot>`）。
 *
 * 候选顺序：**打包态的 `resourcesPath`** → 从 `process.cwd()` 逐级往上。
 *
 * - 开发 / 自建 server：cwd 就是仓库根，往上几步内必然命中标记文件；
 * - **打包后的桌面端**：cwd 是安装目录（用户甚至可能从任意目录启动），往上找永远找不到仓库。
 *   electron-builder 的 `extraResources` 把 `docker/` 与 `skills/` 一起放进
 *   `process.resourcesPath` —— 那正是 Dockerfile 里 `COPY docker/...` 与 `COPY skills`
 *   的起点，所以它本身就是「构建上下文根」。
 *
 * 判据仍是同一个标记文件：dev 下 `process.resourcesPath` 指向 Electron 自带的 resources
 * （里面没有 `docker/`），这一条自然落空、继续走 cwd，不需要额外区分平台。
 *
 * 允许 `FIZZ_REPO_ROOT` 覆盖（把 server 单独拷出去跑 / 想用别的上下文构建的场景）。
 *
 * ⚠️ 判据是**容器型项目**的基础 Dockerfile（流程节点的 `docker/agent-flow/` 已删）。
 * `container-projects/image.ts` 与 `lifecycle.ts` 都依赖这个函数，改判据要三处一起看。
 */
export function findRepoRoot(): string {
  const override = process.env.FIZZ_REPO_ROOT?.trim()
  if (override) return resolve(override)

  const resourcesPath = (process as unknown as { resourcesPath?: string }).resourcesPath
  const candidates: string[] = resourcesPath ? [resourcesPath] : []
  let dir = process.cwd()
  for (let i = 0; i < 8; i++) {
    candidates.push(dir)
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  for (const candidate of candidates) {
    if (existsSync(join(candidate, REPO_ROOT_MARKER))) return candidate
  }
  throw new Error(
    `找不到仓库根目录（里面应有 ${REPO_ROOT_MARKER}）；可用 FIZZ_REPO_ROOT 指定`
  )
}

// ---------- 事件流 ----------

/** docker 事件的最小切片：只留「判断要不要重算」需要的三样 */
export interface DockerEvent {
  /** `container` | `image` | `network` | `volume` … */
  type: string
  /** `start` | `die` | `stop` | `destroy` | `create` | `tag` | `build` … */
  action: string
  /** 事件主体名（容器名，或镜像 tag） */
  actor: string
}

export interface DockerEventWatcher {
  /** 停止订阅（不再重连） */
  stop(): void
}

const RECONNECT_MIN_MS = 1_000
const RECONNECT_MAX_MS = 30_000

/**
 * 订阅 docker 事件流（`GET /events`）。
 *
 * ## 为什么需要它
 *
 * `containerProjects` / `flowDocker` 两个域的变化有两类来源：
 *
 * 1. **我们自己做的**（起停容器、构建镜像）—— 写入点已经 `markDirty`，不需要轮询；
 * 2. **别人做的** —— 用户手动 `docker stop`、容器 OOM 被杀、宿主机重启后
 *    `unless-stopped` 把容器拉回来、外部 `docker build` 覆盖了 tag。
 *
 * 第 2 类没有写入点，以前只能靠 `state-ws` 定时比对（10s 一拍）发现。订阅事件流之后
 * 它变成**推**的：daemon 一有动作就回调，稳态彻底不轮询。
 *
 * ## 断线重连
 *
 * Docker Desktop 重启、daemon 升级、命名管道被系统回收都会断流。这里退避重连
 * （1s 起、翻倍、封顶 30s），并且**只在「连上 / 断开」状态翻转时打日志** ——
 * 每 30s 打一行「还是连不上」只会把日志刷满。
 *
 * 调用方仍应保留一条低频兜底轮询：重连成功之前的窗口里事件是真的丢了。
 */
export function watchDockerEvents(onEvent: (event: DockerEvent) => void): DockerEventWatcher {
  let stopped = false
  let stream: NodeJS.ReadableStream | null = null
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let backoff = RECONNECT_MIN_MS
  /** 上一次尝试的结果：只在翻转时打日志，避免「每 30s 重复同一句」 */
  let lastOutcome: 'up' | 'down' | null = null

  const scheduleReconnect = (): void => {
    if (stopped || retryTimer) return
    retryTimer = setTimeout(() => {
      retryTimer = null
      void connect()
    }, backoff)
    backoff = Math.min(backoff * 2, RECONNECT_MAX_MS)
  }

  /** 一行 JSON → 回调。半行 / 脏数据直接丢，不影响后面的行 */
  const handleLine = (line: string): void => {
    const text = line.trim()
    if (!text) return
    try {
      const raw = JSON.parse(text) as {
        Type?: string
        Action?: string
        Actor?: { Attributes?: Record<string, string> }
      }
      if (!raw.Type || !raw.Action) return
      onEvent({
        type: raw.Type,
        action: raw.Action,
        actor: raw.Actor?.Attributes?.name ?? ''
      })
    } catch {
      /* 不是完整 JSON：丢 */
    }
  }

  async function connect(): Promise<void> {
    if (stopped) return
    /*
     * ⚠️ 必须先确认 daemon 在。
     *
     * 实测（Docker Desktop 未启动）：`getEvents()` 会**立刻 resolve 一个永远静默的流** ——
     * 8s 内不 error、不 end、不 close、没有 data。错误根本不从流上出来。不预检就会挂着一个
     * 死流，`onDrop` 永远不触发、重连逻辑形同虚设，而调用方还以为订阅成功了。
     *
     * 这里直接问 `client().version()` 而不是 `dockerVersion()`：后者有 30s 成功缓存，
     * 会让「daemon 刚挂、缓存还没过期」被误判成可用。
     */
    try {
      await client().version()
    } catch (err) {
      if (stopped) return
      if (lastOutcome !== 'down') {
        lastOutcome = 'down'
        console.warn(`[docker] 事件流未订阅（${dockerErrorMessage(err)}），将自动重试`)
      }
      scheduleReconnect()
      return
    }
    let next: NodeJS.ReadableStream
    try {
      next = await client().getEvents({ filters: { type: ['container', 'image'] } })
    } catch (err) {
      if (stopped) return
      if (lastOutcome !== 'down') {
        lastOutcome = 'down'
        console.warn(`[docker] 事件流连不上（${dockerErrorMessage(err)}），将自动重连`)
      }
      scheduleReconnect()
      return
    }
    if (stopped) {
      destroyStream(next)
      return
    }
    stream = next
    backoff = RECONNECT_MIN_MS
    if (lastOutcome !== 'up') {
      lastOutcome = 'up'
      console.log('[docker] 事件流已连接')
    }

    // 事件是 JSON lines；chunk 边界可能切在一行中间，自己攒缓冲
    let buffer = ''
    next.on('data', (chunk: Buffer | string) => {
      buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      let index = buffer.indexOf('\n')
      while (index !== -1) {
        handleLine(buffer.slice(0, index))
        buffer = buffer.slice(index + 1)
        index = buffer.indexOf('\n')
      }
    })

    const onDrop = (err?: unknown): void => {
      // `end` 与 `close` 会连着来，只处理第一次
      if (stream !== next) return
      stream = null
      if (stopped) return
      if (lastOutcome !== 'down') {
        lastOutcome = 'down'
        const detail = err ? `：${dockerErrorMessage(err)}` : ''
        console.warn(`[docker] 事件流断开${detail}，将自动重连`)
      }
      scheduleReconnect()
    }
    next.on('error', onDrop)
    next.on('end', () => onDrop())
    next.on('close', () => onDrop())
  }

  void connect()

  return {
    stop(): void {
      stopped = true
      if (retryTimer) {
        clearTimeout(retryTimer)
        retryTimer = null
      }
      if (stream) {
        destroyStream(stream)
        stream = null
      }
    }
  }
}

function destroyStream(stream: NodeJS.ReadableStream): void {
  const destroy = (stream as { destroy?: () => void }).destroy
  if (typeof destroy === 'function') destroy.call(stream)
  else (stream as { pause?: () => void }).pause?.()
}
