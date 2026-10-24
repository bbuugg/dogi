/**
 * POST /api/container-projects/:id/stop → 最新的容器型项目快照
 *
 * **停而不删**（端口映射与挂载留着，下次 `docker start` 即可冷启动）。
 * 这是容器**唯一**的停止入口：服务端没有闲置自动停，起停都由用户决定。
 */
import { stopContainerProject, containerProjectsSnapshot } from '@/lib/server/container-projects/lifecycle'
import { describeError, jsonError } from '@/app/api/_lib/auth'

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  try {
    await stopContainerProject(id)
    return Response.json({ snapshot: await containerProjectsSnapshot() })
  } catch (err) {
    const { status, message } = describeError(err)
    return jsonError(status, message)
  }
}
