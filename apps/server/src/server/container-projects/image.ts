/**
 * 容器型项目用的镜像：确保存在 / 强制重建 / 状态快照（设置页「容器」的数据源）。
 *
 * ## 镜像层次（spec §4.2）
 *
 * ```
 * docker/container-project/runtime.Dockerfile  → fizz/agent-runtime:latest  （基础：Node 24 + 依赖 + runtime.mjs）
 * docker/container-project/node.Dockerfile     → fizz/agent-node:latest     （只 FROM 基础镜像）
 * docker/container-project/php.Dockerfile      → fizz/agent-php:latest      （+ PHP 8.5 / composer）
 * docker/container-project/golang.Dockerfile   → fizz/agent-golang:latest   （+ go）
 * docker/container-project/vite.Dockerfile     → fizz/agent-vite:latest     （+ Vite/React/Tailwind 模板与自动启动）
 * ```
 *
 * 四个 env 镜像都 `FROM fizz/agent-runtime:latest`，所以**必须先把基础镜像备好** ——
 * 否则 `docker build` 会在 FROM 那一行直接失败（本地没有该 tag、也 pull 不到）。
 *
 * ## 构建方式
 *
 * `imageExists` 短路 + 进程内 Promise 合并 + `spawn` 喂日志。`docker build` 走 CLI 而不是
 * dockerode 的 `buildImage`：后者要 `{context, src: [...]}` 的文件列表，`.dockerignore`
 * 得自己解析（`**`、`!` 取反、嵌套忽略文件），等于重写一遍上下文预处理。
 *
 * ⚠️ **不再有「先 `npm run build:runtime`」这一步** —— `runtime.mjs` 是**入库产物**，
 * 构建镜像时它已经在仓库里了。
 */
import { spawn } from 'node:child_process'
import type {
  ContainerEnvId,
  ContainerImageInfo,
  ContainerImagesSnapshot
} from '@fizz/contracts'
import { CONTAINER_ENV_IMAGES } from '@fizz/contracts'
import {
  dockerUnavailableReason,
  dockerVersion,
  findRepoRoot,
  imageExists,
  inspectImage
} from '../lib/docker'
import {
  FINGERPRINT_LABEL,
  baseFingerprint,
  envFingerprint,
  imageFingerprint
} from './fingerprint'

/** 基础镜像 tag（两个 Dockerfile 里逐字写死，这里必须一致） */
const BASE_IMAGE = 'fizz/agent-runtime:latest'
const BASE_DOCKERFILE = 'docker/container-project/runtime.Dockerfile'
const BASE_LABEL = '基础层（Node 24 + Agent 运行时）'

/**
 * 镜像的键：三个运行环境 + 基础层。
 *
 * 基础层也占一个键（而不是只作为环境镜像的隐含前置）：设置页要单独显示它，
 * 且它自己也能被「重建」—— 重建 base 后各环境镜像**不会自动跟着变**，
 * 要重新构建环境镜像才吃到新 base（界面上要提示这一点）。
 */
export type ContainerImageKey = ContainerEnvId | 'base'

const ALL_KEYS: readonly ContainerImageKey[] = ['base', ...CONTAINER_ENV_IMAGES.map((i) => i.id)]

/** 请求体 / 路径里的字符串 → 键；认不出来返回 null（路由据此 400） */
export function containerImageKeyOf(value: string): ContainerImageKey | null {
  return (ALL_KEYS as readonly string[]).includes(value) ? (value as ContainerImageKey) : null
}

function dockerfileOf(envId: ContainerEnvId): string {
  return `docker/container-project/${envId}.Dockerfile`
}

/**
 * 镜像 tag：清单里的缺省值，可被 `FIZZ_CONTAINER_IMAGE_<ENV>`（大写）覆盖。
 *
 * 覆盖的用途是「用户自己构建/改名的镜像」——这时**不再由我们构建**，只要求它存在。
 */
function tagOf(envId: ContainerEnvId): string {
  const override = process.env[`FIZZ_CONTAINER_IMAGE_${envId.toUpperCase()}`]?.trim()
  if (override) return override
  const entry = CONTAINER_ENV_IMAGES.find((img) => img.id === envId)
  if (!entry) throw new Error(`未知的运行环境镜像 id：${envId}`)
  return entry.image
}

function tagOfKey(key: ContainerImageKey): string {
  return key === 'base' ? BASE_IMAGE : tagOf(key)
}

