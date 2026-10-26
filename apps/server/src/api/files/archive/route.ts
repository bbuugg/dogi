/**
 * `GET /api/files/archive?path=` —— 列压缩包里的条目（zip / tar / tar.gz / gz）。
 *
 * 只读中央目录 / tar 头，**不解压**，所以看一个 500MB 的包也很快。真正的解压是
 * `POST /api/files/op` 的 `extract`。
 */
import { describeError, jsonError } from '@/app/api/_lib/auth'
import { listArchive } from '@/lib/server/file-manager/archive'
import { normalizeTarget } from '@/lib/server/file-manager/paths'

export async function GET(request: Request) {
  const url = new URL(request.url)
  try {
    const abs = normalizeTarget(url.searchParams.get('path'))
    const { format, entries } = await listArchive(abs)
    // 列表要回给浏览器，条目太多就截断（界面上只需要「里面大概有什么」）
    const limited = entries.slice(0, 5000)
    return Response.json({
      path: abs,
      format,
      entries: limited,
      ...(entries.length > limited.length ? { truncated: true } : {})
    })
  } catch (err) {
    const e = describeError(err)
    return jsonError(e.status, e.message)
  }
}
