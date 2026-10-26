/**
 * `GET /api/files/list?path=<abs>` —— 列一个目录（`path` 缺省 = 服务端主目录）。
 *
 * 逻辑在 `lib/server/file-manager/list.ts`；这里只做「query → 领域函数 → JSON」的搬运。
 * 错误统一走 `describeError`（「不存在 / 不支持」这类归 400，其余 500）。
 */
import { describeError, jsonError } from '@/app/api/_lib/auth'
import { listDir } from '@/lib/server/file-manager/list'

export async function GET(request: Request) {
  const url = new URL(request.url)
  try {
    return Response.json(await listDir(url.searchParams.get('path')))
  } catch (err) {
    const e = describeError(err)
    return jsonError(e.status, e.message)
  }
}
