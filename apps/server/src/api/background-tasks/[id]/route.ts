/**
 * 单条后台任务：
 * - `GET /api/background-tasks/:id` → `BackgroundTaskDetail`（任务 + 保留的日志行）
 * - `DELETE /api/background-tasks/:id` → 只从列表里抹掉一条**已结束**的任务
 *
 * GET 单独一条而不是把日志塞进列表：列表 2s 轮询一次，日志只有用户点开某一行时才有人看。
 *
 * DELETE 不碰任何磁盘产物；仍在跑的任务回 409 —— 让它「消失」而不打断进程会很误导
 * （活还在跑，界面上却什么都没了），要停请走 cancel。
 */
import type { BackgroundTaskDetail, BackgroundTasksResult } from '@fizz/contracts/agent-api'
import {
  dismissBackgroundTask,
  getBackgroundTaskDetail,
  listBackgroundTasks
} from '@/lib/server/background-tasks'
import { jsonError } from '@/app/api/_lib/auth'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const detail = getBackgroundTaskDetail(id)
  if (!detail) return jsonError(404, '任务不存在')
  const result: BackgroundTaskDetail = detail
  return Response.json(result)
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  if (!dismissBackgroundTask(id)) {
    return jsonError(409, '任务不存在或仍在运行，无法关闭')
  }
  const result: BackgroundTasksResult = { tasks: listBackgroundTasks() }
  return Response.json(result)
}
