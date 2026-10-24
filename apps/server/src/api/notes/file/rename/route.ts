/**
 * 重命名一篇笔记（只换文件名，不换目录）。
 *
 * 应答里带**新的相对路径**：客户端要拿它更新标签登记表里的路径，否则标签点开
 * 就会 404（见 `app/layout/tool-tabs.ts` 的 `retargetNoteTab`）。
 */
import type { NotesRenameInput } from '@fizz/contracts/types'
import { jsonError, parseJsonBody } from '@/app/api/_lib/auth'
import { notesError, renameNote } from '@/lib/server/notes'

export async function POST(request: Request) {
  const body = await parseJsonBody<NotesRenameInput>(request)
  if (!body) return jsonError(400, '请求体不是合法 JSON')
  try {
    return Response.json(await renameNote(body.rootId ?? '', body.path ?? '', body.name ?? ''))
  } catch (err) {
    const e = notesError(err)
    return jsonError(e.status, e.message)
  }
}
