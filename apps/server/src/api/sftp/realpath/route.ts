/**
 * 解析远端绝对路径：`POST /api/sftp/realpath`（body: `SftpRealpathInput`）。
 *
 * 拖拽上传用它拿目标目录的**初值**：`path` 缺省或 `.` 时服务端解析成远端默认工作目录
 * （通常是家目录）。为什么不给「shell 的当前工作目录」—— 那个拿不到：shell 默认不发
 * OSC 7，解析提示符又不可靠（同 dogi 的结论）。所以先给家目录，让用户在确认条里改，
 * 并在会话内记住上次用过的目录。
 *
 * 鉴权由根中间件统一兜底（`/api/*` 全走 JWT），这里不重复判。
 */
import type { SftpRealpathInput, SftpRealpathResult } from '@fizz/contracts/agent-api'
import { describeError, jsonError, parseJsonBody } from '@/app/api/_lib/auth'
import { sftpService } from '@/lib/server/ssh/sftp'

export async function POST(request: Request): Promise<Response> {
  const body = await parseJsonBody<SftpRealpathInput>(request)
  if (!body) return jsonError(400, '缺少请求体')
  const hostId = typeof body.hostId === 'string' ? body.hostId.trim() : ''
  if (!hostId) return jsonError(400, '缺少 hostId')

  try {
    const path = await sftpService.realpath(
      hostId,
      typeof body.path === 'string' ? body.path : undefined
    )
    return Response.json({ path } satisfies SftpRealpathResult)
  } catch (err) {
    const { status, message } = describeError(err)
    return jsonError(status, message)
  }
}
