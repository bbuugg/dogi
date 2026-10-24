/**
 * POST /api/ssh/tunnels/:id/stop → 快照
 *
 * 幂等：没在跑也返回当前快照（状态落回 `stopped`），不报「没启动」的错 ——
 * 界面上「停止」是用户表达意图，不是一个必须成立的前置条件。
 */
import { tunnelManager } from '@/lib/server/ssh/tunnels'
import { describeError, jsonError } from '@/app/api/_lib/auth'

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  try {
    tunnelManager.stop(id)
    return Response.json(tunnelManager.snapshot())
  } catch (err) {
    const { status, message } = describeError(err)
    return jsonError(status, message)
  }
}
