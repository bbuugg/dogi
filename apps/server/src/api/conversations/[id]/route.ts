/**
 * 单个会话：获取（含完整消息历史）/ 删除 / 重命名。
 *
 * PATCH /api/conversations/:id     → 重命名（body: { title }）
 * PATCH /api/conversations/:id/target → 设置/清除会话记住的模型（在 target/route.ts 里）
 */
import type { ConversationRenameInput } from '@fizz/contracts/agent-api'
import { domain } from '@/lib/server/state'
import { stopSessionRunning } from '@/lib/server/background-tasks'
import { forgetAcpTranscript } from '@/lib/server/acp-transcripts'
import { describeError, jsonError, parseJsonBody } from '@/app/api/_lib/auth'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const conversation = domain.getConversation(id)
  if (!conversation) return jsonError(404, '会话不存在')
  return Response.json(conversation)
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  // 先停掉这个会话名下的后台命令再删：进程属于会话，会话没了就再没有能显示它的容器。
  // 只发信号不等收场（删除不该被一条杀不掉的进程拖住），任务体自己尽快收尾。
  stopSessionRunning(id)
  domain.deleteConversation(id)
  forgetAcpTranscript(id)
  return Response.json(domain.listConversations())
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const body = await parseJsonBody<ConversationRenameInput>(request)
  if (!body) return jsonError(400, '请求体不是合法 JSON')
  if (typeof body?.title !== 'string' || !body.title.trim()) {
    return jsonError(400, '缺少 title')
  }
  try {
    domain.renameConversation(id, body.title)
    return Response.json(domain.listConversations())
  } catch (err) {
    const { status, message } = describeError(err)
    return jsonError(status, message)
  }
}
