/**
 * 会话累计用量的纯计算（渲染端要用，所以放 shared 而不是主进程的 ai/ 下）。
 *
 * 为什么**现算**而不是在会话上另存一个累计字段：
 * - 压缩上下文**不改历史**（见 main/services/ai/context.ts），屏幕上的消息数组永远是原文，
 *   累计值随时能从它重新算出来；
 * - 另存累计值就多出一个可能与消息对不上的副本（漏算一轮、删消息后忘了同步），
 *   而「累计 token」本身没有不可重算的状态。
 */
import type { AgentConversation, ConversationUsage } from '@shared/types'

/**
 * 把各轮的 `TurnUsage` 累加成会话累计。
 *
 * 与单轮 `TurnUsage` 的差别：**没有耗时 / TPS** —— 那两个是单轮指标，跨轮累计没有意义
 * （总耗时 ≠ 各轮耗时之和，各轮之间还有等审批的间隙）。
 *
 * `totalTokens` 按各轮**直接相加**，不拿 `input + output` 反推：部分 provider 上报的
 * totalTokens 含缓存命中等额外项，反推会与账单对不上。
 */
export function sumUsage(
  messages: ReadonlyArray<{ usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number; reasoningTokens?: number; cachedInputTokens?: number } | undefined }>
): ConversationUsage {
  let inputTokens = 0
  let outputTokens = 0
  let totalTokens = 0
  let reasoningTokens = 0
  let cachedInputTokens = 0
  for (const m of messages) {
    const u = m.usage
    if (!u) continue
    inputTokens += u.inputTokens ?? 0
    outputTokens += u.outputTokens ?? 0
    totalTokens += u.totalTokens ?? 0
    reasoningTokens += u.reasoningTokens ?? 0
    cachedInputTokens += u.cachedInputTokens ?? 0
  }
  return { inputTokens, outputTokens, totalTokens, reasoningTokens, cachedInputTokens }
}

// ---------- 跨会话用量统计（用量页用） ----------

/** 一天的量（本地时区；零填充，没有对话的那天也在数组里） */
export interface UsageDayBucket {
  /** 本地日期 `YYYY-MM-DD` */
  date: string
  /** 这一天的总 token（各轮 totalTokens 相加） */
  totalTokens: number
  /** 这一天跑了多少轮（有 usage 的助手消息条数） */
  turns: number
}

/** 一条会话的量（用量页的「最费 token 的会话」） */
export interface UsageConversationBucket {
  id: string
  title: string
  scope: 'workspace' | 'terminal'
  workspaceId?: string
  usage: ConversationUsage
  turns: number
  updatedAt: number
}

/** 一个模型的量（按会话的 `modelId ?? configId ?? 默认` 归组） */
export interface UsageModelBucket {
  /** 归组键（原始 modelId / configId / ''），展示名由调用方解析 */
  key: string
  usage: ConversationUsage
  turns: number
}

export interface UsageReport {
  totals: ConversationUsage
  /** 有 usage 记录的轮数（不是消息条数） */
  turns: number
  /** 参与统计的会话数（只算真跑过的，空会话不进） */
  conversationCount: number
  /** 最近 N 天，**从早到晚**排列且零填充 */
  byDay: UsageDayBucket[]
  /** 最费 token 的会话（降序，取前若干条） */
  topConversations: UsageConversationBucket[]
  /** 按模型归组（降序） */
  byModel: UsageModelBucket[]
}

/** 本地时区的 `YYYY-MM-DD`（不能用 toISOString —— 那是 UTC，跨零点会归错天） */
function localDayKey(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

const EMPTY_USAGE: ConversationUsage = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  reasoningTokens: 0,
  cachedInputTokens: 0
}

function addUsage(a: ConversationUsage, b: ConversationUsage): ConversationUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    totalTokens: a.totalTokens + b.totalTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens
  }
}

