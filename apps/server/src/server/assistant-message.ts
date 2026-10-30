/**
 * 拼一条要落盘的助手消息。
 *
 * 抽成纯函数是为了能测（`apps/server` 里带 `@/` 别名的模块进不了 vitest，
 * 见 `assistant-message.test.ts` 的文件头）。调用方是 `chat-turn.ts` 的
 * `persistAssistantMessage`。
 *
 * ## `usage` 与 `durationMs` 的互斥口径
 *
 * 折叠条抬头报「已工作 N 秒」读的是 `usage?.durationMs ?? message.durationMs`
 * （`packages/agent-kit/.../message-parts.tsx`）：
 *
 * - 内置后端**正常跑完** → `usage.durationMs`，`durationMs` 留空；
 * - 内置后端**被中止 / 出错** → 那一轮常常一个 usage chunk 都没收到（用户点停止时模型
 *   可能正卡在思考或工具执行里），`usage` 做不出来，只有 finish 帧单独给的 `durationMs`；
 * - **ACP** → 协议里没有 token 用量，全程只有 `durationMs`。
 *
 * 两个字段同时写会打架（两个数可能不一致），所以**有 `usage` 时不写 `durationMs`**。
 * 少了这条兜底，中止的轮次刷新后就只剩「思考 ×5 · 工具调用 ×5」的计数摘要。
 */
import type { AgentChatMessage, TurnUsage } from '@fizz/contracts/types'

export interface BuildAssistantMessageInput {
  /** 这一轮的正文 / 思考 / 工具过程（已按 fold 规则折好） */
  parts: AgentChatMessage['parts']
  /** 整轮 token 用量。中止 / 出错的轮次通常没有 */
  usage?: TurnUsage
  /**
   * 落盘用的 id。客户端给了就用它（见 `ChatRequest.assistantMessageId`）—— 收尾时客户端
   * 拿服务端权威历史覆盖本地现场，id 不变才不会把刚跑完这一轮的子树整棵重挂载。
   * 缺省（老客户端 / 插话兜底起的新一轮）才自生成。
   */
  id?: string
  /** 没有 `usage` 时的整轮耗时（毫秒） */
  durationMs?: number
  /** 落盘时间戳，缺省即当下（测试用） */
  now?: number
}

export function buildAssistantMessage(input: BuildAssistantMessageInput): AgentChatMessage {
  const now = input.now ?? Date.now()
  return {
    id: input.id ?? `a-${now}`,
    role: 'assistant',
    parts: input.parts,
    createdAt: now,
    ...(input.usage
      ? { usage: input.usage }
      : input.durationMs != null
        ? { durationMs: input.durationMs }
        : {})
  }
}
