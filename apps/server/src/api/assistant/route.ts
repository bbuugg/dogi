/**
 * 项目管理助手:发一句话并返回 SSE 流(帧协议与 /api/chat 完全一致)。
 * POST /api/assistant(body: `AssistantSendInput`)
 *
 * 路由壳:一轮的启动在 `lib/server/assistant-turn.ts`;断线接回复用
 * GET /api/chat/stream?requestId=、审批复用 POST /api/chat/confirm(run 与
 * 审批注册表都是共享单例,助手会话 id 以 asst- 前缀隔离)。
 */
import type { AssistantSendInput } from '@fizz/contracts/agent-api'
import { startAssistantTurn } from '@/lib/server/assistant-turn'
import { pipeRun } from '@/app/api/_lib/chat-stream'
import { jsonError, parseJsonBody } from '@/app/api/_lib/auth'

export async function POST(request: Request) {
  const body = await parseJsonBody<AssistantSendInput>(request)
  if (!body) return jsonError(400, '请求体不是合法 JSON')

  const started = await startAssistantTurn(body)
  if (!started.ok) return jsonError(started.status, started.message)
  return pipeRun(started.run)
}
