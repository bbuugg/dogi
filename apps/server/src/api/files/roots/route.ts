/**
 * `GET /api/files/roots` —— 文件管理器的可跳转位置（主目录 / 盘符 / 常用目录 / 回收站位置）。
 *
 * 界面打开时就调它：一来确定「默认落在哪」（主目录），二来知道这台机器要显示盘符
 * （Windows）还是只要一个 `/`（POSIX）。
 */
import { describeError, jsonError } from '@/app/api/_lib/auth'
import { listRoots } from '@/lib/server/file-manager/list'

export async function GET() {
  try {
    return Response.json(await listRoots())
  } catch (err) {
    const e = describeError(err)
    return jsonError(e.status, e.message)
  }
}
