/**
 * DELETE /api/ssh/tunnels/:id → 快照
 *
 * 先停再删：配置删了而连接还活着的话，那条隧道就成了没人管得到的孤儿监听
 * （列表里已经没有它，界面也就没有停它的入口了）。
 */
import { domain } from '@/lib/server/state'
import { tunnelManager } from '@/lib/server/ssh/tunnels'
import { describeError, jsonError } from '@/app/api/_lib/auth'

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  try {
    tunnelManager.stop(id, { reason: '隧道已删除' })
    domain.deleteSshTunnel(id)
    return Response.json(tunnelManager.snapshot())
  } catch (err) {
    const { status, message } = describeError(err)
    return jsonError(status, message)
  }
}
