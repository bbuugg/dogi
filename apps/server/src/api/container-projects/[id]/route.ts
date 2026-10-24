/**
 * 单个容器型项目：改名 / 换镜像 / 改预览端口 / 发布开关 / 内存与 CPU 上限。
 *
 * ⚠️ 换镜像或改端口会**销毁旧容器**（下次启动按新配置 `docker run`）—— 镜像 tag 与端口映射
 * 都是 `docker run` 那一刻定下的，只改配置不重建等于「界面一套、容器另一套」。
 *
 * ⚠️ 内存 / CPU 只落盘、**不销毁正在跑的容器**（「暂不重启」就得真的不打断它）：下次启动时
 * `doStart` 用运行参数指纹发现对不上，自动删容器按新参数重建。要立刻生效由前端接着调
 * `POST /:id/rebuild`。逻辑都在 `container-projects/lifecycle.ts`。
 */
import type { ContainerProjectUpdateInput } from '@fizz/contracts'
import { updateContainerProject } from '@/lib/server/container-projects/lifecycle'
import { projectError } from '@/lib/server/projects'
import { jsonError, parseJsonBody } from '@/app/api/_lib/auth'

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const input = await parseJsonBody<ContainerProjectUpdateInput>(request)
  if (!input) return jsonError(400, '请求体不是合法 JSON')
  try {
    return Response.json(await updateContainerProject(id, input))
  } catch (err) {
    const e = projectError(err)
    return jsonError(e.status, e.message)
  }
}
