/**
 * POST /api/ssh/tunnels/:id/start → 快照
 *
 * 启动是**异步**的（要建 SSH 连接、可能经跳板链、再绑端口），所以这里 await 到
 * 有结论为止再返回：调用方拿到的快照里 `status` 已经是 `running` 或 `error`，
 * 不必自己轮询。失败不抛错 —— 原因写在运行态的 `error` 里（界面直接显示）。
 */
import { tunnelManager } from '@/lib/server/ssh/tunnels'
import { describeError, jsonError } from '@/app/api/_lib/auth'

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  try {
    await tunnelManager.start(id)
    return Response.json(tunnelManager.snapshot())
  } catch (err) {
    const { status, message } = describeError(err)
    return jsonError(status, message)
  }
}
