/**
 * 拉这个 ACP agent 侧的既有会话清单（「导入会话」用）。
 * GET /api/acp/agents/:id/sessions?cwd=<项目目录>
 *
 * 走 ACP 的 session/list —— 可选能力：agent 没在 initialize 里广告
 * `sessionCapabilities.list` 时返回 { supported: false }，界面据此隐藏「导入」。
 * cwd 过滤对应「这个项目下有哪些会话」（opencode 等按项目组织会话的 agent）。
 *
 * 删 agent 侧会话（删除会话弹窗勾了「同时删除 agent 侧会话」时调用）：
 * DELETE /api/acp/agents/:id/sessions?sessionId=<acp session id>
 * 同样能力感知（sessionCapabilities.delete）：agent 不支持时返回 { ok:false, supported:false }，
 * 由前端提示「只删了本地」。
 */
import { deleteAcpSession, listAcpSessions, type AcpAgentConfig } from '@fizz/acp'
import { domain } from '@/lib/server/state'
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
  const cwd = url.searchParams.get('cwd')?.trim() || undefined
  try {
    return Response.json(await listAcpSessions({ agent, ...(cwd ? { cwd } : {}) }))
  } catch (err) {
    const { status, message } = describeError(err)
    return jsonError(status, message)
  }
}

export async function DELETE(
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
  const sessionId = url.searchParams.get('sessionId')?.trim()
  if (!sessionId) return jsonError(400, '缺少 sessionId')
  try {
    return Response.json(await deleteAcpSession({ agent, sessionId }))
  } catch (err) {
    const { status, message } = describeError(err)
    return jsonError(status, message)
  }
}
