/**
 * 打开 acp 会话时把 agent 侧会话 load 回来（重建视图用）。
 * GET /api/acp/agents/:id/transcript?conversationId=&sessionId=&cwd=
 *
 * 消息本体在 agent 侧（本地不落盘）：这里做「视图恢复」—— `session/load` 的
 * 历史回放（含用户消息）折成结构化消息一次性返回，客户端 setMessages 直接渲染。
 * agent 没广告 loadSession 能力 / 会话失效 → 报错，客户端保持空视图不阻塞对话。
 */
import { replayAcpSession, type AcpAgentConfig } from '@fizz/acp'
import { domain } from '@/lib/server/state'
import { findActiveByConversation } from '@/lib/server/chat-run'
import { getAcpTranscript, setAcpTranscript } from '@/lib/server/acp-transcripts'
import { refreshAcpSessionState } from '@/lib/server/acp-session-state'
import { describeError, jsonError } from '@/app/api/_lib/auth'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  let agent: AcpAgentConfig
  try {
    agent = domain.resolveAcpAgent(id)
  } catch (err) {
    const { status, message } = describeError(err)
    return jsonError(status, message)
  }
  const url = new URL(request.url)
  const conversationId = url.searchParams.get('conversationId')?.trim() || ''
  const sessionId = url.searchParams.get('sessionId')?.trim() || ''
  const cwd = url.searchParams.get('cwd')?.trim() || ''
  if (!conversationId) {
    return jsonError(400, '缺少 conversationId')
  }
  /**
   * ⚠️ 这一轮还在跑时**绝不能**走 `replayAcpSession`：它开头就 teardown 同 key 的
   * ACP 进程，正在等 nextUpdate 的 ActiveSession 会以 `ACP connection closed` 失败。
   * 此时视图由进程内快照 + 前端 attach 帧日志恢复；等 idle 了才用 session/load。
   */
  const active = findActiveByConversation(conversationId)
  if (active) {
    // 收尾时助手消息会先写进快照、再 finishRun；这中间仍算「在跑」，而 attach 的
    // 帧日志会从头重建同一条助手消息 —— 这里先把当前轮的助手消息摘掉，避免叠加两份。
    const currentId = active.assistantMessageId
    const messages = getAcpTranscript(conversationId) ?? []
    return Response.json({
      messages: currentId ? messages.filter((m) => m.id !== currentId) : messages
    })
  }
  if (!sessionId || !cwd) {
    return jsonError(400, '缺少 sessionId / cwd')
  }
  try {
    const before = getAcpTranscript(conversationId)
    const messages = await replayAcpSession({
      agent,
      conversationId,
      workspacePath: cwd,
      sessionId
    })
    /**
     * idle 时 load 是权威视图：顺手刷新快照，供下一次「跑动中刷新」使用。
     *
     * ⚠️ 回放是异步的，期间用户可能已经发出新一轮（beginTurnUserMessage 会往快照里
     * 追加用户消息）。这里只把**回放期间新增的尾巴**接回去，别整份覆盖掉。
     */
    const after = getAcpTranscript(conversationId) ?? []
    const appended = before ? after.slice(before.length) : after
    setAcpTranscript(conversationId, [...messages, ...appended])
    // load 会把 agent 广告的档位带回来（可能被重置成默认）：刷新进会话配置，保留用户选的档
    refreshAcpSessionState(conversationId, agent.id)
    return Response.json({ messages })
  } catch (err) {
    const { status, message } = describeError(err)
    return jsonError(status, message)
  }
}
