/**
 * 列一个远端目录：`POST /api/sftp/list`（body: `SftpListInput`）。
 *
 * 「SFTP 文件管理」标签的读接口 —— 每进一个目录就是这个请求。返回归一化后的目录路径
 * （渲染端回填路径栏，省得两端各写一遍归一化）与排好序的目录项。
 *
 * 排目录 / 建目录 / 删除都是「一问一答」的短操作，**不带 transferId、不可取消**
 * （见 `SftpListInput` 的说明）。
 *
 * 鉴权由根中间件统一兜底（`/api/*` 全走 JWT），这里不重复判。
 */
import type { SftpListInput, SftpListResult } from '@fizz/contracts/agent-api'
import { describeError, jsonError, parseJsonBody } from '@/app/api/_lib/auth'
import { normalizeSftpPath, sftpService } from '@/lib/server/ssh/sftp'

export async function POST(request: Request): Promise<Response> {
  const body = await parseJsonBody<SftpListInput>(request)
  if (!body) return jsonError(400, '缺少请求体')

  const hostId = typeof body.hostId === 'string' ? body.hostId.trim() : ''
  if (!hostId) return jsonError(400, '缺少 hostId')
  if (typeof body.path !== 'string') return jsonError(400, '缺少 path')

  const path = normalizeSftpPath(body.path)
  try {
    const entries = await sftpService.list(hostId, path)
    return Response.json({ path, entries } satisfies SftpListResult)
  } catch (err) {
    const { status, message } = describeError(err)
    return jsonError(status, message)
  }
}
