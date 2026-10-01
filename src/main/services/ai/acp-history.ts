/**
 * ACP 历史回放装配器：把 `session/load` 回放出来的一串 `session/update` 拼成消息列表。
 *
 * 单独成模块（**不依赖 electron / storage**）：这段映射就是「导入的会话显示成什么样」的
 * 全部逻辑，抽出来才能不起 Electron 直接跑真源码验证（见 `scripts/verify-acp-history.ts`）。
 *
 * 分段依据是 `ContentChunk.messageId`（协议：messageId 一变就是新的一条消息）。
 * agent 不给 messageId 时退化成启发式：用户块单独成条，助手内容连续追加。
 *
 * ⚠️ **工具调用/结果没有 messageId**（`ToolCall` / `ToolCallUpdate` 里根本没这个字段），
 * 唯一的归属线索是 `toolCallId` —— 所以结果必须按 id 找**调用所在的那条消息**塞回去，
 * 不能一律塞给「当前消息」（见 `HistoryAssembler.pushTool` 里的说明）。
 */
import { randomUUID } from 'node:crypto'
import type { SessionUpdate } from '@agentclientprotocol/sdk'
import type { AgentChatMessage, AgentMessagePart } from '@shared/types'
import { acpToolKindOf, acpToolName, acpToolTitle } from '@shared/acp-tools'

/**
 * 工具调用卡片的展示名（工具名）。
 *
 * 口径严格对齐 fishwork `packages/acp/src/acp.ts` 的 `acpToolName`：
 * **只认协议里的 `name`，绝不拿 `title` 兜底**（`title` 可能是文件路经 / 整段命令，
 * 顶到标题上就是用户反馈的「工具名位置显示成文件路经」）。
 *
 * `name` 缺失时返回占位名 `tool` —— 这不是丢信息：中文工具名改由协议里的 **`kind`** 翻出来
 * （见 `acpToolKindOf` 与渲染端的 `toolCardTitle`），`title` 则作为「工具名后面的明细」透出。
 */
export function toolLabelOf(update: SessionUpdate): string {
  // 防御取值：`SessionUpdate` 是联合类型，只有 tool_call 那几支才有 name，
  // 直接 `update.name` 过不了类型（联合里存在没有该字段的分支）。
  return acpToolName((update as { name?: unknown }).name)
}

export class HistoryAssembler {
  private messages: AgentChatMessage[] = []
  private current: AgentChatMessage | null = null
  private currentMessageId: string | null = null

  /** 开一条新消息（用户 / 助手），后续 chunk 追加到它上 */
  private start(role: 'user' | 'assistant', messageId: string | null): AgentChatMessage {
    const message: AgentChatMessage = {
      id: `acp-h-${this.messages.length}-${randomUUID().slice(0, 8)}`,
      role,
      parts: [],
      createdAt: Date.now()
    }
    this.messages.push(message)
    this.current = message
    this.currentMessageId = messageId
    return message
  }

  /** 内容块（user_message_chunk / agent_message_chunk / agent_thought_chunk） */
  pushContent(update: SessionUpdate, role: 'user' | 'assistant', text: string): void {
    const messageId = (update as { messageId?: string | null }).messageId ?? null
    const sameMessage =
      this.current !== null && messageId !== null && this.currentMessageId === messageId
    const appendable =
      this.current !== null &&
      (sameMessage ||
        // 没有 messageId：同一角色的连续块视为同一条消息（用户消息常见单块）
        (messageId === null && this.current.role === role && role === 'assistant'))
    const message = appendable ? this.current! : this.start(role, messageId)
    if (role === 'user' || update.sessionUpdate === 'agent_message_chunk') {
      message.parts.push({ type: 'text', text })
    } else {
      message.parts.push({ type: 'reasoning', text })
    }
  }

