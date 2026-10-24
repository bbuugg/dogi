/**
 * 单个定时任务：改 / 删。
 * GET    /api/task-triggers/[id]
 * DELETE /api/task-triggers/[id]
 *
 * PATCH 只用于开关（`{ enabled }`）—— 改内容走列表路由的 POST（带 id 即为更新）。
 *
 * 写后 `syncTriggers()` 对齐定时器投影（启用/停用/删除都要立刻反映到调度器），
 * 内部吞错只打日志。
 */
import { triggerDomain } from '@/lib/server/state'
import { syncTriggers } from '@/lib/server/scheduler'
import { jsonError, parseJsonBody } from '@/app/api/_lib/auth'

type Ctx = { params: Promise<{ id: string }> }

export async function GET(_request: Request, { params }: Ctx) {
  const { id } = await params
  const trigger = triggerDomain.getTrigger(id)
  if (!trigger) return jsonError(404, '定时任务不存在')
  return Response.json(trigger)
}

export async function PATCH(request: Request, { params }: Ctx) {
  const { id } = await params
  const trigger = triggerDomain.getTrigger(id)
  if (!trigger) return jsonError(404, '定时任务不存在')
  const body = await parseJsonBody<{ enabled?: boolean }>(request)
  if (!body || typeof body.enabled !== 'boolean') return jsonError(400, '缺少 enabled')
  const saved = triggerDomain.saveTrigger({ ...trigger, enabled: body.enabled })
  syncTriggers()
  return Response.json(saved)
}

export async function DELETE(_request: Request, { params }: Ctx) {
  const { id } = await params
  if (!triggerDomain.getTrigger(id)) return jsonError(404, '定时任务不存在')
  // 只删规则，不动它已经起出来的会话（那些是产物，与 `removeTask` 的语义一致）
  triggerDomain.deleteTrigger(id)
  syncTriggers()
  return Response.json({ ok: true })
}
