/**
 * 列笔记目录的**某一层**（逻辑在 `lib/server/notes.ts`）。
 *
 * `?rootId=` 指定登记过的根，`?dir=` 是相对该根的目录路径（根目录传空）。
 * 只列一层是刻意的：前端展开子目录时再单独请求那一层（懒加载）。
 */
import { jsonError } from '@/app/api/_lib/auth'
import { listNotesDir, notesError } from '@/lib/server/notes'

export async function GET(request: Request) {
  const url = new URL(request.url)
  try {
    return Response.json(
      await listNotesDir(url.searchParams.get('rootId') ?? '', url.searchParams.get('dir') ?? '')
    )
  } catch (err) {
    const e = notesError(err)
    return jsonError(e.status, e.message)
  }
}
