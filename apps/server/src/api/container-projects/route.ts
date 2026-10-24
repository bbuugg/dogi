/**
 * 容器型项目列表 / 创建。
 *
 * - `GET  /api/container-projects` → `{ snapshot: ContainerProjectsSnapshot }`
 *   （与 state ws 的 `containerProjects` 域**同一份投影** —— `containerProjectsSnapshot()`；
 *   端口 / 运行态都是现读，所以这个接口与 WebSocket 推下来的内容一字不差）
 * - `POST /api/container-projects` → 201 + `AgentWorkspace`（body: `ContainerProjectCreateInput`）
 */
import type { ContainerProjectCreateInput } from '@fizz/contracts'
import { createContainerProject } from '@/lib/server/container-projects/create'
import { containerProjectsSnapshot } from '@/lib/server/container-projects/lifecycle'
import { projectError } from '@/lib/server/projects'
import { jsonError, parseJsonBody } from '@/app/api/_lib/auth'

export async function GET() {
  return Response.json({ snapshot: await containerProjectsSnapshot() })
}

export async function POST(request: Request) {
  const input = await parseJsonBody<ContainerProjectCreateInput>(request)
  if (!input) return jsonError(400, '请求体不是合法 JSON')
  try {
    return Response.json(await createContainerProject(input), { status: 201 })
  } catch (err) {
    const e = projectError(err)
    return jsonError(e.status, e.message)
  }
}
