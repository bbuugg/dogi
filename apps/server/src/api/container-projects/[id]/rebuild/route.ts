/**
 * POST /api/container-projects/:id/rebuild → 最新的容器型项目快照
 *
 * 停 → 删容器 → 按当前配置重新起。用于「镜像重新构建后让项目生效」与「容器弄脏了重置」。
 *
 * ⚠️ 与 start 一样是**异步长操作**，这里 await 到有结论为止（拿到的快照里 `state`
 * 已经是 `running` 或 `error`）；失败原因在快照对应项目的 `error` 里，不抛错。
 */
import {
  rebuildContainerProject,
  containerProjectsSnapshot
} from '@/lib/server/container-projects/lifecycle'
import { describeError, jsonError } from '@/app/api/_lib/auth'

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  try {
    await rebuildContainerProject(id)
    return Response.json({ snapshot: await containerProjectsSnapshot() })
  } catch (err) {
    // 走到这里只会是「id 不存在 / 不是容器型项目」这类前置错误（重建失败已落进快照）
    const { status, message } = describeError(err)
    return jsonError(status, message)
  }
}
