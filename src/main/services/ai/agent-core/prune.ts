/**
 * 工具输出剪枝 —— 对齐 opencode 的上下文压缩 **Phase 1「Prune」**。
 *
 * opencode 的压缩是两段式：**先 Prune（把旧的 tool 输出删掉）、再 Summarize（把旧轮摘要掉）**。
 * 本项目此前只有第二段：每条工具结果截到 4000 字符，但**更旧的那些一条不删** ——
 * 一个读了十几轮文件的会话，历史里堆着的旧工具输出会随每一轮请求反复重发。
 * 这一层补的就是那个缺口。
 *
 * 与 opencode 的取舍一致：
 * - **保留最近的 `protectTokens` 个 token 的工具输出**（默认 40K）—— 越近的越可能还在被用；
 * - **省不到 `minTokens`（默认 20K）就不动手**：剪一两条没意义，还平白让模型重读；
 * - 少数工具**永不剪**（`read_skill` / `read_tool_output`）：技能正文是「按需加载的规则」，
 *   剪掉等于让模型重新读一遍；`read_tool_output` 的输出是产物续读的结果，剪它没有收益。
 *
 * ⚠️ 三条硬约束（改这个文件时别破坏）：
 * 1. **只改 `tool-result` 的 `output` 字段**，`toolCallId` / `toolName` 原样保留 ——
 *    assistant 里的 `tool-call` 必须能找到配对的结果，否则 provider 直接拒请求（见 6.6 第 23 条）；
 * 2. **不落盘、不改会话记录**：它只决定「这一次请求怎么带上下文」，屏幕上的历史始终是原文；
 * 3. **省不够就返回原引用**（零拷贝）：调用方据此判断「到底剪没剪」，别把没剪的也当成剪过。
 */
import type { ModelMessage, ToolResultPart } from 'ai'
import { estimateTokens } from '@shared/context-budget'

/**
 * 保留「最近的」这么多 token 的工具输出，更旧的换成占位符。
 *
 * 取 40K 与 opencode 的 `PRUNE_PROTECT` 同值。调用方会按模型上下文窗口缩放
 * （见 `agent.ts`）—— 32K 窗口的模型上保留 40K 工具输出是无意义的。
 */
export const PRUNE_PROTECT_TOKENS = 40_000

/** 至少省下这么多 token 才真的动手（opencode 的 `PRUNE_MINIMUM` 同值） */
export const PRUNE_MIN_TOKENS = 20_000

/**
 * 这些工具的输出**永不剪枝**。
 *
 * - `read_skill`：技能正文是「按需加载的规则」，剪掉会诱导模型重新读一遍（得不偿失）；
 * - `read_tool_output`：它本身就是产物续读的结果，模型刚读来的内容剪掉没有收益。
 */
export const PRUNE_PROTECT_TOOLS: readonly string[] = ['read_skill', 'read_tool_output']

/** 被剪掉的那段工具输出替换成的占位符（必须让模型知道「这不是没有输出，是被省了」） */
const PLACEHOLDER = '（这段工具输出已因上下文预算被省略；如需其内容请重新调用该工具）'

export interface PruneResult {
  /** 剪枝后的消息（没动手时与输入同一引用，零拷贝） */
  messages: ModelMessage[]
  /** 被替换成占位符的工具结果条数 */
  prunedToolResults: number
  /** 省下的估算 token */
  savedTokens: number
}

/**
 * 把一条 tool-result 的输出折成文本，供 token 估算用。
 *
 * `output` 是包装结构（`{ type: 'text' | 'json' | 'error-text', value }`），不是裸值；
 * 拿不准形状时退化成 JSON.stringify —— 宁可估不准，也不要因为一个异常输出把整轮搞挂。
 */
function toolOutputText(output: ToolResultPart['output']): string {
  if (typeof output === 'string') return output
  if (output && typeof output === 'object') {
    const value = (output as { value?: unknown }).value
    if (typeof value === 'string') return value
    if (value !== undefined) {
      try {
        return JSON.stringify(value) ?? ''
      } catch {
        return ''
      }
    }
  }
  return ''
}

/** 遍历所有 tool-result 部件（只读，供统计与标记两处复用） */
function forEachToolResult(
  messages: ModelMessage[],
  fn: (part: ToolResultPart, msgIndex: number, partIndex: number) => void
): void {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    if (m.role !== 'tool') continue
    const content = m.content as ToolResultPart[]
    for (let j = 0; j < content.length; j++) {
      const p = content[j]
      if (p && p.type === 'tool-result') fn(p, i, j)
    }
  }
}

/**
 * 剪枝：把超出 `protectTokens` 的**旧**工具输出换成占位符。
 *
 * 顺序是「从最后一条消息往前、从最后一段结果往前」—— 这样保留区天然是「最近用过的」，
 * 而不是「文件里位置靠后的」。
 */
export function pruneToolOutputs(
  messages: ModelMessage[],
  opts: {
    /** 保留最近的多少 token 工具输出（缺省 `PRUNE_PROTECT_TOKENS`） */
    protectTokens?: number
    /** 至少省下多少 token 才动手（缺省 `PRUNE_MIN_TOKENS`） */
    minTokens?: number
    /** 永不剪枝的工具名（缺省 `PRUNE_PROTECT_TOOLS`） */
    protectTools?: readonly string[]
  } = {}
): PruneResult {
  const protectTokens = Math.max(0, opts.protectTokens ?? PRUNE_PROTECT_TOKENS)
  const minTokens = Math.max(0, opts.minTokens ?? PRUNE_MIN_TOKENS)
  const protectTools = new Set(opts.protectTools ?? PRUNE_PROTECT_TOOLS)

  const noop: PruneResult = { messages, prunedToolResults: 0, savedTokens: 0 }

  // 先把总量量出来：没超过保留预算就直接短路（绝大多数请求走这条路，零成本）
  let totalToolTokens = 0
  forEachToolResult(messages, (p) => {
    if (protectTools.has(p.toolName)) return
    totalToolTokens += estimateTokens(toolOutputText(p.output))
  })
  if (totalToolTokens <= protectTokens) return noop

  // 从最新往前累计保留预算，超出的标记为待剪
  const toPrune = new Set<ToolResultPart>()
  let kept = 0
  let saved = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role !== 'tool') continue
    const content = m.content as ToolResultPart[]
    for (let j = content.length - 1; j >= 0; j--) {
      const p = content[j]
      if (!p || p.type !== 'tool-result') continue
      if (protectTools.has(p.toolName)) continue
      const t = estimateTokens(toolOutputText(p.output))
      if (kept + t <= protectTokens) {
        kept += t
        continue
      }
      toPrune.add(p)
      saved += t
    }
  }
  // 省得不够多：不值得让模型重读，原样返回
  if (toPrune.size === 0 || saved < minTokens) return noop

  const out: ModelMessage[] = messages.map((m) => {
    if (m.role !== 'tool') return m
    const content = m.content as ToolResultPart[]
    if (!content.some((p) => toPrune.has(p))) return m
    return {
      ...m,
      content: content.map((p) =>
        toPrune.has(p)
          ? ({ ...p, output: { type: 'text', value: PLACEHOLDER } } as ToolResultPart)
          : p
      )
    } as ModelMessage
  })

  return { messages: out, prunedToolResults: toPrune.size, savedTokens: saved }
}
