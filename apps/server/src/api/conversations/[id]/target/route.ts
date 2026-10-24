/**
 * 设置 / 清除会话记住的模型、MCP 与浏览器偏好。
 * PATCH /api/conversations/:id/target
 *
 * body: ConversationTargetInput
 * 字段显式传 null = 清除（回到「默认」）；undefined = 不动该项。
 */
import type { ConversationTargetInput } from '@fizz/contracts/agent-api'
import { agentBrowserSessionId } from '@fizz/contracts'
import { browserSessions } from '@fizz/tools'
import { domain } from '@/lib/server/state'
import { describeError, jsonError, parseJsonBody } from '@/app/api/_lib/auth'

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const body = await parseJsonBody<ConversationTargetInput>(request)
  if (!body) return jsonError(400, '请求体不是合法 JSON')
  try {
    domain.setConversationTarget(id, body)
    /**
     * 浏览器偏好（开关 / 来源）改了就把**这个会话**的浏览器收掉：引擎 `start()` 头一行是
     * 「已经有 browser 就直接返回」，不收的话面板里还是旧浏览器 / 旧来源，看起来像
     * 「设置没生效」。按会话只收它自己那份，别的会话不受影响；下次导航 / 工具调用会按
     * 新偏好重建（renderer 的 `BrowserPane` 也会重连）。
     */
    if (body.browserSettings !== undefined) {
      await browserSessions
        .close(agentBrowserSessionId(id), '浏览器偏好已改')
        .catch(() => undefined)
    }
    return new Response(null, { status: 204 })
  } catch (err) {
    const { status, message } = describeError(err)
    return jsonError(status, message)
  }
}
