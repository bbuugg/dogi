/**
 * 中止一轮对话。
 * POST /api/chat/abort
 *
 * body 二选一：
 * - `{ requestId }`：用户点「停止」（停止按钮手里有 requestId）；
 * - `{ conversationId }`：按会话找正在跑的 run 停掉，没有则 no-op
 *   （attach 才是「刷新后接回现场」的正路，这里只是兜底的停止通道）。
 *
 * 两种都会**等这一轮真正收尾**（runner 结束、部分产出落盘、挂起的审批 / 提问解开）
 * 才返回 —— 调用方停完就拿「已落盘」的状态去拉历史，不会抢在落盘前面。
 */
import { abortAcpTurn } from '@fizz/acp'
import { getRun, findActiveByConversation, abortRun } from '@/lib/server/chat-run'
import { parseJsonBody } from '@/app/api/_lib/auth'

/** 等收尾的兜底上限：runner 正常毫秒级就结束，超时多半是卡死的工具，别把请求吊死 */
const SETTLE_TIMEOUT_MS = 10_000

export async function POST(request: Request) {
  const body = await parseJsonBody<{ requestId?: string; conversationId?: string }>(request)
  const run = body?.requestId
    ? getRun(body.requestId)
    : body?.conversationId
      ? findActiveByConversation(body.conversationId)
      : undefined
  if (!run || run.finishedAt !== undefined) return Response.json({ aborted: false })
  if (run.acpTarget) abortAcpTurn(run.acpTarget.agentId, run.acpTarget.conversationId)
  abortRun(run)
  await Promise.race([run.done, new Promise((resolve) => setTimeout(resolve, SETTLE_TIMEOUT_MS))])
  return Response.json({ aborted: true })
}
