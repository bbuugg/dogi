/**
 * 删除一个脚本分组。
 * DELETE /api/scripts/groups/:id[?deleteScripts=1] → `{ groups, scripts }`
 *
 * 默认只删分组：组内脚本归到「未分组」；`deleteScripts=1` 时连同组内脚本一起删。
 */
import { domain } from '@/lib/server/state'
import { describeError, jsonError } from '@/app/api/_lib/auth'

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const deleteScripts = new URL(request.url).searchParams.get('deleteScripts') === '1'
  try {
    return Response.json(domain.deleteScriptGroup(id, deleteScripts))
  } catch (err) {
    const { status, message } = describeError(err)
    return jsonError(status, message)
  }
}