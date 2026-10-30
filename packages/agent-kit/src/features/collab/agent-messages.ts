/**
 * 协作子 Agent 的「对话形状」：把一个 Agent 的任务流水翻成消息数组。
 *
 * 子 Agent **没有自己的会话记录** —— 它每被派一次活就是一个任务（prompt 进、output/error 出），
 * 所以一轮 = 一问一答两条消息。翻出来的东西直接喂给主会话那套 `MessageList`，气泡 / 代码块 /
 * 工具卡 / 滚动跟随全部复用，用户的观感才和普通会话一致。
 *
 * 抽成模块（而不是留在 `CollabWorkspace.tsx` 里）的两个理由：
 *
 * 1. 消息本体在**右侧对话区**里渲染（`CollabAgentChatPanel`），画布只管配置与可视化 ——
 *    画布不该为了一处文案去 import `AgentChatMessage`；
 * 2. 下面的空值常量与 `STATUS_META` 必须是**模块级稳定引用**：它们会进 `useNodesState` 的
 *    同步 effect 依赖，`?? {}` / `?? []` 每次渲染都是新引用 → setNodes → 重渲染 → 再 setNodes，
 *    最终触发 React #185（Maximum update depth exceeded，真踩过）。
 */
import { toolLabel } from '@fizz/agent-kit/shared/lib/parts'
import type { AgentChatMessage } from '@fizz/contracts/agent-api'
import type {
  AgentMessagePart,
  CollabAgentRuntime,
  CollabAgentStatus,
  CollabMessage,
  CollabTask
} from '@fizz/contracts/types'

/** 运行态还没回来时的空表（模块级常量，见文件头第 2 条） */
export const EMPTY_STATUSES: Record<string, CollabAgentRuntime> = {}
export const EMPTY_TASKS: CollabTask[] = []
export const EMPTY_MESSAGES: CollabMessage[] = []
export const EMPTY_LIVE_TEXT: Record<string, string> = {}
export const EMPTY_LIVE_PARTS: Record<string, AgentMessagePart[]> = {}

/** 状态点 / 文案的配色（节点、列表卡片、标签页头部共用一套观感） */
export const STATUS_META: Record<
  CollabAgentStatus,
  { label: string; dot: string; text: string }
> = {
  idle: { label: '空闲', dot: 'bg-muted-foreground/40', text: 'text-muted-foreground' },
  queued: { label: '排队', dot: 'bg-amber-500', text: 'text-amber-600 dark:text-amber-400' },
  running: {
    label: '运行中',
    dot: 'bg-emerald-500 animate-pulse',
    text: 'text-emerald-600 dark:text-emerald-400'
  },
  waiting: { label: '等回答', dot: 'bg-sky-500', text: 'text-sky-600 dark:text-sky-400' },
  done: { label: '完成', dot: 'bg-emerald-500', text: 'text-emerald-600 dark:text-emerald-400' },
  error: { label: '出错', dot: 'bg-destructive', text: 'text-destructive' },
  cancelled: { label: '已取消', dot: 'bg-muted-foreground/40', text: 'text-muted-foreground' }
}

/** 流式文本里可能混着模型原样吐出的工具调用标记；界面上只展示「做了什么」 */
export function displayLiveText(text: string): string {
  return text
    .replace(
      /<invoke\b[^>]*\bname\s*=\s*["']([^"']+)["'][^>]*>[\s\S]*?<\/invoke>/gi,
      (_match, name: string) => `[${toolLabel(name)}]`
    )
    .replace(
      /<invoke\b[^>]*\bname\s*=\s*["']([^"']+)["'][^>]*>[\s\S]*$/i,
      (_match, name: string) => `[${toolLabel(name)}]`
    )
    .replace(/<\/?invoke\b[^>]*>/gi, '')
    .replace(/<parameter\b[^>]*>|<\/parameter>/gi, '')
    .trim()
}

