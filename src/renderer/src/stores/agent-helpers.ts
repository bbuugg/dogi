/**
 * Agent / AI 会话的纯函数。
 *
 * 会话的 CRUD / 落盘 / 流式 part 追加等逻辑从 `app-store.ts` 抽出，
 * 减小主文件体积。这些函数不依赖 `set`/`get`，可被各 slice 复用。
 */
import { useAppStore } from './app-store'
import { isDraftConversation } from './types'
import type {
  AgentChatMessage,
  AgentConversation,
  AgentStreamEvent,
  AiMessagePart,
  AiStreamEvent
} from '@shared/types'

/** requestId -> sessionId：把流式事件路由到发起对话的那个会话 */
export const aiRequestSessions = new Map<string, string>()

/** requestId -> conversationId：把 Agent 流式事件路由到发起对话的那个会话 */
export const agentRequestConversations = new Map<string, string>()

/** 会话默认标题（用户没命名、也没发过消息时显示） */
export const DEFAULT_CONVERSATION_TITLE = '新会话'

/** 由首条用户消息生成会话标题：取首行、截断到 30 字 */
export function titleFromMessage(text: string): string {
  const firstLine = text.split('\n')[0].trim()
  if (!firstLine) return DEFAULT_CONVERSATION_TITLE
  return firstLine.length > 30 ? `${firstLine.slice(0, 30)}…` : firstLine
}

/**
 * 新建一个「草稿」会话（= 当前工作区的新建会话页；**形态待定**、**不出现在会话列表里**）。
 *
 * ⚠️ 这里**刻意不写 `kind`**：会话形态由**首条消息时选中的模型**决定 ——
 * 选了某个 ACP agent 的模型就是 `acp`，选了内置模型就是 `mastra`
 * （见 AgentSlice.sendAgentMessage）。`!kind` 同时就是「草稿」的判据
 * （`isDraftConversation`）：侧边栏不列它，发出首条消息那一刻才转正并落盘；
 * 在此之前它只活在内存里 —— 一旦落盘，storage 的兜底会把缺省形态当成 `mastra`。
 */
export function newConversation(workspaceId: string): AgentConversation {
  const now = Date.now()
  return {
    id: crypto.randomUUID(),
    workspaceId,
    title: DEFAULT_CONVERSATION_TITLE,
    messages: [],
    createdAt: now,
    updatedAt: now
  }
}

/**
 * 取某工作区最近更新的会话（没有则 null）。
 *
 * ⚠️ **草稿（还没发出首条消息的那些）不能盖过真正的会话**：点「新建会话」后随手切走再切回来，
 * 应该回到你原来在用的那条会话，而不是那个一个字都没写过的空页。一条真会话都没有时才用草稿兜底
 * （那时它就是「这个工作区当前的那个新会话页」）。
 */
export function latestConversation(
  conversations: AgentConversation[],
  workspaceId: string
): AgentConversation | null {
  let best: AgentConversation | null = null
  let draft: AgentConversation | null = null
  for (const c of conversations) {
    if (c.workspaceId !== workspaceId) continue
    if (isDraftConversation(c)) {
      if (!draft || c.updatedAt > draft.updatedAt) draft = c
      continue
    }
    if (!best || c.updatedAt > best.updatedAt) best = c
  }
  return best ?? draft
}

/**
 * 选中某工作区要展示的会话：优先最近更新的那个，一个都没有就现建一个空会话 ——
 * 保证「点开工作区就能直接输入」，不用先手动新建。
 */
export function ensureConversation(
  conversations: AgentConversation[],
  workspaceId: string
): { conversations: AgentConversation[]; activeId: string | null } {
  if (!workspaceId) return { conversations, activeId: null }
  const latest = latestConversation(conversations, workspaceId)
  if (latest) return { conversations, activeId: latest.id }
  const created = newConversation(workspaceId)
  return { conversations: [...conversations, created], activeId: created.id }
}

/**
 * 修改某个会话（浅合并）。
 *
 * `bumpUpdatedAt` 控制是否把 updatedAt 推到当前时刻：**默认 true**（发消息、改名、删消息等
 * 低频用户操作都该让它跳到列表最前）。流式输出每个 token 也会走这里追加 part —— 那种高频路径
 * 必须传 false，否则 updatedAt 每帧都变，会话列表（按 updatedAt 降序）会被持续重排、闪烁。
 */
export function patchConversation(
  conversations: AgentConversation[],
  id: string,
  patch: Partial<AgentConversation>,
  bumpUpdatedAt = true
): AgentConversation[] {
  return conversations.map((c) =>
    c.id === id ? { ...c, ...patch, updatedAt: bumpUpdatedAt ? Date.now() : c.updatedAt } : c
  )
}

