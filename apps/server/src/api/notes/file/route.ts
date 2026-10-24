/**
 * 单篇笔记的读 / 写 / 删（逻辑在 `lib/server/notes.ts`）。
 *
 * 三者的边界一致：**先取出登记过的根、再 `resolveInside`**，且只放行 `.md` / `.markdown`。
 * 越界一律 403 —— 这组接口不是通用文件读写。
 */
import type { NotesWriteInput } from '@fizz/contracts/types'
import { jsonError, parseJsonBody } from '@/app/api/_lib/auth'
import { deleteNote, notesError, readNote, writeNote } from '@/lib/server/notes'

export async function GET(request: Request) {
  const url = new URL(request.url)
  try {
    return Response.json(
      await readNote(url.searchParams.get('rootId') ?? '', url.searchParams.get('path') ?? '')
    )
  } catch (err) {
    const e = notesError(err)
    return jsonError(e.status, e.message)
  }
}

export async function POST(request: Request) {
  const body = await parseJsonBody<NotesWriteInput>(request)
  if (!body) return jsonError(400, '请求体不是合法 JSON')
  try {
    await writeNote(body.rootId ?? '', body.path ?? '', body.content)
    return new Response(null, { status: 204 })
  } catch (err) {
    const e = notesError(err)
    return jsonError(e.status, e.message)
  }
}

export async function DELETE(request: Request) {
  const url = new URL(request.url)
  try {
    await deleteNote(url.searchParams.get('rootId') ?? '', url.searchParams.get('path') ?? '')
    return new Response(null, { status: 204 })
  } catch (err) {
    const e = notesError(err)
    return jsonError(e.status, e.message)
  }
}
