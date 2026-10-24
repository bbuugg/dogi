/**
 * 容器型项目的目录根。
 *
 * **刻意与 `FIZZ_PROJECTS_ROOT` 分开**：后者是用户在「新建项目」弹窗里选目录时的默认
 * 位置、会出现在文件夹选择器里；容器型项目目录**用户不可选**，混进同一个根只会让人
 * 在新建普通项目时看到一堆 slug 目录。
 *
 * slug 生成逻辑（`generateSlug` / `uniqueSlug`）住在零依赖的 `./slug.ts`（为了让
 * vitest 直接跑），这里**统一再导出**，消费方一律从本文件取。
 */
import { join } from 'node:path'
import { resolveDataDir } from '@fizz/workspace'

/** 容器型项目根：`FIZZ_CONTAINER_PROJECTS_ROOT` 优先，缺省 `<数据目录>/containers` */
export function getContainerProjectsRoot(): string {
  return process.env.FIZZ_CONTAINER_PROJECTS_ROOT?.trim() || join(resolveDataDir(), 'containers')
}

/** 某个 slug 对应的项目目录绝对路径 */
export function projectDirOf(slug: string): string {
  return join(getContainerProjectsRoot(), slug)
}

/**
 * 容器名：`fizz-proj-<slug>`。
 *
 * 名字与 label 都带 `fizz-proj-` / `fizz.container-project` 前缀，所以容器型项目的容器
 * 不会被启动时的孤儿清理（按 label 找「我们的容器」）误收。
 */
export function containerNameOf(slug: string): string {
  return `fizz-proj-${slug}`
}

/** 打在容器型项目容器上的 label 键，值为 slug（与 `fizz.task` 不撞的第二道判据） */
export const CONTAINER_PROJECT_LABEL = 'fizz.container-project'

/**
 * 打在容器型项目容器上的**运行参数指纹** label（值为短 hash，见 `lifecycle.ts` 的 `specOf`）。
 *
 * 用途：判断「现在这个容器是不是按当前配置 `docker run` 出来的」。改了内存 / CPU / 镜像后
 * 用户选了「暂不重启」，配置立刻落盘、容器继续按旧参数跑；下一次启动读这个 label 一比，
 * 对不上就删容器按新参数重建 —— 不依赖内存状态，服务端重启后同样成立。
 */
export const CONTAINER_SPEC_LABEL = 'fizz.container-spec'

export { generateSlug, uniqueSlug } from './slug'