/**
 * 流式期间的**增量落盘**节流表（key = conversationId）。
 *
 * 一轮 Agent 对话可能跑几十步、持续很久；此前只在「发消息」与「轮末」落盘，
 * 中途关掉应用这一轮的全部产出（工具结果、已生成的正文）都会丢 —— 用户实测踩到过。
 * 这里按固定间隔节流写盘：最多丢最后几秒，又不会每个 token 都序列化整段历史。
 */
const AGENT_PERSIST_INTERVAL = 3000
const agentPersistAt = new Map<string, number>()

/**
 * 落盘前把**只喂渲染**的字段摘掉：目前只有 `inputText`（入参流式生成期攒的半截 JSON）。
 *
 * 它不属于历史 —— 完整 `tool-call` 一到就该作废（见 appendAgentPart 的收口），但流式期间
 * 每 3 秒会增量落盘一次（`persistConversationThrottled`），正好卡在生成中途时会把半截 JSON
 * 写进盘里。重新打开会话时那张卡会永远停在「正在生成…」，所以这里再拦一道。
 *
 * 返回的是**新对象**（不改内存里的 part：屏幕上那份还要继续吃增量）。
 */
function stripTransientParts(messages: AgentChatMessage[]): AgentChatMessage[] {
  return messages.map((message) => ({
    ...message,
    parts: message.parts.map((part) =>
      part.type === 'tool-call' && part.inputText !== undefined
        ? { ...part, inputText: undefined }
        : part
    )
  }))
}

/**
 * 把会话当前内容写盘。
 *
 * 只写不读回：调用期间流式输出可能又追加了 part，用主进程的返回值覆盖本地会丢内容。
 */
export async function persistConversation(
  conversations: AgentConversation[],
  id: string
): Promise<void> {
  const conversation = conversations.find((c) => c.id === id)
  if (!conversation) return
  /**
   * ⚠️ **形态还没定的会话一律不落盘**（新建后还没发过消息的那些）。
   *
   * `kind` 由首条消息定型（见 4.3），而 storage 对缺省 `kind` 的兜底是 `mastra` ——
   * 提前落盘（改名、清空、切模型…都会走到这里）会把这条会话**永久锁成内置**：
   * 之后 `setAcpConversationModel` 会因「形态已定」直接忽略，用户再也选不了 ACP 模型。
   * 这是唯一的守卫点，别在调用方各写一份。
   */
  if (!conversation.kind) return
  await window.api.agent.saveConversation({
    id: conversation.id,
    workspaceId: conversation.workspaceId,
    // 会话形态固定，落盘时一起带上（ACP 会话的消息由 agent 自己管理，不发 messages）
    kind: conversation.kind,
    title: conversation.title,
    ...(conversation.kind === 'acp' ? {} : { messages: stripTransientParts(conversation.messages) }),
    configId: conversation.configId,
    // ⚠️ 必须一起落盘：只存 configId 的话，会话选的具体模型重启后会回退成配置默认模型
    modelId: conversation.modelId,
    // ACP 会话的绑定关系（agent 配置 id + agent 侧会话 id），落盘后重启仍能接回同一条会话
    acpAgentId: conversation.acpAgentId,
    acpSessionId: conversation.acpSessionId
  })
}

export function persistConversationThrottled(id: string): void {
  const now = Date.now()
  if (now - (agentPersistAt.get(id) ?? 0) < AGENT_PERSIST_INTERVAL) return
  agentPersistAt.set(id, now)
  void persistConversation(useAppStore.getState().agentConversations, id)
}

/** 通知正文的长度上限（系统通知里放一两行就够，长了会被截断） */
const NOTICE_SNIPPET_CHARS = 120

/**
 * Agent 一轮对话结束时发系统通知。
 *
 * 这里只负责**凑内容**（会话标题 + 回复开头或报错），「应用在不在前台」「用户有没有
 * 关掉通知」都由主进程判定（见 services/system/notify.ts / ipc/system.ts）——
 * 渲染端拿不到窗口的真实可见性（隐藏到托盘时 `document.hasFocus()` 不足以判断）。
 * 用户主动中止的那一轮不发（人就在跟前）。
 */
