/**
 * 删除一个主机分组（含多级子树）。
 * DELETE /api/ssh/hosts/groups/:id[?deleteHosts=1] → `{ groups, hosts }`
 *
 * 默认只删分组：子孙分组与组内主机（SSH 主机 + 本机终端）整体上移一级；
 * `deleteHosts=1` 时连同子树内主机一起删（挂它们上面的隧道也一并清掉，不留悬空引用）。
 *
 * 两份数据一起返回：渲染端无论如何都要同时更新分组树与主机列表。
 */
import { domain } from '@/lib/server/state'
import { describeError, jsonError } from '@/app/api/_lib/auth'
import { dropHostMonitor } from '@/lib/server/ssh/monitor'
import { tunnelManager } from '@/lib/server/ssh/tunnels'

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const deleteHosts = new URL(request.url).searchParams.get('deleteHosts') === '1'
  try {
    // 连主机一起删时，先把它们的采集连接与隧道收掉 —— 否则会留下没人管得到的
    // 孤儿监听 / 后台连接，一直连到那台机器上（与 DELETE /api/ssh/hosts/:id 同一条理由）
    const doomed = deleteHosts ? domain.hostIdsInGroupSubtree(id) : []
    const next = domain.deleteHostGroup(id, deleteHosts)
    for (const hostId of doomed) {
      tunnelManager.stopByHost(hostId)
      dropHostMonitor(hostId)
    }
    return Response.json(next)
  } catch (err) {
    const { status, message } = describeError(err)
    return jsonError(status, message)
  }
}
