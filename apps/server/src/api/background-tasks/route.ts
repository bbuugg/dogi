/**
 * 后台任务清单：服务端进程内那份「正在跑 / 刚跑完」的清单。
 *
 * - `GET  /api/background-tasks` → `BackgroundTasksResult`（状态栏那一小块轮询的就是它）
 * - `DELETE /api/background-tasks` → 清掉全部**已结束**的，运行中的不动
 *
 * 只读 + 清理，两条都不会打断正在跑的活。
 */
import type { BackgroundTasksResult } from '@fizz/contracts/agent-api'
import { clearFinishedBackgroundTasks, listBackgroundTasks } from '@/lib/server/background-tasks'

export async function GET() {
  const result: BackgroundTasksResult = { tasks: listBackgroundTasks() }
  return Response.json(result)
}

export async function DELETE() {
  clearFinishedBackgroundTasks()
  const result: BackgroundTasksResult = { tasks: listBackgroundTasks() }
  return Response.json(result)
}