export function notifyAgentFinished(conversationId: string, finishReason: string): void {
  if (finishReason === 'aborted') return
  const state = useAppStore.getState()
  const conversation = state.agentConversations.find((c) => c.id === conversationId)
  if (!conversation) return
  const workspace = state.agentWorkspaces.find((w) => w.id === conversation.workspaceId)

  // ACP 会话的消息在本地镜像里（`messages` 恒为空 —— 那些消息归 agent 自己管）
  const messages =
    conversation.kind === 'acp'
      ? (state.agentAcpMessages[conversationId] ?? [])
      : conversation.messages
  const last = messages[messages.length - 1]
  const reply =
    last?.role === 'assistant'
      ? last.parts
        .map((p) => (p.type === 'text' ? p.text : ''))
        .join('')
        .replace(/\s+/g, ' ')
        .trim()
      : ''
  const snippet =
    reply.length > NOTICE_SNIPPET_CHARS ? `${reply.slice(0, NOTICE_SNIPPET_CHARS)}…` : reply
  const failed = finishReason === 'error'

  void window.api.app.notify({
    title: `${failed ? 'Agent 执行出错' : 'Agent 已完成'} · ${conversation.title}`,
    body: snippet || `${workspace?.name ?? '工作区'} 的会话已结束`
  })
}

/**
 * 把一次流式失败落成「可替换」的文本 part。
 *
 * 模型级重试（见 `AiSettings.maxRetries`）**每次尝试失败都会发一个 error 事件**，
 * 而 error 事件是往消息尾部 **push** 的 —— 直接追加会让同一轮里堆出 N 段几乎一样的
 * `⚠️ …` 文案。所以这里带 `error: true` 标记：
 * - 后到的错误**替换**前一个（同一轮只留最后一条失败原因）；
 * - `text-delta` 不再往这段文本上合并（否则重试成功后正文被接在错误文案后面）。
 */
type ErrorAwarePart = { type: string; text?: string; error?: true }

/** 末尾是错误文案时返回 false —— 正文增量不能合并进它 */
function canAppendText(part: ErrorAwarePart | undefined): part is { type: 'text'; text: string } {
  return part?.type === 'text' && !part.error
}

/** 末尾是错误文案时返回它（供 pushErrorPart 替换），否则 undefined */
function errorPartAt<T extends ErrorAwarePart>(parts: T[]): T | undefined {
  const last = parts[parts.length - 1]
  return last?.type === 'text' && last.error ? last : undefined
}

/** Agent 回复生成中的占位 assistant 消息尾部追加 part */
export function appendAgentPart(parts: AgentChatMessage['parts'], event: AgentStreamEvent) {
  const next = [...parts]
  if (event.type === 'text-delta') {
    const last = next[next.length - 1]
    if (canAppendText(last)) {
      next[next.length - 1] = { type: 'text', text: last.text + event.delta }
    } else {
      next.push({ type: 'text', text: event.delta })
    }
  } else if (event.type === 'reasoning-delta') {
    const last = next[next.length - 1]
    if (last?.type === 'reasoning') {
      next[next.length - 1] = { type: 'reasoning', text: last.text + event.delta }
    } else {
      next.push({ type: 'reasoning', text: event.delta })
    }
  } else if (event.type === 'tool-call-delta') {
    // 入参还在生成：卡片先建出来（工具名可能还没给），半截 JSON 持续往里攒。
    // 完整 tool-call 到达时用 input 覆盖并丢掉 inputText（见下面的收口）。
    const index = next.findIndex(
      (p) => p.type === 'tool-call' && p.toolCallId === event.toolCallId
    )
    if (index < 0) {
      next.push({
        type: 'tool-call',
        toolCallId: event.toolCallId,
        // 增量帧常常没带工具名（有的上游只在完整 tool-call 里给）：先落空串，
        // 标题由 toolCardTitle 兜底成「工具调用」，后到的真名再补上
        toolName: event.toolName ?? '',
        input: null,
        inputText: event.inputTextDelta
      })
    } else {
      const call = next[index] as Extract<AgentChatMessage['parts'][number], { type: 'tool-call' }>
      next[index] = {
        ...call,
        toolName: call.toolName || (event.toolName ?? ''),
        inputText: (call.inputText ?? '') + event.inputTextDelta
      }
    }
  } else if (event.type === 'tool-call') {
    // 同一个 toolCallId 可能**先来过一串入参增量**（上面那张半截卡片）：按 id 收口，
    // 别再推第二张卡 —— 否则界面上会出现两张卡，一张永远停在「正在生成…」。
    // 收口 = 用完整 input 覆盖、并把 inputText 摘掉（它只喂渲染，不进历史）。
    const index = next.findIndex(
      (p) => p.type === 'tool-call' && p.toolCallId === event.toolCallId
    )
    const existing =
      index < 0
        ? undefined
        : (next[index] as Extract<AgentChatMessage['parts'][number], { type: 'tool-call' }>)
    if (existing) {
      next[index] = {
        type: 'tool-call',
        toolCallId: existing.toolCallId,
        // 半截卡片可能还没拿到工具名（空串）：真名到了就补上
        toolName: existing.toolName || event.toolName,
        input: event.input,
        ...(event.title || existing.title ? { title: event.title ?? existing.title } : {}),
        ...(event.acpKind || existing.acpKind
          ? { acpKind: event.acpKind ?? existing.acpKind }
          : {})
      }
    } else {
      next.push({
        type: 'tool-call',
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        input: event.input,
        ...(event.title ? { title: event.title } : {}),
        ...(event.acpKind ? { acpKind: event.acpKind } : {})
      })
    }
  } else if (event.type === 'tool-result') {
    next.push({
      type: 'tool-result',
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      output: event.output,
      isError: event.isError
    })
  } else if (event.type === 'retry') {
    // 重试是「通知」不是内容：不建 part —— 界面在气泡的「正在生成」位置显示「第 N 次重试」
    // （清空半截输出 + 记录 retrying 由 app-store 的 retry 分支做）
  } else if (event.type === 'error') {
    const part = { type: 'text', text: `⚠️ ${event.message}`, error: true } as const
    const at = errorPartAt(next)
    if (at !== undefined) next[next.length - 1] = part
    else next.push(part)
  }
  return next
}

