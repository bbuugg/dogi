/**
 * SSH 隧道清单：
 * GET  /api/ssh/tunnels  → `SshTunnelsSnapshot`（配置 + 运行态）
 * POST /api/ssh/tunnels  body `SshTunnelInput`（带 id 更新 / 不带新建）→ 快照
 *
 * 运行态（连接数 / 起停 / 错误）也在这份响应里，但它**只存在内存**：
 * 配置一变由 store 标脏、状态一变由隧道管理器标脏，两者都经 state-ws 的
 * `sshTunnels` 快照域推给所有前端。这里的返回只是「这次操作的结果」。
 */
import { domain } from '@/lib/server/state'
import { tunnelManager } from '@/lib/server/ssh/tunnels'
import { describeError, jsonError, parseJsonBody } from '@/app/api/_lib/auth'

export async function GET() {
  return Response.json(tunnelManager.snapshot())
}

export async function POST(request: Request) {
  const body = await parseJsonBody<Parameters<typeof domain.saveSshTunnel>[0]>(request)
  if (!body) return jsonError(400, '请求体不是合法 JSON')
  try {
    const saved = domain.saveSshTunnel(body)
    // 改了连接参数（主机 / 监听地址 / 类型）后旧连接还挂在老配置上：停掉，让用户按新配置重启。
    // 与主机改参数时 `dropHostMonitor` 同一条理由 —— 不停的话看起来就是「改了没生效」。
    if (body.id && tunnelManager.isRunning(saved.id)) {
      tunnelManager.stop(saved.id, { reason: '配置已变更' })
    }
    return Response.json(tunnelManager.snapshot())
  } catch (err) {
    const { status, message } = describeError(err)
    return jsonError(status, message)
  }
}
