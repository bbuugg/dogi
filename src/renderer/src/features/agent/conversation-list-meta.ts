/**
 * Agent 会话**列表**的展示投影（纯函数，无 React / store 依赖，可单独跑真源码验证）。
 *
 * ## 为什么需要它
 *
 * `agentConversations` 里的每条会话都带着**完整消息历史**，而流式输出**每个 token**
 * 都会换掉 `messages` 数组 → 换掉承载它的会话对象 → 换掉整个 `agentConversations` 数组
 * （见 `patchConversation` 与 `handleAgentEvent`）。
 *
 * 侧边栏若直接 `useAppStore((s) => s.agentConversations)`，那么**每个 token 都要把整列
 * 会话行重渲染一遍** —— 现象就是「刚开始不卡、消息一多就卡」：既因为行数多，
 * 也因为每帧都要重扫一遍随消息增长的历史。
 *
 * ## 做法：订阅「列表可见字段」的投影 + 结构共享
 *
 * 列表行只需要 id / 归属 / 形态 / 标题 / 排序键。把它们投影出来，并在「可见字段没变」
 * 时**交出上一次那个数组（与条目对象）**，于是 zustand 的 `Object.is` 比较成立、
 * 根本不触发重渲染；只有增删会话、改名、转正（草稿→正式）、排序键变化才换引用。
 *
 * ⚠️ 别改成 `useShallow` 之类的浅比较：条目对象每帧都是新的，浅比较照样失败。
 * 也别在组件里 `useMemo(..., [s.agentConversations])` —— 依赖项本身就是每帧换的数组。
 *
 * 验证：`node --experimental-strip-types scripts/verify-agent-list-projection.ts`
 */
import type { AgentConversation } from '@shared/types'

/**
 * 会话**列表行**需要的全部字段（会话对象里除消息外的展示态）。
 *
 * `messages` / `configId` / `modelId` 一律不在其中：列表不读它们，
 * 带了就会让「换个模型」这种无关操作也重建整列。
 */
export interface ConversationListMeta {
  id: string
  workspaceId?: string
  /** 缺省 = 草稿（还没发出首条消息），据此过滤掉不出现在列表里的那些（isDraftConversation） */
  kind?: AgentConversation['kind']
  title: string
  /** 组内排序键（最近更新在最前） */
  updatedAt: number
  /** 已归档（列表把它收进工作区下的「已归档」分组，见 AgentPanel） */
  archived?: boolean
  /** 删除确认框要读 ACP 绑定（见 AgentPanel 的删除弹窗） */
  acpAgentId?: string
  acpSessionId?: string
}

function sameListMeta(a: ConversationListMeta, b: ConversationListMeta): boolean {
  return (
    a.id === b.id &&
    a.title === b.title &&
    a.updatedAt === b.updatedAt &&
    a.archived === b.archived &&
    a.kind === b.kind &&
    a.workspaceId === b.workspaceId &&
    a.acpAgentId === b.acpAgentId &&
    a.acpSessionId === b.acpSessionId
  )
}

/**
 * 投影缓存：**模块级单槽**（渲染进程里只有一个 store、一条列表）。
 *
 * 只记「上一次输入数组 → 上一次输出」，够用且不会无限增长；
 * 换掉缓存不改变语义（下次调用照样重新投影），因此不需要任何失效逻辑。
 */
let cache: { src: AgentConversation[]; out: ConversationListMeta[] } | null = null

/**
 * 把 `agentConversations` 投影成列表用的元数据数组，**带结构共享**。
 *
 * 用法：`useAppStore((s) => selectConversationListMeta(s.agentConversations))`。
 *
 * 代价：每次调用都要遍历一遍会话数组（O(会话数) 的字段比较），
 * 但换回的是「每个 token 一次都省掉」。会话数是几十的量级，这笔买卖非常划算。
 */
export function selectConversationListMeta(
  conversations: AgentConversation[]
): ConversationListMeta[] {
  const prev = cache
  // 同一个数组（store 没变）：直接交出上次结果，连遍历都省掉
  if (prev && prev.src === conversations) return prev.out

  const old = prev?.out
  let allReused = !!old && old.length === conversations.length
  const next = conversations.map((c, i) => {
    const meta: ConversationListMeta = {
      id: c.id,
      workspaceId: c.workspaceId,
      kind: c.kind,
      title: c.title,
      updatedAt: c.updatedAt,
      archived: c.archived,
      acpAgentId: c.acpAgentId,
      acpSessionId: c.acpSessionId
    }
    const reused = old?.[i]
    if (reused && sameListMeta(reused, meta)) return reused
    allReused = false
    return meta
  })

  // 可见字段全都没动（典型场景：只有 messages 变了）→ 连数组都复用，
  // 于是 Object.is 成立、订阅方不重渲染
  if (allReused && old) {
    cache = { src: conversations, out: old }
    return old
  }
  cache = { src: conversations, out: next }
  return next
}