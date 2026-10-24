/**
 * 新建远端目录：`POST /api/sftp/mkdir`（body: `SftpMkdirInput`）。
 *
 * **不递归**建中间层（SFTP 的 mkdir 就这样）—— 父目录不存在就报错。界面上的「新建文件夹」
 * 永远建在当前浏览的目录下，父目录必然存在，不需要为它长出一条递归逻辑。
 *
 * 鉴权由根中间件统一兜底（`/api/*` 全走 JWT），这里不重复判。
 */
import type { SftpMkdirInput, SftpMutationResult } from '@fizz/contracts/agent-api'
import { describeError, jsonError, parseJsonBody } from '@/app/api/_lib/auth'
import { sftpService } from '@/lib/server/ssh/sftp'

export async function POST(request: Request): Promise<Response> {
  const body = await parseJsonBody<SftpMkdirInput>(request)
  if (!body) return jsonError(400, '缺少请求体')

  const hostId = typeof body.hostId === 'string' ? body.hostId.trim() : ''
  if (!hostId) return jsonError(400, '缺少 hostId')
  const path = typeof body.path === 'string' ? body.path.trim() : ''
  if (!path) return jsonError(400, '缺少 path')

  try {
    await sftpService.mkdir(hostId, path)
    return Response.json({ ok: true } satisfies SftpMutationResult)
  } catch (err) {
    const { status, message } = describeError(err)
    return jsonError(status, message)
  }
}
