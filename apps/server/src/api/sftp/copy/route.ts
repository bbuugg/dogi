/**
 * 远端复制：`POST /api/sftp/copy`（body: `SftpCopyInput`）。
 *
 * ssh2 没有原生 copy，服务端自建「SFTP 读流 → SFTP 写流」，目录递归。同名目标会被覆盖。
 *
 * 鉴权由根中间件统一兜底（`/api/*` 全走 JWT），这里不重复判。
 */
import type { SftpCopyInput, SftpMutationResult } from '@fizz/contracts/agent-api'
import { describeError, jsonError, parseJsonBody } from '@/app/api/_lib/auth'
import { sftpService } from '@/lib/server/ssh/sftp'

export async function POST(request: Request): Promise<Response> {
  const body = await parseJsonBody<SftpCopyInput>(request)
  if (!body) return jsonError(400, '缺少请求体')

  const hostId = typeof body.hostId === 'string' ? body.hostId.trim() : ''
  if (!hostId) return jsonError(400, '缺少 hostId')
  const from = typeof body.from === 'string' ? body.from.trim() : ''
  const to = typeof body.to === 'string' ? body.to.trim() : ''
  if (!from || !to) return jsonError(400, '缺少 from 或 to')

  try {
    await sftpService.copy(hostId, from, to)
    return Response.json({ ok: true } satisfies SftpMutationResult)
  } catch (err) {
    const { status, message } = describeError(err)
    return jsonError(status, message)
  }
}