/** 该 env 是否被环境变量接管了 tag（接管时**不构建**，缺了就是错） */
function isTagOverridden(envId: ContainerEnvId): boolean {
  return Boolean(process.env[`FIZZ_CONTAINER_IMAGE_${envId.toUpperCase()}`]?.trim())
}

function isOverridden(key: ContainerImageKey): boolean {
  return key === 'base' ? false : isTagOverridden(key)
}

/** `docker run` 要用的镜像 tag —— 与 `ensureContainerImage` **同一个来源**，别各算一份 */
export function containerImageTag(envId: ContainerEnvId): string {
  return tagOf(envId)
}

// ---------- 构建状态（给「启动中」与设置页看进度） ----------

/** 每个 env 的构建日志尾部（环形，最多 400 行 —— 与 `lib/docker.ts` 同口径） */
const buildLogs = new Map<ContainerImageKey, string[]>()

/** 正在构建的键（`base` 也占一个位置：它被三个 env 镜像共用） */
const buildingKeys = new Set<ContainerImageKey>()

/** 最近一次构建失败的错因；成功后清空 */
const buildErrors = new Map<ContainerImageKey, string>()

/** 读某个键的构建日志（`phase === 'image'` 时快照里带上它） */
export function containerImageBuildLog(key: ContainerImageKey): string[] {
  return [...(buildLogs.get(key) ?? [])]
}

/**
 * 「构建日志有新行」的回调（`state-ws` 用它把 `containerProjects` 标脏）。
 *
 * 与 `lib/docker.ts` 的 `onAgentImageBuildProgress` 同一个理由：构建是我们自己
 * `spawn` 的 CLI，docker 不发事件，不回调就只能靠轮询才看得到日志滚动。
 */
let buildProgressListener: (() => void) | undefined

export function onContainerImageBuildProgress(listener: (() => void) | undefined): void {
  buildProgressListener = listener
}

function pushBuildLog(key: ContainerImageKey, line: string): void {
  let log = buildLogs.get(key)
  if (!log) {
    log = []
    buildLogs.set(key, log)
  }
  let appended = false
  for (const part of line.split('\n')) {
    const text = part.trimEnd()
    if (!text) continue
    log.push(text)
    appended = true
  }
  if (log.length > 400) log.splice(0, log.length - 400)
  if (appended) buildProgressListener?.()
}

/**
 * `docker build`，并把**当前输入的指纹**写进镜像 label。
 *
 * 用 `spawn` 而不是 `execFile` 是为了把输出**一行行**喂给界面（构建几分钟，用户要知道在动）。
 * `shell` 在 Windows 上必须开：Docker Desktop 的 CLI 是 `docker.exe` 包装，直接 spawn
 * 会因参数引号被吞而失败（与 `lib/docker.ts` 的 `dockerBuild` 同处理）。
 *
 * `--label` 带的指纹是 `ensureContainerImage` 判「镜像过时」的依据（见 `fingerprint.ts`）
 * —— calling 方在 build 前算好传入；label 只影响镜像 config、不破坏层缓存。
 *
 * `buildingKeys` / `buildErrors` 在这里维护：**构建是长任务**，设置页轮询快照时
 * 要能看见「在跑 / 上次失败的原因」，而不是只能等 promise。
 */
function dockerBuild(
  key: ContainerImageKey,
  tag: string,
  dockerfile: string,
  repoRoot: string,
  fingerprint: string
): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    buildLogs.set(key, [])
    buildingKeys.add(key)
    buildErrors.delete(key)
    const proc = spawn(
      'docker',
      ['build', '--label', `${FINGERPRINT_LABEL}=${fingerprint}`, '-t', tag, '-f', dockerfile, '.'],
      {
        cwd: repoRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: process.platform === 'win32',
        windowsHide: true
      }
    )
    proc.stdout?.on('data', (chunk) => pushBuildLog(key, String(chunk)))
    proc.stderr?.on('data', (chunk) => pushBuildLog(key, String(chunk)))
    proc.on('error', (err) => {
      buildingKeys.delete(key)
      const message = `docker 命令不可用：${err.message}`
      buildErrors.set(key, message)
      rejectPromise(new Error(message))
    })
    proc.on('exit', (code) => {
      buildingKeys.delete(key)
      if (code === 0) {
        resolvePromise()
        return
      }
      const message = `镜像构建失败（${tag}，退出码 ${code}）`
      buildErrors.set(key, message)
      rejectPromise(
        new Error(`${message}：${buildLogs.get(key)?.slice(-6).join('\n') ?? ''}`)
      )
    })
  })
}

