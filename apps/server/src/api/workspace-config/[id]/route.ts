/**
 * 工作区目录配置：读写 <工作区>/.fizz/workspace.json（快捷功能等）。
 */
import { domain } from '@/lib/server/state'
import { describeError, jsonError } from '@/app/api/_lib/auth'
import { readWorkspaceConfig, saveWorkspaceConfig } from '@/lib/server/services/workspace-config'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const workspace = domain.getWorkspace(id)
  if (!workspace) return jsonError(404, '工作区不存在')
  try {
    return Response.json(await readWorkspaceConfig(workspace))
  } catch (err) {
    const { status, message } = describeError(err)
    return jsonError(status, message)
  }
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const workspace = domain.getWorkspace(id)
  if (!workspace) return jsonError(404, '工作区不存在')
  try {
    const input: unknown = await request.json()
    return Response.json(await saveWorkspaceConfig(workspace, input))
  } catch (err) {
    const { status, message } = describeError(err)
    return jsonError(status, message)
  }
}
