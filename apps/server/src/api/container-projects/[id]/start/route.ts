/**
 * POST /api/container-projects/:id/start → 最新的容器型项目快照
 *
 * 启动是**异步**的（要确保镜像、`docker run`、等 agent 服务就绪），这里 await 到
 * 有结论为止再返回：调用方拿到的快照里 `state` 已经是 `running` 或 `error`，不必自己轮询。
 *
 * ⚠️ 失败**不抛错** —— 原因写在快照对应项目的 `error` 里（界面直接显示 + 可重试），
 * 与隧道启动同一个约定（见 `ssh/tunnels/[id]/start/route.ts`）。
 * ⚠️ 幂等：并发 / 重复调用会合并成一次（`startContainerProject` 内部按 slug 合并）。
 */
import { startContainerProject, containerProjectsSnapshot } from '@/lib/server/container-projects/lifecycle'
import { describeError, jsonError } from '@/app/api/_lib/auth'

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  try {
    await startContainerProject(id)
    return Response.json({ snapshot: await containerProjectsSnapshot() })
  } catch (err) {
    // 走到这里只会是「id 不存在 / 不是容器型项目」这类前置错误（启动失败已落进快照）
    const { status, message } = describeError(err)
    return jsonError(status, message)
  }
}
