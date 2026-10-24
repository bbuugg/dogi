/**
 * 取消多智能体协作里一个正在跑的子任务：POST /api/chat/collab/cancel
 *
 * 只能取消**当前正在跑的那条 run** 里的任务（run 结束后运行时就收掉了）。
 * 找不到会话在跑的 run / 任务已结束都返回 `{ ok: false }`，不报错 —— 客户端
 * 点「停止」时任务可能刚好自己跑完，这不是故障。
 */
import type { CollabCancelInput, CollabCancelResult } from '@fizz/contracts/agent-api'
import { domain } from '@/lib/server/state'
import { findActiveByConversation } from '@/lib/server/chat-run'
import { jsonError, parseJsonBody } from '@/app/api/_lib/auth'

export async function POST(request: Request): Promise<Response> {
  const input = await parseJsonBody<CollabCancelInput>(request)
  if (!input?.conversationId || !input.taskId) {
    return jsonError(400, '缺少 conversationId / taskId')
  }
  const conversation = domain.getConversation(input.conversationId)
  if (!conversation || conversation.kind !== 'collab') {
    return jsonError(400, '这不是多智能体协作会话')
  }
  const run = findActiveByConversation(input.conversationId)
  const ok = run?.collabCancel?.(input.taskId) ?? false
  const result: CollabCancelResult = { ok }
  return Response.json(result)
}
