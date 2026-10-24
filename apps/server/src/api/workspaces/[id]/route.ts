/**
 * 单个工作区(项目)的操作。
 * - DELETE:移除工作区(级联 + 可选连 worktree 磁盘目录):三道闸与清理流程在
 *   `lib/server/projects.ts` 的 `removeProject`,与 AI 工具 `remove_project` 共用;
 * - PATCH:重命名(body: `WorkspaceRenameInput`)
 */
import type { WorkspaceDeleteInput, WorkspaceRenameInput } from '@fizz/contracts/agent-api'
import { projectError, removeProject } from '@/lib/server/projects'
import { domain } from '@/lib/server/state'
import { describeError, jsonError, parseJsonBody } from '@/app/api/_lib/auth'

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  // body 允许整个缺省:老前端 / 直接手敲 URL 时就是「只摘记录」
  const input = (await parseJsonBody<WorkspaceDeleteInput>(request)) ?? {}
  try {
    return Response.json(await removeProject(id, input))
  } catch (err) {
    const e = projectError(err)
    return jsonError(e.status, e.message)
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const workspace = domain.getWorkspace(id)
  if (!workspace) return jsonError(404, '工作区不存在')

  const input = await parseJsonBody<WorkspaceRenameInput>(request)
  if (!input) return jsonError(400, '请求体不是合法 JSON')
  const name = input.name?.trim()
  if (!name) return jsonError(400, '名称不能为空')

  try {
    // 复用 addWorkspace 的更新分支:带 id + 原路径 = 只改名字,并保留 isWorktree 等标记
    return Response.json(await domain.addWorkspace({ id, path: workspace.path, name }))
  } catch (err) {
    const { status, message } = describeError(err)
    return jsonError(status, message)
  }
}
