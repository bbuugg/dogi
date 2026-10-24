/**
 * 重命名 / 移动一个远端条目：`POST /api/sftp/rename`（body: `SftpRenameInput`）。
 *
 * 重命名与「同盘移动」在 SFTP 里是同一个操作（rename），所以只留一条路由。
 * 跨文件系统的移动由渲染端先试这条、失败再走 `/api/sftp/copy` + `/api/sftp/remove`，
 * 服务端保持「rename 就是 rename」的纯粹语义。
 *
 * 鉴权由根中间件统一兜底（`/api/*` 全走 JWT），这里不重复判。
 */
import type { SftpRenameInput, SftpMutationResult } from '@fizz/contracts/agent-api'
import { describeError, jsonError, parseJsonBody } from '@/app/api/_lib/auth'
import { sftpService } from '@/lib/server/ssh/sftp'

export async function POST(request: Request): Promise<Response> {
  const body = await parseJsonBody<SftpRenameInput>(request)
  if (!body) return jsonError(400, '缺少请求体')

  const hostId = typeof body.hostId === 'string' ? body.hostId.trim() : ''
  if (!hostId) return jsonError(400, '缺少 hostId')
  const from = typeof body.from === 'string' ? body.from.trim() : ''
  const to = typeof body.to === 'string' ? body.to.trim() : ''
  if (!from || !to) return jsonError(400, '缺少 from 或 to')

  try {
    await sftpService.rename(hostId, from, to)
    return Response.json({ ok: true } satisfies SftpMutationResult)
  } catch (err) {
    const { status, message } = describeError(err)
    return jsonError(status, message)
  }
}
