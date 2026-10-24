/**
 * 笔记根目录的列出 / 登记。
 *
 * 登记逻辑在 `@fizz/workspace` 的 `addNotesRoot`（校验绝对路径 + 目录存在 + 幂等），
 * 这里只做「解析 body → 调 domain → 映射错误」。
 */
import type { NotesRootInput } from '@fizz/contracts/types'
import { describeError, jsonError, parseJsonBody } from '@/app/api/_lib/auth'
import { domain } from '@/lib/server/state'

export async function GET() {
  return Response.json(domain.listNotesRoots())
}

export async function POST(request: Request) {
  const body = await parseJsonBody<NotesRootInput>(request)
  if (!body) return jsonError(400, '请求体不是合法 JSON')
  try {
    return Response.json(await domain.addNotesRoot({ path: body.path ?? '', name: body.name }))
  } catch (err) {
    // 这里的错误来自 domain 的普通 Error（「必须是绝对路径」「目录不存在」），
    // describeError 会按消息里的关键词判成 400 —— 都是用户改一下就能解决的
    const e = describeError(err)
    return jsonError(e.status, e.message)
  }
}
