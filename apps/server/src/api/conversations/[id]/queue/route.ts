/**
 * 待发送队列：GET 读、PATCH **全量覆盖**（拖拽排序后写回）。
 *
 * 队列持久化在服务端，所以刷新 / 换设备都能续上，排序也跨端一致 —— 这是它存在
 * 的唯一理由（前端本来就有 localStorage 缓存，见 `lib/stores/slices/conversation.ts`）。
 *
 * PATCH 是整份覆盖而不是「加一条 / 删一条」：数组顺序就是发送顺序，拖拽排序后前端
 * 手上只有整个新清单，增量语义反而得让它自己算 diff。
 */
import type { ConversationQueueInput } from '@fizz/contracts/agent-api'
import { domain } from '@/lib/server/state'
import { describeError, jsonError, parseJsonBody } from '@/app/api/_lib/auth'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  try {
    return Response.json({ items: domain.getConversationQueue(id) })
  } catch (err) {
    const { status, message } = describeError(err)
    return jsonError(status, message)
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const body = await parseJsonBody<ConversationQueueInput>(request)
  if (!body || !Array.isArray(body.items)) return jsonError(400, '请求体不是合法 JSON')
  try {
    domain.setConversationQueue(id, body.items)
    // 与 /target 一致：成功只回 204（队列已经被调用方渲染着，回显一遍纯浪费）
    return new Response(null, { status: 204 })
  } catch (err) {
    const { status, message } = describeError(err)
    return jsonError(status, message)
  }
}