// ---------- 进程内合并 ----------

const inFlight = new Map<ContainerEnvId, Promise<void>>()
/** 基础层的并发构建也合并：两个 env 同时首次启动时不该各 build 一遍 base */
let baseInFlight: Promise<void> | null = null
/**
 * 设置页「重新构建」的并发合并：连点两下不该跑两遍 `docker build`。
 * 与 `inFlight` 分开：那个是「没有才建」的快路径，这个是用户显式的强制重建。
 */
const forceInFlight = new Map<ContainerImageKey, Promise<void>>()

/**
 * 确保某个运行环境的镜像可用。**并发调用只会真的构建一次**（按 env 合并）。
 *
 * 失败时抛人话错误（调用方把它写进项目的 `error` 状态，界面显示 + 可重试），
 * 绝不静默退化 —— 镜像没有却往下走，`docker run` 只会给一句「no such image」。
 */
export async function ensureContainerImage(envId: ContainerEnvId): Promise<void> {
  const version = await dockerVersion()
  if (!version) throw new Error(dockerUnavailableReason() ?? 'docker 不可用')

  const repoRoot = findRepoRoot()
  const tag = tagOf(envId)
  // 环境变量接管了 tag：说明镜像由用户自己管，我们只负责「没有就报错」
  if (isTagOverridden(envId)) {
    if (!(await imageExists(tag))) {
      throw new Error(`镜像 ${tag} 不存在（由 FIZZ_CONTAINER_IMAGE_${envId.toUpperCase()} 指定）`)
    }
    return
  }

  // 镜像在且指纹与当前仓库一致：快路（每条消息都会走到这），顺带把上次失败的红字清掉。
  // 指纹不一致 = 过时（改了 Dockerfile / runtime 产物 / base 重建过）：不能接着用旧货，
  // 往下走重建覆盖。没有指纹 label 的老镜像/外部构建也判过时 —— 见 fingerprint.ts。
  if (await imageExists(tag)) {
    if (!(await imageOutOfDate(repoRoot, envId))) {
      buildErrors.delete(envId)
      return
    }
  }

  const running = inFlight.get(envId)
  if (running) return running

  const promise = (async () => {
    // 基础镜像必须先有且**新鲜**：三个 env Dockerfile 都 FROM 它。FROM 一个过时的 base，
    // 新 build 出来的 env 还是旧东西 —— 所以这里的检查从「存在」换成「指纹新鲜」
    if (!(await imageExists(BASE_IMAGE)) || (await imageOutOfDate(repoRoot, 'base'))) {
      baseInFlight ??= dockerBuild('base', BASE_IMAGE, BASE_DOCKERFILE, repoRoot, baseFingerprint(repoRoot)).finally(() => {
        baseInFlight = null
      })
      await baseInFlight
    }
    // 等 base 的同时并发方可能已经把 env build 新了，不再重复
    if (await imageExists(tag) && !(await imageOutOfDate(repoRoot, envId))) return
    // env 的期望指纹要在 base **重建完**之后取（读 base label 里的新指纹）
    await dockerBuild(
      envId,
      tag,
      dockerfileOf(envId),
      repoRoot,
      envFingerprint(repoRoot, dockerfileOf(envId), await imageFingerprint(BASE_IMAGE))
    )
  })().finally(() => inFlight.delete(envId))

  inFlight.set(envId, promise)
  return promise
}

/**
 * 镜像是否已与当前仓库文件脱节（指纹对不上，或没有指纹 label）。
 *
 * 两个调用方：
 * - `ensureContainerImage`：tag 存在但过时 → 重建覆盖；
 * - `lifecycle.doStart`：停着的容器引用的镜像是旧货 → 删容器按新镜像重建
 *   （`docker start` 回来的还是旧镜像 ID，服务照样起不来）。
 */
export async function imageOutOfDate(repoRoot: string, key: ContainerImageKey): Promise<boolean> {
  const tag = tagOfKey(key)
  const actual = await imageFingerprint(tag)
  if (key === 'base') return actual !== baseFingerprint(repoRoot)
  return actual !== envFingerprint(repoRoot, dockerfileOf(key), await imageFingerprint(BASE_IMAGE))
}

// ---------- 设置页：强制重建 + 状态快照 ----------

