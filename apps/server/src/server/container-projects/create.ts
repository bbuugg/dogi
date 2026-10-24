/**
 * 创建容器型项目。
 *
 * 与普通项目（「新建 / 从 Git 克隆 / 登记既有目录」）的根本区别：**目录由系统分配**，
 * 用户不可选。slug 是目录名、容器名后缀、公网子域标签三合一（见 `./slug.ts`）。
 *
 * 顺序（spec §4.1）：校验 → 定 slug → 建目录 →（可选）clone → 登记工作区。
 * clone 失败要**把刚建的目录删掉再抛**，否则会留下一个没有项目记录的 slug 目录
 * （下次 `uniqueSlug` 又要把它当已占用，且用户永远看不到它）。
 */
import { promises as fs } from 'node:fs'
import { basename } from 'node:path'
import type { AgentWorkspace, ContainerProjectCreateInput } from '@fizz/contracts'
import { CONTAINER_ENV_IMAGES } from '@fizz/contracts'
import { cloneRepo } from '@fizz/git'
import { domain } from '../state'
import { invalidNameReason } from '../projects-pure'
import { ProjectServiceError } from '../projects'
import { getContainerProjectsRoot, projectDirOf, uniqueSlug } from './root'
import { isValidPreviewPort } from './preview-port'
import { newPreviewKey } from './preview-key'
import { normalizeCpus, normalizeMemoryLimitMb, resourceInputError } from './resources'

export { isValidPreviewPort } from './preview-port'

/**
 * 已占用的 slug 集合：已登记工作区路径的 basename ∪ 容器项目根下已有的目录 / 文件名。
 *
 * 两者都要：前者防「与某个普通项目的目录重名」，后者防「上一次创建留下的目录」
 * （进程重启、记录丢失时仍不该复用同一个 slug）。
 */
async function takenSlugs(): Promise<Set<string>> {
  const taken = new Set<string>()
  for (const w of domain.listWorkspaces()) taken.add(basename(w.path))
  const entries = await fs.readdir(getContainerProjectsRoot(), { withFileTypes: true }).catch(() => [])
  for (const e of entries) taken.add(e.name)
  return taken
}

/**
 * 创建一个容器型项目：分配 slug 目录、登记工作区，返回新工作区记录。
 *
 * 容器本身**不在这里起** —— 起容器由用户手动触发（`startContainerProject`），
 * 创建只落一条 `container` 配置。
 */
export async function createContainerProject(
  input: ContainerProjectCreateInput
): Promise<AgentWorkspace> {
  // 1. 名字（可空）—— 只判空 / 非法字符；名字**不进目录名**
  const name = input.name?.trim()
  if (name) {
    const reason = invalidNameReason(name)
    if (reason) throw new ProjectServiceError(400, reason)
  }

  // 1.5 资源限额（可空 = 不限制）：与「修改」共用同一套校验（`resources.ts`）
  const resourceReason = resourceInputError(input)
  if (resourceReason) throw new ProjectServiceError(400, resourceReason)
  const memoryLimitMb = input.memoryLimitMb ? normalizeMemoryLimitMb(input.memoryLimitMb) : 0
  const cpus = input.cpus ? normalizeCpus(input.cpus) : 0

  // 2. 镜像必须是清单里的一个，预览端口**由镜像决定**
  //
  // 用户不填端口、也不该填：他拿到的是 `https://<slug>.<域名>`，端口是「框架监听哪个」
  // 这种内部细节。宿主侧映射端口每次启动重新分配（`allocateHostPort`），域名始终按 slug
  // 现查当前映射，所以端口漂移对用户不可见 —— 见 `public-gateway.ts`。
  const env = CONTAINER_ENV_IMAGES.find((img) => img.id === input.image)
  if (!env) throw new ProjectServiceError(400, `不支持的运行环境镜像：${input.image}`)
  const previewPort = env.suggestedPreviewPort
  // 防御：清单里的建议值是常量，这里只是不让「配错了清单」悄悄变出一个没映射的端口
  if (!isValidPreviewPort(previewPort)) {
    throw new ProjectServiceError(500, `镜像 ${input.image} 的默认预览端口配置有误`)
  }

  // 4. 定 slug + 建目录
  const slug = uniqueSlug(await takenSlugs())
  const dir = projectDirOf(slug)
  await fs.mkdir(dir, { recursive: true })

  // 5. 可选：立刻从这个地址 clone（失败删掉刚建的目录再抛，不留无记录的 slug）
  const gitUrl = input.gitUrl?.trim()
  if (gitUrl) {
    const result = await cloneRepo({ url: gitUrl, destDir: dir })
    if (result.code !== 0) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
      const detail = result.stderr.trim().split('\n').slice(-4).join('\n')
      throw new ProjectServiceError(502, `克隆失败：${detail || `退出码 ${result.code}`}`)
    }
  }

  // 6. 登记工作区（带 container 配置 = 容器型项目）
  return domain.addWorkspace({
    path: dir,
    ...(name ? { name } : {}),
    container: {
      slug,
      image: input.image,
      ...(previewPort !== undefined ? { previewPort } : {}),
      // 新建默认**对外可见**：用户要的是「一个域名」，预览走公网地址是本分
      // （本机回环那条只在没配域名 / 用户手动关掉公网时兜底）
      exposed: true,
      // 预览 key 一创建就生成：即使现在发布了，用户随时可能关掉公网 —— 那时它立刻生效
      previewKey: newPreviewKey(),
      // 0 / 缺省 = 不限制：不写这个键，让老数据与「没设过」保持同一种形状
      ...(memoryLimitMb > 0 ? { memoryLimitMb } : {}),
      ...(cpus > 0 ? { cpus } : {}),
      createdAt: Date.now()
    }
  })
}
