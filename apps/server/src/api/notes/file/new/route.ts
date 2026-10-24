/**
 * 在某个目录下新建一篇空笔记。
 *
 * 名字由服务端取（`未命名.md` → `未命名 2.md` → …，用 `wx` 原子避让），应答里带
 * 新建出来的相对路径 —— 客户端拿它直接开标签（见 `features/notes/NotesSidebar.tsx`）。
 */
import type { NotesCreateInput } from '@fizz/contracts/types'
import { jsonError, parseJsonBody } from '@/app/api/_lib/auth'
import { createNote, notesError } from '@/lib/server/notes'

export async function POST(request: Request) {
  const body = await parseJsonBody<NotesCreateInput>(request)
  if (!body) return jsonError(400, '请求体不是合法 JSON')
  try {
    return Response.json(await createNote(body.rootId ?? '', body.dir ?? ''))
  } catch (err) {
    const e = notesError(err)
    return jsonError(e.status, e.message)
  }
}
