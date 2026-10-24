/**
 * 目录浏览 / 建目录的路由壳:逻辑在 `lib/server/projects.ts`
 * (与 AI 工具 `list_dirs` / `create_project` 共用同一套校验)。
 */
import type { FsMkdirInput } from '@fizz/contracts/agent-api'
import { listDirs, mkdirIn, projectError } from '@/lib/server/projects'
import { jsonError, parseJsonBody } from '@/app/api/_lib/auth'

export async function GET(request: Request) {
  const url = new URL(request.url)
  try {
    return Response.json(await listDirs(url.searchParams.get('path') ?? undefined))
  } catch (err) {
    const e = projectError(err)
    return jsonError(e.status, e.message)
  }
}

export async function POST(request: Request) {
  const body = await parseJsonBody<FsMkdirInput>(request)
  if (!body) return jsonError(400, '请求体不是合法 JSON')
  try {
    return Response.json({ path: await mkdirIn(body.parent ?? '', body.name ?? '') })
  } catch (err) {
    const e = projectError(err)
    return jsonError(e.status, e.message)
  }
}