/** AI 回复生成中的占位 assistant 消息尾部追加 part */
export function appendAssistantPart(
  parts: AiMessagePart[],
  event: AiStreamEvent
): AiMessagePart[] {
  const next = [...parts]
  if (event.type === 'text-delta') {
    const last = next[next.length - 1]
    if (canAppendText(last)) {
      next[next.length - 1] = { type: 'text', text: last.text + event.delta }
    } else {
      next.push({ type: 'text', text: event.delta })
    }
  } else if (event.type === 'reasoning-delta') {
    const last = next[next.length - 1]
    if (last?.type === 'reasoning') {
      next[next.length - 1] = { type: 'reasoning', text: last.text + event.delta }
    } else {
      next.push({ type: 'reasoning', text: event.delta })
    }
  } else if (event.type === 'tool-call-delta') {
    // 入参还在生成：卡片先建出来（工具名可能还没给），半截 JSON 持续往里攒。
    // 完整 tool-call 到达时用 input 覆盖并丢掉 inputText（见下面的收口）。
    const index = next.findIndex(
      (p) => p.type === 'tool-call' && p.toolCallId === event.toolCallId
    )
    if (index < 0) {
      next.push({
        type: 'tool-call',
        toolCallId: event.toolCallId,
        // 增量帧常常没带工具名（有的上游只在完整 tool-call 里给）：先落空串，
        // 标题由 toolCardTitle 兜底成「工具调用」，后到的真名再补上
        toolName: event.toolName ?? '',
        input: null,
        inputText: event.inputTextDelta
      })
    } else {
      const call = next[index] as Extract<AiMessagePart, { type: 'tool-call' }>
      next[index] = {
        ...call,
        toolName: call.toolName || (event.toolName ?? ''),
        inputText: (call.inputText ?? '') + event.inputTextDelta
      }
    }
  } else if (event.type === 'tool-call') {
    // 同一个 toolCallId 可能**先来过一串入参增量**（上面那张半截卡片）：按 id 收口，
    // 别再推第二张卡（理由见 appendAgentPart 的同名分支）。
    const index = next.findIndex(
      (p) => p.type === 'tool-call' && p.toolCallId === event.toolCallId
    )
    const existing =
      index < 0 ? undefined : (next[index] as Extract<AiMessagePart, { type: 'tool-call' }>)
    if (existing) {
      next[index] = {
        type: 'tool-call',
        toolCallId: existing.toolCallId,
        toolName: existing.toolName || event.toolName,
        input: event.input,
        ...(event.title || existing.title ? { title: event.title ?? existing.title } : {}),
        ...(event.acpKind || existing.acpKind
          ? { acpKind: event.acpKind ?? existing.acpKind }
          : {})
      }
    } else {
      next.push({
        type: 'tool-call',
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        input: event.input,
        ...(event.title ? { title: event.title } : {}),
        ...(event.acpKind ? { acpKind: event.acpKind } : {})
      })
    }
  } else if (event.type === 'tool-result') {
    next.push({
      type: 'tool-result',
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      output: event.output,
      isError: event.isError
    })
  } else if (event.type === 'retry') {
    // 重试是「通知」不是内容：不建 part（界面在气泡的「正在生成」位置显示「第 N 次重试」）
  } else if (event.type === 'error') {
    // ⚠️ 前面留两个换行：终端助手是单行气泡里的 markdown，与正文同段会糊在一起
    const part = { type: 'text', text: `\n\n⚠️ ${event.message}`, error: true } as const
    const at = errorPartAt(next)
    if (at !== undefined) next[next.length - 1] = part
    else next.push(part)
  }
  return next
}
