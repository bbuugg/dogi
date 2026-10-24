/**
 * 主机清单路由（SSH 主机 + 本机终端）：列表 / 新建 / 更新。
 * GET  /api/ssh/hosts  → `HostConfig[]`（SSH 脱敏，不含明文凭据；本机终端无凭据）
 * POST /api/ssh/hosts  body `HostInput`（带 id 更新 / 不带新建；按 kind 区分）→ 列表
 */
import { domain } from '@/lib/server/state'
import { describeError, jsonError, parseJsonBody } from '@/app/api/_lib/auth'
import { dropHostMonitor } from '@/lib/server/ssh/monitor'
import { tunnelManager } from '@/lib/server/ssh/tunnels'

export async function GET() {
  return Response.json(domain.listSshHosts())
}

export async function POST(request: Request) {
  const body = await parseJsonBody<Parameters<typeof domain.saveSshHost>[0]>(request)
  if (!body) return jsonError(400, '请求体不是合法 JSON')
  try {
    domain.saveSshHost(body)
  } catch (err) {
    const { status, message } = describeError(err)
    return jsonError(status, message)
  }
  /**
   * 带 id 的保存 = 改了一条已有主机：把它的采集连接收掉，让下一次取数按**新参数**重连。
   * 不收的话旧采集器还连着老地址，徽标会继续显示老机器的指标（一直到空闲回收为止），
   * 看起来就是「改了没生效」。新建（不带 id）没有旧连接，调用是空操作。
   *
   * 同一条理由适用于隧道：改了主机地址 / 凭据后，旧隧道还挂在老连接上（而且地址已经
   * 不是用户以为的那个了），先停掉、让用户按新参数重启 —— 与「改隧道配置」一致。
   */
  if (body.id) {
    dropHostMonitor(body.id)
    tunnelManager.stopByHost(body.id)
  }
  return Response.json(domain.listSshHosts())
}
