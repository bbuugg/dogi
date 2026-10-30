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

/**
 * 落盘前把「还没结束」的子任务记录收敛成 `aborted`。
 *
 * 正常运行一定以 `subagent-end` 收尾（`subagents.ts` 里每条提前返回的路都调了 `finish`）；
 * 但进程被杀 / 服务端重启 / 看门狗强杀时那一帧根本没机会发出去，`status: 'running'` 会被
 * 原样写进历史 —— 之后每次打开这条会话，派活卡上都挂着一句「运行中…」，永远等不到结果。
 *
 * 落盘这一刻它就是不跑了：`aborted` 才是真话。
 */
function settleDelegations(
  parts: AgentChatMessage['parts'],
  now: number
): AgentChatMessage['parts'] {
  // 没有「还没结束」的记录就原样返回（同一引用）：绝大多数轮次没派活，不该白拷一份数组
  const hasRunning = parts.some(
    (part) => part.type === 'tool-call' && part.delegation?.status === 'running'
  )
  if (!hasRunning) return parts
  return parts.map((part) => {
    if (part.type !== 'tool-call' || part.delegation?.status !== 'running') return part
    return {
      ...part,
      delegation: {
        ...part.delegation,
        status: 'aborted' as const,
        endedAt: part.delegation.endedAt ?? now
      }
    }
  })
}

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
    // 子任务记录在这里收敛（见 settleDelegations）：落盘 = 这一轮结束了
    parts: settleDelegations(input.parts, now),
    createdAt: now,
    ...(input.usage
      ? { usage: input.usage }
      : input.durationMs != null
        ? { durationMs: input.durationMs }
        : {})
  }
}
