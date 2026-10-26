/**
 * 结束进程：POST `/api/system/tasks/kill`（body: `SystemTaskKillInput`）→
 * `SystemTaskKillResult`。
 *
 * ## 为什么失败也回 200
 *
 * 这里的失败几乎全是**业务性**的：进程已经自己退出了、没有权限、目标是系统进程、
 * 或者是 fizz 自己。这些都不是「请求写错了」，界面要做的事是**把那句话弹出来**。
 * 配 4xx 会逼前端在 `try/catch` 之外再写一条「4xx 也要读 body 里的 error」的分支，
 * 而现有 `request()` 对非 2xx 是直接抛的 —— 一抛，`error` 那句话就丢了。
 *
 * 只有「body 里没有 pid」这种真正的调用错误才回 400。
 */
import type { SystemTaskKillInput } from '@fizz/contracts/agent-api'
import { jsonError, parseJsonBody } from '@/app/api/_lib/auth'
import { killSystemTask } from '@/lib/server/system-tasks'

export async function POST(request: Request) {
  const body = await parseJsonBody<SystemTaskKillInput>(request)
  if (!body || typeof body !== 'object' || typeof body.pid !== 'number') {
    return jsonError(400, '请求体里缺少 pid')
  }
  return Response.json(await killSystemTask(body))
}
