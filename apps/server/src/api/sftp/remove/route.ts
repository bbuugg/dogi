/**
 * 删除远端文件 / 目录：`POST /api/sftp/remove`（body: `SftpRemoveInput`）。
 *
 * 目录**递归删除**（等价 `rm -rf`）—— 与服务端 `SftpService.removeEntry` 的语义一致。
 * 这是不可逆操作，界面上必须二次确认（见 `SftpPanel` 的删除确认框）。
 *
 * 鉴权由根中间件统一兜底（`/api/*` 全走 JWT），这里不重复判。
 */
import type { SftpRemoveInput, SftpMutationResult } from '@fizz/contracts/agent-api'
import { describeError, jsonError, parseJsonBody } from '@/app/api/_lib/auth'
import { sftpService } from '@/lib/server/ssh/sftp'

export async function POST(request: Request): Promise<Response> {
  const body = await parseJsonBody<SftpRemoveInput>(request)
  if (!body) return jsonError(400, '缺少请求体')

  const hostId = typeof body.hostId === 'string' ? body.hostId.trim() : ''
  if (!hostId) return jsonError(400, '缺少 hostId')
  const path = typeof body.path === 'string' ? body.path.trim() : ''
  if (!path) return jsonError(400, '缺少 path')

  try {
    await sftpService.remove(hostId, path)
    return Response.json({ ok: true } satisfies SftpMutationResult)
  } catch (err) {
    const { status, message } = describeError(err)
    return jsonError(status, message)
  }
}
