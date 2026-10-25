/**
 * 容器型项目的**容器收尸**：删项目时清掉它的容器，启动时清掉没人认领的容器。
 *
 * ## 为什么单开一个文件
 *
 * 原来这两件事都写在 `projects.ts` 的 `removeProject` 里，用的还是 `lib/docker.ts` 的
 * `removeContainer` —— 那个函数**失败也静默**（收尾动作的约定）。于是「删了项目、容器还在」
 * 成了不可能被发现的静默失败：记录摘了，界面上再也看不见那个容器（快照是按工作区遍历的），
 * 它却还占着端口映射、占着内存，`docker ps` 里挂着也找不到是谁的。用户报过这个现象。
 *
 * 这里改成：
 * 1. 受控的**要回执**删除（`removeContainerReporting`），失败写进应用日志的「容器」页；
 * 2. 删除**不只认名字**，还认 label —— 名字被手改过 / 老版本没打 label 的容器也能收干净；
 * 3. 启动时扫一遍「label 有、工作区没了」的容器，把历史遗留的孤儿一起清掉（自愈，
 *    这样「删项目时 docker 恰好没起来」不会永久留一份垃圾）。
 *
 * ## 清扫的边界（别写成任意 `docker rm` 入口）
 *
 * 只动**同时满足**这三条的容器：
 * - 带 `fizz.container-project` label，且值（slug）在当前工作区清单里找不到；
 * - 没有任何工作区的 `path` 指向 `<容器项目根>/<slug>`（防止「container 配置丢了的项目」被误杀）；
 * - `inspect` 出来的 `/workspace` bind 宿主侧**正好**是本实例的 `projectDirOf(slug)` ——
 *   同一个 docker 上可能还跑着另一份 fizz（另一个数据目录），它的容器 label 长得一模一样，
 *   但挂的是别的目录，绝不能动。
 */

import { resolve } from 'node:path'
import { appLog } from '@fizz/workspace'
import { domain } from '../state'
import {
  inspectContainer,
  listContainers,
  removeContainerReporting,
  stopContainer,
  toDockerPath
} from '../lib/docker'
import { CONTAINER_PROJECT_LABEL, containerNameOf, getContainerProjectsRoot, projectDirOf } from './root'

/** 日志命名空间（`app-log-namespaces.ts` 里注册成「容器」） */
const SCOPE = 'container'

/** 路径比较口径：Windows 大小写不敏感，尾部分隔符不算差异 */
function samePath(a: string, b: string): boolean {
  const norm = (p: string): string => {
    const r = toDockerPath(resolve(p)).replace(/\/+$/, '')
    return process.platform === 'win32' ? r.toLowerCase() : r
  }
  return norm(a) === norm(b)
}

/**
 * 把一个 slug 名下的容器全部停掉并删除（删项目时调，**在摘记录之前**）。
 *
 * 不抛错：调用方的下一次动作就是摘记录，容器删不掉也不该把「删除项目」整个挡下来 ——
 * 那会让用户卡在一个删不掉的项目上（尤其 docker 没启动时）。失败写日志 + 交给启动清扫兜。
 */
export async function purgeProjectContainers(slug: string): Promise<void> {
  /** 先按名字，再用 label 兜底：老版本建的容器没有 label，名字仍然对得上 */
  const names = new Set<string>([containerNameOf(slug)])
  try {
    for (const item of await listContainers({ all: true, label: CONTAINER_PROJECT_LABEL })) {
      if (item.labels[CONTAINER_PROJECT_LABEL] === slug) names.add(item.name)
    }
  } catch {
    // docker 连不上：只剩名字那条路（它也一定会失败，由下面的日志说明）
  }

  for (const name of names) {
    // stop 再 rm 的顺序不能反：给容器内进程一次收到 SIGTERM 收拾自己的机会。
    // stop 失败不记账 —— 它可能压根就没在跑（304 / 404 已按成功处理），真正决定成败的是 rm。
    await stopContainer(name).catch(() => undefined)
    const failure = await removeContainerReporting(name)
    if (failure) {
      appLog.warn(SCOPE, `删除项目时没能删掉容器 ${name}（${failure}）`, '下次启动时会再清一次')
    }
  }
}

/**
 * 清掉没人认领的容器型项目容器（启动时跑一次）。
 *
 * 幂等、尽力而为：docker 没起来直接返回（下次启动再来），单个容器失败只记日志。
 */
export async function sweepOrphanContainers(): Promise<void> {
  let list
  try {
    list = await listContainers({ all: true, label: CONTAINER_PROJECT_LABEL })
  } catch {
    // docker 不可用（Docker Desktop 没启动 / 没权限）：这件事不紧急，下次启动再扫
    return
  }
  if (!list.length) return

  const workspaces = domain.listWorkspaces()
  /** 还活着的 slug：容器配置里的 slug ∪ 「目录就落在容器项目根下」的项目（防 container 配置丢了） */
  const alive = new Set<string>()
  const root = getContainerProjectsRoot()
  for (const ws of workspaces) {
    if (ws.container?.slug) alive.add(ws.container.slug)
    // container 配置丢了的老记录：目录直接挂在容器项目根下，也算「还活着」，别把它的容器当孤儿
    if (!samePath(resolve(ws.path, '..'), root)) continue
    const base = ws.path.split(/[\\/]/).filter(Boolean).pop()
    if (base) alive.add(base)
  }

  for (const item of list) {
    const slug = item.labels[CONTAINER_PROJECT_LABEL]
    if (!slug || alive.has(slug)) continue

    // 归属校验：`/workspace` 的宿主侧必须正好是我们的 slug 目录
    const state = await inspectContainer(item.name)
    if (!state) continue
    const bind = state.binds.find((b) => b.endsWith(':/workspace'))
    if (!bind || !samePath(bind.slice(0, -':/workspace'.length), projectDirOf(slug))) continue

    await stopContainer(item.name).catch(() => undefined)
    const failure = await removeContainerReporting(item.name)
    if (failure) {
      appLog.warn(SCOPE, `清理孤儿容器 ${item.name} 失败（${failure}）`, `目录：${projectDirOf(slug)}`)
    } else {
      appLog.info(SCOPE, `已清理孤儿容器 ${item.name}`, `项目记录已不存在（slug：${slug}）`)
    }
  }
}
