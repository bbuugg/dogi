/**
 * 把一条还在跑的后台任务「转到后台」：`POST /api/background-tasks/:id/detach`。
 *
 * 与 cancel 的区别是**只断开等待方**（那条 `POST /api/workspaces/clone` 立刻回包），
 * 任务本身继续跑 —— 用户关掉弹窗去干别的，克隆照旧，进度留在状态栏。
 *
 * 幂等：任务不存在 / 已结束都回 200 + 最新清单。
 */
import type { BackgroundTasksResult } from '@fizz/contracts/agent-api'
import { detachBackgroundTask, listBackgroundTasks } from '@/lib/server/background-tasks'

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  detachBackgroundTask(id)
  const result: BackgroundTasksResult = { tasks: listBackgroundTasks() }
  return Response.json(result)
}
