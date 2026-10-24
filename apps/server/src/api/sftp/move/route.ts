/**
 * 远端移动：`POST /api/sftp/move`（body: `SftpMoveInput`）。
 *
 * 优先走 SFTP 原生 rename（同盘瞬时完成）；跨文件系统时服务端自动回退为
 * 「复制 + 删除源」（见 `SftpService.move`）—— 所以渲染端的「移动到…」只发这一条请求，
 * 不必自己判两次。
 *
 * 鉴权由根中间件统一兜底（`/api/*` 全走 JWT），这里不重复判。
 */
import type { SftpMoveInput, SftpMutationResult } from '@fizz/contracts/agent-api'
import { describeError, jsonError, parseJsonBody } from '@/app/api/_lib/auth'
import { sftpService } from '@/lib/server/ssh/sftp'

export async function POST(request: Request): Promise<Response> {
  const body = await parseJsonBody<SftpMoveInput>(request)
  if (!body) return jsonError(400, '缺少请求体')

  const hostId = typeof body.hostId === 'string' ? body.hostId.trim() : ''
  if (!hostId) return jsonError(400, '缺少 hostId')
  const from = typeof body.from === 'string' ? body.from.trim() : ''
  const to = typeof body.to === 'string' ? body.to.trim() : ''
  if (!from || !to) return jsonError(400, '缺少 from 或 to')

  try {
    await sftpService.move(hostId, from, to)
    return Response.json({ ok: true } satisfies SftpMutationResult)
  } catch (err) {
    const { status, message } = describeError(err)
    return jsonError(status, message)
  }
}
