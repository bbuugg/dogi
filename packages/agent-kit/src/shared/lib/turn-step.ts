/**
 * 一轮对话里「过程段」（思考 / 工具调用）在消息列表里的折叠口径。
 *
 * 分工：
 * - **列表侧** `MessageParts` 把连续的思考 / 工具 part 收进一个 `TurnStepGroup`；
 * - **分组抬头**由这里算，一行两格（与思考条的触发行同口径）：
 *   - 左（`turnStepActivity`）：**最后做的那一件事** —— 工具报模型填的 `intent`，
 *     没有 intent（老会话 / 关了「工具意图」开关）就退回工具名；思考在跑时是「思考中…」、
 *     落地后是「思考过程」（不能都写「思考中…」，那行字会看着像一直没完）。
 *     整轮结束后换成整轮耗时（`workDurationLabel`），拿不到耗时就是 `turnStepSummary` 的计数；
 *   - 右（`turnStepPreview`）：这一步的**内容**一行 —— 思考的最后一行 / 命令 / 路径。
 *
 * 这里全是纯函数（只读 part、按当前语言取文案），UI 那边只管画。
 */
import { t } from '@fizz/i18n'
import {
  ASK_FOLLOWUP_TOOL,
  toolCardTitle,
  toolDetailOf,
  toolIntentOf,
  toolState
} from '@fizz/agent-kit/shared/lib/parts'
import { reasoningPreview } from '@fizz/agent-kit/shared/lib/preview-text'
import type { AgentMessagePart } from '@fizz/contracts/types'

/**
 * 从一批要折叠的 part 里算出计数摘要（如「思考 ×1 · 工具调用 ×3」；英文见 en.ts）。
 *
 * ⚠️ `text` **刻意不计数**：一轮结束后折叠条里确实可能压着前面几段正文，但摘要只报「过程」
 * （思考 / 工具 / 提问）—— 多一项「文本 ×N」既不在用户的关注点上，又会让这行变长。
 * 一段过程都没有、只压着正文时回落成「执行过程」。
 */
export function turnStepSummary(parts: AgentMessagePart[]): string {
  let reasoning = 0
  let tools = 0
  let followups = 0
  for (const p of parts) {
    if (p.type === 'reasoning') {
      reasoning++
    } else if (p.type === 'tool-call' || p.type === 'tool-result') {
      if (p.toolName === ASK_FOLLOWUP_TOOL) followups++
      else tools++
    }
  }
  const segments: string[] = []
  if (reasoning) segments.push(t('思考 ×{count}', { count: reasoning }))
  if (tools) segments.push(t('工具调用 ×{count}', { count: tools }))
  if (followups) segments.push(t('提问 ×{count}', { count: followups }))
  return segments.join(' · ') || t('执行过程')
}

/**
 * 这一段过程是不是**真的还在跑**（决定抬头要不要扫光、右格内容要不要跟着最新字滚）。
 *
 * - `reasoning`：调用方只在「它是最后一段可见内容、且整轮还在流式」时才问，所以算在跑；
 * - `tool-call`：拿到结果（`hasOutput`）才算落地；
 * - **等用户作答的提问卡不算在跑** —— 那时候模型没在干活，扫光会让人以为它在转。
 */
export function isStepInFlight(part: AgentMessagePart): boolean {
  if (part.type === 'reasoning') return true
  if (part.type === 'tool-call') {
    if (part.toolName === ASK_FOLLOWUP_TOOL) return false
    return !toolState(part).hasOutput
  }
  return false
}

