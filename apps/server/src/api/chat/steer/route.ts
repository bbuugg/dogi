/**
 * 运行中插话（steer）：把一句话递给该会话正在跑的 run。
 * POST /api/chat/steer（body: SteerInput）
 *
 * 消息进 `run.steerInbox` 后，agent 循环在**下一个工具步骤边界**把它作为 user
 * 消息注入当前轮（见 packages/agent 的 `onIterationComplete`）—— 不等本轮结束。
 * 语义约定（spec §1.4/§1.5）：
 * - ACP 会话 → 400（外部 agent 的协议给不了步间注入）；
 * - 没有活跃 run → 409，客户端据此**回落普通发送**（空闲时插话 ≡ 发消息，零损失）；
 * - 消息一旦入箱就一定会被处理：边界消费（绝大多数）或收尾兜底起新一轮（撞
 *   maxSteps 预算 / 极窄竞态），abort 时清箱丢弃（用户意图是终止）。
 */
import {
  buildUserParts,
  type SteerInput,
  type SteerRemoveResult,
  type SteerReorderInput
} from '@fizz/contracts/agent-api'
import { resolveModelSettings, type AgentChatMessage } from '@fizz/contracts/types'
import { domain } from '@/lib/server/state'
import { findActiveByConversation } from '@/lib/server/chat-run'
import { validateUploadFiles } from '@/lib/server/upload/index'
import { jsonError, parseJsonBody } from '@/app/api/_lib/auth'

export async function POST(request: Request) {
  const body = await parseJsonBody<SteerInput>(request)
  if (!body?.conversationId || typeof body.text !== 'string') {
    return jsonError(400, '缺少 conversationId 或 text')
  }
  const text = body.text.trim()
  const files = body.files ?? []
  // 只带附件、不带文字的插话是合法的（与普通发送 / 队列同一口径）：两种内容都没有才拒
  if (!text && files.length === 0) return jsonError(400, '插话内容不能为空')

  // 附件校验**前置到会话查找之前**：坏引用（类型 / 归属不过）第一时间拒绝，
  // 不给「会话不存在 / 后端没选」之类更早的报错机会盖掉它，也防任意 URL 注进历史
  // （与 startTurn 同一条判据，见 upload 的 validateUploadFiles）
  const invalidFile = validateUploadFiles(files)
  if (invalidFile) return jsonError(400, invalidFile)

  const conversation = domain.getConversation(body.conversationId)
  if (!conversation) return jsonError(404, '会话不存在')
  if (conversation.backend === 'acp') {
    return jsonError(400, 'ACP 会话不支持插话（上下文在外部 agent 进程里）')
  }

  // 图片输入开关与 startTurn 同口径：关着的模型不收图片，当场说清楚而不是悄悄丢掉
  if (conversation.configId && conversation.modelId && files.some((f) => f.mediaType?.startsWith('image/'))) {
    try {
      const config = domain.resolveModelConfig(conversation.configId, conversation.modelId)
      if (!resolveModelSettings(config.models, config.model).imageInput) {
        return jsonError(
          400,
          `模型「${config.name}」没有开启图片输入：请移除图片，或到 设置 →「模型」里打开「图片输入」`
        )
      }
    } catch {
      // 配置 / 模型悬空由运行侧报错，这里不抢它的错误信息
    }
  }

  const run = findActiveByConversation(body.conversationId)
  if (!run || run.finishedAt !== undefined) {
    // 客户端约定：409 = 当普通消息发送（消息不离客户端，零损失）
    return jsonError(409, '当前没有运行中的任务')
  }

  const message: AgentChatMessage = {
    id: `u-${Date.now()}`,
    role: 'user',
    // 附件在前、文字在后 —— 与 startTurn 落盘的 user 消息同一份拼装（buildUserParts），
    // 客户端回显与模型看到的顺序才不会两样
    parts: buildUserParts(text, files),
    createdAt: Date.now()
  }
  run.steerInbox.push(message)
  return Response.json({ ok: true, message })
}

/**
 * 重排收件箱（拖拽 / ↑↓ 排序）：`ids` 是新顺序，**整份覆盖**语义 ——
 * 与队列的 `PATCH /api/conversations/:id/queue` 完全一致（数组顺序就是生效顺序）。
 *
 * 为什么要「按 id 重排」而不是「移动一条」：客户端手上就是完整一份顺序（拖拽是 hover
 * 即改，每次 hover 都会发一次），覆盖语义最直白、天然幂等，不必让两端对齐下标。
 *
 * ⚠️ 竞态：收件箱会被 agent 在工具步骤边界 `shift()` 消费。所以**只重排仍然存在的那些**：
 * 客户端提到的 id 里已消失的（刚被消费）直接跳过 —— 不复活；客户端没提到的（另一端的
 * 插话、或这中间刚到的）保持原有相对顺序接在后面 —— 不丢。
 */
export async function PATCH(request: Request) {
  const body = await parseJsonBody<SteerReorderInput>(request)
  if (!body?.conversationId || !Array.isArray(body.ids)) {
    return jsonError(400, '缺少 conversationId 或 ids')
  }
  const conversation = domain.getConversation(body.conversationId)
  if (!conversation) return jsonError(404, '会话不存在')
  const run = findActiveByConversation(body.conversationId)
  if (!run || run.finishedAt !== undefined) return jsonError(409, '当前没有运行中的任务')

  const byId = new Map(run.steerInbox.map((m) => [m.id, m]))
  const ordered: AgentChatMessage[] = []
  for (const id of body.ids) {
    const message = byId.get(id)
    if (!message) continue
    byId.delete(id)
    ordered.push(message)
  }
  // 落选的那些（客户端不知道的）按原顺序补齐
  for (const message of run.steerInbox) {
    if (!byId.has(message.id)) continue
    byId.delete(message.id)
    ordered.push(message)
  }
  run.steerInbox.splice(0, run.steerInbox.length, ...ordered)
  // 与队列一致：成功只回 204（客户端已经在按新顺序渲染，回显一遍纯浪费）
  return new Response(null, { status: 204 })
}

/**
 * 撤回一条还没生效的插话：从收件箱里摘掉（等价于用户反悔）。
 *
 * `removed: false` = 收件箱里已经没有它 —— agent 在边界消费掉了（马上就会以
 * `user-injected` 事件广播，客户端把「插入中」列表里这条换成会话里的真实消息）。
 * 消费后的插话是**落盘历史的一部分**，不再支持撤回（要改只能像普通消息一样
 * 删除后续重发）。
 */
export async function DELETE(request: Request) {
  const url = new URL(request.url)
  const conversationId = url.searchParams.get('conversationId')
  const messageId = url.searchParams.get('messageId')
  if (!conversationId || !messageId) return jsonError(400, '缺少 conversationId 或 messageId')
  const conversation = domain.getConversation(conversationId)
  if (!conversation) return jsonError(404, '会话不存在')
  const run = findActiveByConversation(conversationId)
  if (!run || run.finishedAt !== undefined) return jsonError(409, '当前没有运行中的任务')
  const index = run.steerInbox.findIndex((m) => m.id === messageId)
  const removed = index >= 0
  if (removed) run.steerInbox.splice(index, 1)
  const result: SteerRemoveResult = { ok: true, removed }
  return Response.json(result)
}
