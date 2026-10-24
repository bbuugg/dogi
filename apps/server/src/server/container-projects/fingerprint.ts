/**
 * 容器镜像的「内容指纹」。
 *
 * ## 为什么需要
 *
 * `ensureContainerImage` 原本只判断「镜像 tag 存在」——但 **tag 存在 ≠ 镜像是当前仓库文件
 * 构建出来的**。实际踩过的坑：旧镜像先建好（`CMD` 直接是 `agent-host.mjs`），之后仓库加了
 * `bootstrap.mjs` 并改了 Dockerfile 的入口；宿主的 ensure 拿着「tag 存在」短路，一直用旧镜像
 * 起容器 → 工作区里 `.fizz/container/start.mjs` 没有任何入口去执行 → 表现为「容器在跑、
 * 服务没起、日志里连 `[fizz-start]` 都没有」。
 *
 * ## 做法
 *
 * 构建时把「输入指纹」写进镜像 label（`fizz.image-fingerprint`）；ensure 时重算**期望指纹**
 * 与 label 里的**实际指纹**比对：不一致，或者根本没有这个 label（老镜像 / 外部构建），
 * 都判为「过时」，走重建覆盖 tag。
 *
 * 指纹的输入 = Dockerfile + Dockerfile 里 COPY 进镜像的仓库文件（含 `skills/` 目录内容）。
 * **不含**外部基础镜像（`node:24-slim`）的 digest 变化——那类更新在重建 base 时自然带入。
 *
 * env 镜像 `FROM` base，所以它的期望指纹里还拼进 **base 镜像 label 里的实际指纹**：
 * base 重建后，即使 env 的 Dockerfile 一字未动，env 镜像也判过时（它仍含旧 base 的层）。
 * 这补上了「重建 base 不会让环境镜像跟着变」的老死角——以前要用户自己记得挨个重建。
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** 镜像指纹写在哪个 label（`docker build --label` → `docker image inspect .Config.Labels`） */
export const FINGERPRINT_LABEL = 'fizz.image-fingerprint'

/**
 * base 镜像 COPY 进镜像的仓库文件清单 —— 与 `runtime.Dockerfile` 的 COPY（含依赖安装层）
 * **逐条对齐**：Dockerfile 新增 COPY 而这里不补，指纹就追不到那次变更。
 */
const BASE_FILES = [
  'docker/container-project/runtime.Dockerfile',
  'docker/container-project/runtime/package.json',
  'docker/container-project/runtime/package-lock.json',
  'docker/container-project/runtime/runtime.mjs',
  'docker/container-project/runtime/agent-host.mjs',
  'docker/container-project/runtime/bootstrap.mjs'
]

/** base 镜像 COPY 进镜像的仓库目录（整个目录的内容都参与指纹） */
const BASE_DIRS = ['skills']

/**
 * 递归列出目录下全部文件（相对 `repoRoot` 的路径，排序保证遍历稳定）。
 * 目录不存在返回空 —— 容错而不是抛错：指纹缺失顶多让比对「不一致」触发一次重建。
 */
function listFiles(repoRoot: string, rel: string): string[] {
  const abs = join(repoRoot, rel)
  if (!existsSync(abs)) return []
  const out: string[] = []
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      const name = `${prefix}/${entry.name}`
      if (entry.isDirectory()) walk(path, name)
      else if (entry.isFile()) out.push(name)
    }
  }
  walk(abs, rel)
  return out.sort()
}

/** 单槽缓存：base 指纹只在这里算（env 指纹复用它读到的 base label，不各算一份） */
let cache: { key: string; fingerprint: string } | null = null

/**
 * base 镜像的期望指纹（同步；有进程内缓存）。
 *
 * 缓存键是全部参与文件的「路径 + mtime + size」清单：没变就直接用上次的 hash 结果，
 * 免得每条消息都把 400KB+ 的 bundle 读一遍 hash。**内容才是真源** —— mtime 变了但内容
 * 没变（比如重新 checkout），缓存失效一次、重算后新 stamp 与旧指纹一致，不会误重建。
 */
export function baseFingerprint(repoRoot: string): string {
  const rels = [...BASE_FILES]
  for (const dir of BASE_DIRS) rels.push(...listFiles(repoRoot, dir))

  const stamps: string[] = []
  for (const rel of rels) {
    const abs = join(repoRoot, rel)
    if (!existsSync(abs)) {
      stamps.push(`${rel}:missing`)
      continue
    }
    const st = statSync(abs)
    stamps.push(`${rel}:${st.mtimeMs}:${st.size}`)
  }
  const cacheKey = rels.join('|') + '#' + stamps.join('|')
  if (cache?.key === cacheKey) return cache.fingerprint

  const hash = createHash('sha256')
  for (const rel of rels) {
    hash.update(rel)
    hash.update('\0')
    const abs = join(repoRoot, rel)
    hash.update(existsSync(abs) ? readFileSync(abs) : 'missing')
  }
  const fingerprint = hash.digest('hex')
  cache = { key: cacheKey, fingerprint }
  return fingerprint
}

/**
 * env 镜像的期望指纹：它的 Dockerfile + **base 镜像 label 里的实际指纹**。
 *
 * `baseActual` 传 null（base 镜像没有指纹 label，或压根不存在）时按 `'unknown'` 参与
 * hash —— 期望与任何实际指纹都对不上，env 无条件判过时：带着旧 base 层的 env 本来就该重建。
 */
export function envFingerprint(repoRoot: string, dockerfile: string, baseActual: string | null): string {
  const hash = createHash('sha256')
  hash.update(baseActual ?? 'unknown')
  hash.update('\0')
  const abs = join(repoRoot, dockerfile)
  hash.update(existsSync(abs) ? readFileSync(abs) : 'missing')
  return hash.digest('hex')
}

/**
 * 读镜像 label 里的实际指纹。镜像不存在 / 读取失败 / 没写过 label 一律 null ——
 * 调用方拿它与期望比对，null 永远 ≠ 期望，即「这个镜像别信，重建」。
 */
export async function imageFingerprint(tag: string): Promise<string | null> {
  const result = await new Promise<{ code: number; stdout: string }>((resolve) => {
    execFile(
      'docker',
      ['image', 'inspect', tag, '--format', '{{json .Config.Labels}}'],
      { timeout: 20_000, windowsHide: true },
      (err, stdout) => resolve({ code: err ? 1 : 0, stdout: String(stdout ?? '') })
    )
  })
  if (result.code !== 0) return null
  try {
    const labels = JSON.parse(result.stdout.trim()) as Record<string, string>
    return typeof labels[FINGERPRINT_LABEL] === 'string' ? labels[FINGERPRINT_LABEL] : null
  } catch {
    return null
  }
}