/**
 * 这一段过程**最后做的那一件事**（分组抬头左侧那格，整轮没结束时只看这个）。
 *
 * 只看最后一个 part：分组是按时间线切的，前面那些都已经落地了，用户关心的是「最后停在哪一步」。
 *
 * ⚠️ **工具一律报「这一步要干什么」**：模型每次调工具都填了 `intent`（见 `toolIntentOf`），
 * 那就是最贴切的一句话（「跑一下单测」「看看会话是怎么落盘的」）。曾经按工具类型写死成
 * 「执行命令中…」/「正在执行「读取文件」…」—— 对命令类工具等于把**唯一的有效信息**
 * （跑的是什么）藏起来，用户看到的就是一行「执行命令中…」干等着。没有 intent 时退回
 * 工具名；正在跑 / 已落地不再是两种文案（扫光动画已经在说「还在动」）。
 *
 * ⚠️ **思考结尾要看 `active`**：只有这一段**真还在跑**时才是「思考中…」。已经落地
 * （模型转去写正文了、这一组成了历史）还写「思考中…」，那行字看上去就像它卡在那儿、
 * 一直没完 —— 换成「思考过程」，说的是「这组最后一步是思考」，不承诺进行时。
 */
export function turnStepActivity(
  parts: AgentMessagePart[],
  options: { showIntent?: boolean; active?: boolean } = {}
): string {
  const { showIntent = true, active = false } = options
  const last = parts[parts.length - 1]

  if (last?.type === 'tool-call') {
    const intent = showIntent ? toolIntentOf(last) : ''
    return intent || toolCardTitle(last.toolName, last.acpKind)
  }
  // 尾 part 是思考（或空组）：进行时才说「思考中…」，落地后只报「思考过程」
  return active ? t('思考中…') : t('思考过程')
}

/**
 * 抬头**右侧那格的内容预览**：这一步「做的到底是什么」—— 思考的最后一行，或工具的
 * 主入参（命令 / 路径 / 搜索词 / 派活 prompt）。没有可看的内容就返回 undefined。
 *
 * `lineKey` 只对思考有意义（换行下标，`ReasoningPreview` 靠它判「滚一格」）；
 * 工具明细是压平的一行，给 -1（恒定 → 只横向跟尾部，不滚行）。
 */
export function turnStepPreview(
  parts: AgentMessagePart[]
): { text: string; lineKey: number } | undefined {
  /*
   * 从尾巴往前找第一个「有内容可看」的 part，而不是只看最后一个。
   *
   * 正常落盘形状里工具结果是回填到 tool-call 上的，尾巴就是 tool-call，等价于只看最后一个；
   * 但 ACP 的补全 / 孤儿结果可能让尾巴变成一个没有入参的 `tool-result`（见 `lib/parts.ts`
   * 的 applyEvent 兜底分支）。只看最后一个的话，整组抬头右侧会突然空掉 —— 而它前面那条
   * tool-call 明明带着路径 / 命令。往前找一格就能保住预览。
   */
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const part = parts[i]
    // 正文是分组的边界：越过它就变成「报上一步的内容」，而整轮结束的组尾部常压着正文，
    // 那样抬头会显示很早以前的工具明细（与「最后一步」的语义不符）。
    if (part.type === 'text') return undefined
    if (part.type === 'reasoning') {
      if (!part.text.trim()) continue
      const { line, lineKey } = reasoningPreview(part.text)
      if (line) return { text: line, lineKey }
      continue
    }
    if (part.type !== 'tool-call') continue
    const detail = toolDetailOf(part)
    if (detail) return { text: detail, lineKey: -1 }
  }
  return undefined
}

/** 毫秒 →「N 秒」/「N 分 N 秒」（不足 1 秒按 1 秒算，别显示「0 秒」） */
export function formatWorkDuration(ms: number): string {
  const totalSeconds = Math.max(1, Math.round(ms / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (!minutes) return t('{seconds} 秒', { seconds })
  return seconds
    ? t('{minutes} 分 {seconds} 秒', { minutes, seconds })
    : t('{minutes} 分', { minutes })
}

/** 分组抬头上的「工作了多久」（**只有整轮结束后**才用这一档） */
export function workDurationLabel(ms: number): string {
  return t('已工作 {duration}', { duration: formatWorkDuration(ms) })
}