  /**
   * 工具调用 / 工具结果。
   *
   * - **调用**：属于当前这条助手消息（刚发起的调用就在这一轮里）；
   * - **结果**：回到**调用所在的那条消息**（按 `toolCallId` 找），不是当前消息。
   *
   * ⚠️ 这里挂错消息的后果很直观（用户报告）：回放里「调用 → 结果」之间可能夹着**下一条消息
   * 的正文**（agent 按 `ContentChunk.messageId` 分段，而工具更新没有 messageId，
   * 所以结果常常落到已经开了新消息之后）。结果被塞进那条新消息、而它的调用在旧消息里，
   * 渲染端按 toolCallId 找不到对应调用，只能当成「孤儿结果」**补在末尾** ——
   * 看起来就是「正文说完后面莫名多出两条工具调用」，整条消息又因为末尾不是正文被折叠，
   * 于是正文也跟着被藏进折叠条里。按 id 找回调用消息就能配对。
   *
   * ⚠️ **一轮 = 一条助手消息，轮次边界只由用户消息界定**（见 `pushContent`：来一条
   * `user_message_chunk` 才开新的一轮）。这一轮里所有的思考 / 工具 / 正文都进同一条消息，
   * 渲染端 `findTailStart` 保留该轮末尾最后一段正文、把上面的过程折成**一个**条 ——
   * 与 fishwork 的 `TurnStepGroup` 完全一致。
   *
   * 早期版本在这里按 `hasFinishedTurn` 遇到新 `tool_call` 就强行拆新消息，本意是「没 messageId
   * 时找回多轮结构」，但实际上会把**同一轮内**的「工具→回答→工具→回答」拆成多条小消息，
   * 每条各带一个折叠条 —— 正是用户反馈的「折叠了很多个」。工具调用不是轮次边界，不能拿来切分。
   * 没有 messageId 且回放又不带用户消息时，多轮会糊成一条消息（降级成一个折叠条、
   * `findTailStart` 保留最后正文），这是拿不到边界时的最优解，不会比拆碎更糟。
   */
  pushTool(part: AgentMessagePart): void {
    // 工具结果按 toolCallId 回到调用所在的消息（避免孤儿结果）；调用与结果都归属当前这条
    // 助手消息（一轮 = 一条消息，由 user_message_chunk 边界切分）
    const owner =
      part.type === 'tool-result' ? this.findCallOwner(part.toolCallId) : null
    const message =
      owner ?? (this.current?.role === 'assistant' ? this.current : this.start('assistant', null))
    message.parts.push(part)
  }

  /** 找 `toolCallId` 那次调用所在的消息（从最新往前找；没有返回 null） */
  private findCallOwner(toolCallId: string): AgentChatMessage | null {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const message = this.messages[i]
      if (message.parts.some((p) => p.type === 'tool-call' && p.toolCallId === toolCallId)) {
        return message
      }
    }
    return null
  }

  /** 回放结束，取走结果 */
  finish(): AgentChatMessage[] {
    // 内容为空的消息（agent 只发了状态更新）没有展示价值，丢掉
    return this.messages.filter((m) => m.parts.length > 0)
  }
}

/**
 * 把回放中的一条更新餵给装配器。
 *
 * - `tool_call` 建调用卡（`rawInput` 当输入）；
 * - `tool_call_update` **只在 completed / failed 时**落一条结果卡（进行中的状态更新没有展示价值，
 *   而且每来一条就 push 一次会让同一张卡重复出现在消息里）。
 */
export function pushHistoryUpdate(assembler: HistoryAssembler, update: SessionUpdate): void {
  switch (update.sessionUpdate) {
    case 'user_message_chunk':
      if (update.content.type === 'text') {
        assembler.pushContent(update, 'user', update.content.text)
      }
      return
    case 'agent_message_chunk':
      if (update.content.type === 'text') {
        assembler.pushContent(update, 'assistant', update.content.text)
      }
      return
    case 'agent_thought_chunk':
      if (update.content.type === 'text') {
        assembler.pushContent(update, 'assistant', update.content.text)
      }
      return
    case 'tool_call':
      assembler.pushTool({
        type: 'tool-call',
        toolCallId: update.toolCallId,
        toolName: toolLabelOf(update),
        input: update.rawInput ?? {},
        // kind → 中文工具名（toolLabelOf 拿不到 name 时的唯一线索），title → 工具名后面的明细
        acpKind: acpToolKindOf(update),
        title: acpToolTitle(update.title)
      })
      return
    case 'tool_call_update':
      if (update.status !== 'completed' && update.status !== 'failed') return
      assembler.pushTool({
        type: 'tool-result',
        toolCallId: update.toolCallId,
        toolName: toolLabelOf(update),
        output: update.rawOutput ?? update.content ?? {},
        isError: update.status === 'failed'
      })
      return
    default:
      return
  }
}
