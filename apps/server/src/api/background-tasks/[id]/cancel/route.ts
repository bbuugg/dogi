/**
 * 取消一条还在跑的后台任务：`POST /api/background-tasks/:id/cancel`。
 *
 * 先把 abort 递给任务体（克隆那边会杀 git 进程树 + 删掉半份目录），**等它收场**再回包 ——
 * 用户点完取消立刻用同一个目录重试，不会撞「目标目录已存在」。
 *
 * 幂等：任务已结束 / 不存在都回 200 + 最新清单，不当错误（取消是用户的正常操作）。
 */
import type { BackgroundTasksResult } from '@fizz/contracts/agent-api'
import { cancelBackgroundTask, listBackgroundTasks } from '@/lib/server/background-tasks'

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  await cancelBackgroundTask(id)
  const result: BackgroundTasksResult = { tasks: listBackgroundTasks() }
  return Response.json(result)
}