/**
 * 任务流水 → 消息列表。
 *
 * 正在跑的那轮把流式文本接在助手消息里；还没有任何输出时给一条 `parts: []` 的助手消息
 * （`MessageParts` 见到空 parts 会渲染「正在思考…」）。
 */
export function agentChatMessages(
  tasks: readonly CollabTask[],
  live?: string,
  liveParts?: readonly AgentMessagePart[]
): AgentChatMessage[] {
  const out: AgentChatMessage[] = []
  for (const task of tasks) {
    out.push({
      id: `${task.id}:ask`,
      role: 'user',
      createdAt: task.createdAt,
      // 主智能体补的上下文拼在 prompt 前面（服务端派活时也是这么拼的，见 CollabRuntime）
      parts: [
        { type: 'text', text: task.context ? `${task.context}\n\n${task.prompt}` : task.prompt }
      ]
    })
    const running = task.status === 'running' || task.status === 'queued'
    const body = running
      ? displayLiveText(live ?? '')
      : task.status === 'error'
        ? (task.error ?? '')
        : (task.output ?? '')
    /**
     * 跑完的任务优先用**过程记录**（思考 / 工具调用 / 正文，与主消息的 parts 同构），
     * 这样右侧面板里也是折叠条 + 工具卡，跟主会话一个观感。
     *
     * 只认 `done`：
     * - `running` / `queued` 时 `parts` 还没收口，正文只能靠流式的 `live`；
     * - 出错任务的 `parts` 里**没有**那条错误文本（错误是独立字段），用它渲染会把
     *   「为什么失败」吞掉 —— 宁可退回纯文本。
     */
    /**
     * 运行中的**实时过程记录**：只有当里面已经有工具卡时才用它，让卡片边跑边出现。
     *
     * 没有工具事件时仍走 `live` 纯文本：那条路径会过 `displayLiveText`，把某些模型
     * 原样吐出的 `<invoke>` 标记洗成「[工具名]」。而 `liveParts` 里的文本是原始增量，
     * 不洗就会把标记原样糊在气泡里。
     */
    const liveToolParts =
      running && liveParts?.some((part) => part.type === 'tool-call') ? liveParts : undefined
    const parts: AgentChatMessage['parts'] = liveToolParts
      ? [...liveToolParts]
      : !running && task.status === 'done' && task.parts?.length
        ? task.parts
        : body
          ? [{ type: 'text', text: body }]
          : []
    // 跑着的任务即使还没有输出也要占一条助手消息：空 parts 才会渲染「正在思考…」
    if (running || parts.length) {
      out.push({
        id: `${task.id}:reply`,
        role: 'assistant',
        createdAt: task.finishedAt ?? task.startedAt ?? task.createdAt,
        parts
      })
    }
  }
  return out
}

/** 一个子 Agent 的消息流 + 「这一轮还在跑吗」 */
export interface CollabAgentChat {
  messages: AgentChatMessage[]
  /** 末个任务还没落地 = 这一轮还在跑：消息列表据此做平滑跟随、末条不出操作行 */
  streaming: boolean
}

/**
 * 某个子 Agent 的完整对话现场。
 *
 * ⚠️ 用 `agentId` 而不是「收发的消息」（`CollabMessage`）：`delegate` 那条的正文就是 prompt、
 * `result` 那条是摘要，用任务拼出来的「问 + 答」才和主会话的对话结构对得上。
 */
export function collabAgentChat(
  tasks: readonly CollabTask[],
  liveText: Record<string, string>,
  agentId: string,
  liveParts: Record<string, AgentMessagePart[]> = EMPTY_LIVE_PARTS
): CollabAgentChat {
  const own = tasks
    .filter((task) => task.agentId === agentId)
    .sort((a, b) => a.createdAt - b.createdAt)
  const last = own[own.length - 1]
  return {
    messages: agentChatMessages(own, liveText[agentId], liveParts[agentId]),
    streaming: !!last && (last.status === 'running' || last.status === 'queued')
  }
}