/**
 * **强制重建**某个镜像（存在也重建）。
 *
 * 与 `ensureContainerImage` 的区别：那个是「没有才建」的快路径，这个是用户显式点
 * 「重新构建」—— Dockerfile 改了、基础层更新了、上次构建坏了，都要真的重跑一遍。
 *
 * 失败**抛错**（路由把原因带回），同时错因也留在 `buildErrors` 里给设置页显示。
 * 重建后的镜像带新指纹 label：受影响的其它镜像（重建 base 后的三个 env）不会立刻变，
 * 但**下次启动时**会被 `ensureContainerImage` 的指纹比对判过时、自动重建 —— 不再需要
 * 用户记得挨个重按一遍。
 */
export async function buildContainerImage(key: ContainerImageKey): Promise<void> {
  const running = forceInFlight.get(key)
  if (running) return running

  // 同步置位：路由不 await 这个 promise（构建几分钟），返回快照时就要是 `building: true`
  buildingKeys.add(key)
  const promise = (async () => {
    const version = await dockerVersion()
    if (!version) throw new Error(dockerUnavailableReason() ?? 'docker 不可用')
    if (isOverridden(key)) {
      throw new Error(
        `镜像 ${tagOfKey(key)} 由 FIZZ_CONTAINER_IMAGE_${key.toUpperCase()} 指定，请在外部构建`
      )
    }

    const repoRoot = findRepoRoot()
    if (key === 'base') {
      await dockerBuild('base', BASE_IMAGE, BASE_DOCKERFILE, repoRoot, baseFingerprint(repoRoot))
      return
    }
    // 环境镜像 FROM base：base 不存在或过时都先 build 一次 —— 否则 FROM 行失败，
    // 或者 build 出来还是旧 base 的层
    if (!(await imageExists(BASE_IMAGE)) || (await imageOutOfDate(repoRoot, 'base'))) {
      baseInFlight ??= dockerBuild('base', BASE_IMAGE, BASE_DOCKERFILE, repoRoot, baseFingerprint(repoRoot)).finally(() => {
        baseInFlight = null
      })
      await baseInFlight
    }
    // 指纹在 base 重建完之后取：读到的是 base 刚写入的新指纹
    await dockerBuild(
      key,
      tagOf(key),
      dockerfileOf(key),
      repoRoot,
      envFingerprint(repoRoot, dockerfileOf(key), await imageFingerprint(BASE_IMAGE))
    )
  })()
    .catch((err: unknown) => {
      // 路由不 await 这个 promise（构建几分钟），所以错因必须落在快照里，否则用户
      // 只会看到「构建中」永远转下去。docker 不可用 / 仓库根找不到 / 被环境变量接管
      // 这几条前置失败也走这里（`dockerBuild` 只覆盖了构建本身那一段）。
      buildErrors.set(key, err instanceof Error ? err.message : String(err))
      throw err
    })
    .finally(() => {
      buildingKeys.delete(key)
      forceInFlight.delete(key)
    })

  forceInFlight.set(key, promise)
  return promise
}

function infoOf(
  key: ContainerImageKey,
  facts: { sizeBytes: number; createdAt: number } | null
): ContainerImageInfo {
  return {
    env: key,
    label: key === 'base' ? BASE_LABEL : (CONTAINER_ENV_IMAGES.find((i) => i.id === key)?.label ?? key),
    tag: tagOfKey(key),
    exists: facts !== null,
    building: buildingKeys.has(key),
    error: buildErrors.get(key),
    sizeBytes: facts?.sizeBytes,
    createdAt: facts?.createdAt,
    overridden: isOverridden(key),
    log: containerImageBuildLog(key).slice(-40)
  }
}

/**
 * 镜像总快照（`GET /api/container-images`）。
 *
 * docker 不可达时**不抛错**：`available: false` + 人话原因，设置页据此显示
 * 「这台机器上没有可用的 docker」而不是一个报错弹窗（与容器项目列表同一约定）。
 * 四个镜像是并行 inspect 的 —— 串行会让设置页每次打开多等三倍。
 */
export async function containerImagesSnapshot(): Promise<ContainerImagesSnapshot> {
  const version = await dockerVersion()
  if (!version) {
    return {
      available: false,
      reason: dockerUnavailableReason() ?? 'docker 不可用',
      base: infoOf('base', null),
      envs: CONTAINER_ENV_IMAGES.map((entry) => infoOf(entry.id, null))
    }
  }

  const infos = await Promise.all(
    ALL_KEYS.map(async (key) => infoOf(key, await inspectImage(tagOfKey(key))))
  )
  const [base, ...envs] = infos
  return { available: true, version, base, envs }
}