/**
 * 把多条会话聚合成用量报告（**纯函数**，无 React / store 依赖，可单独跑真源码验证）。
 *
 * 为什么在主进程之外算：数据全在渲染端的 `agentConversations` / `terminalConversations`
 * 里（消息随会话一起来），另开一条 IPC 通道去主进程重算一遍纯属多此一举，
 * 而且主进程那份还可能在流式中途、比屏幕上的旧。
 *
 * ⚠️ **ACP 会话天然没有用量**：它的消息归外部 agent 管，本地 `messages` 恒为空
 * （见 AgentConversation 的注释），所以它不会出现在任何统计里 —— 这是事实，不是漏算。
 * 界面上要说明这一点，否则用户会以为统计坏了。
 *
 * @param conversations 工作区会话 + 终端会话（调用方合并后传入）
 * @param opts.days 按天统计的窗口（含今天），默认 14
 * @param opts.topN 「最费 token 的会话」条数，默认 8
 */
export function buildUsageReport(
  conversations: ReadonlyArray<AgentConversation>,
  opts?: { days?: number; topN?: number }
): UsageReport {
  const days = Math.max(1, opts?.days ?? 14)
  const topN = Math.max(1, opts?.topN ?? 8)

  /** 日期 → 桶（先建好零填充的骨架，保证没有对话的那天也在图上） */
  const dayMap = new Map<string, UsageDayBucket>()
  const today = new Date()
  const keys: string[] = []
  for (let i = days - 1; i >= 0; i -= 1) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i)
    const key = localDayKey(d.getTime())
    keys.push(key)
    dayMap.set(key, { date: key, totalTokens: 0, turns: 0 })
  }
  let totals = EMPTY_USAGE
  let turns = 0
  const perConversation: UsageConversationBucket[] = []
  const modelMap = new Map<string, UsageModelBucket>()

  for (const c of conversations) {
    const messages = c.messages ?? []
    let convTurns = 0
    let convUsage = EMPTY_USAGE
    for (const m of messages) {
      const u = m.usage
      if (!u) continue
      convTurns += 1
      const one: ConversationUsage = {
        inputTokens: u.inputTokens ?? 0,
        outputTokens: u.outputTokens ?? 0,
        totalTokens: u.totalTokens ?? 0,
        reasoningTokens: u.reasoningTokens ?? 0,
        cachedInputTokens: u.cachedInputTokens ?? 0
      }
      convUsage = addUsage(convUsage, one)
      totals = addUsage(totals, one)
      turns += 1
      // 按天：只统计窗口内的（窗口外的不进图，但仍进总计 —— 总计是「全部」，
      // 图是「最近 N 天」，两者口径不同，界面上要写清）。
      // dayMap 里只有窗口内的键，取不到就说明这天在窗口外，直接跳过。
      const bucket = dayMap.get(localDayKey(m.createdAt))
      if (bucket) {
        bucket.totalTokens += one.totalTokens
        bucket.turns += 1
      }
    }
    if (convTurns === 0) continue
    perConversation.push({
      id: c.id,
      title: c.title,
      scope: c.scope === 'terminal' ? 'terminal' : 'workspace',
      workspaceId: c.workspaceId,
      usage: convUsage,
      turns: convTurns,
      updatedAt: c.updatedAt
    })
    const modelKey = c.modelId ?? c.configId ?? ''
    const existing = modelMap.get(modelKey)
    if (existing) {
      existing.usage = addUsage(existing.usage, convUsage)
      existing.turns += convTurns
    } else {
      modelMap.set(modelKey, { key: modelKey, usage: convUsage, turns: convTurns })
    }
  }

  return {
    totals,
    turns,
    conversationCount: perConversation.length,
    byDay: keys.map((k) => dayMap.get(k)!),
    topConversations: perConversation
      .sort((a, b) => b.usage.totalTokens - a.usage.totalTokens)
      .slice(0, topN),
    byModel: [...modelMap.values()].sort((a, b) => b.usage.totalTokens - a.usage.totalTokens)
  }
}

/** 大数字的可读化：1234 → `1.2k`，1234567 → `1.23M`（用量页的紧凑展示） */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n)) return '0'
  const abs = Math.abs(n)
  if (abs < 1000) return String(Math.round(n))
  if (abs < 1_000_000) return `${(n / 1000).toFixed(abs < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(2)}M`
}