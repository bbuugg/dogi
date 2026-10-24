/**
 * 查某会话有没有正在跑的对话。
 * GET /api/chat/active?conversationId=
 *
 * 刷新 / 切回会话时，客户端先问这里：有 run 在跑就插占位消息、
 * 走 `GET /api/chat/stream?requestId=` 接回现场；没有就走拉历史那条路。
 */
import type { ChatActiveResult } from '@fizz/contracts/agent-api'
import { findActiveByConversation, summarize } from '@/lib/server/chat-run'
import { jsonError } from '@/app/api/_lib/auth'

export async function GET(request: Request) {
  const url = new URL(request.url)
  const conversationId = url.searchParams.get('conversationId')
  if (!conversationId) return jsonError(400, '缺少 conversationId')
  const run = findActiveByConversation(conversationId)
  const result: ChatActiveResult = { run: run ? summarize(run) : null }
  return Response.json(result)
}
