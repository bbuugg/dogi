/**
 * 错误文案 part 的追加语义（配合 `scripts/verify-agent-error-parts.mjs` 跑真源码）
 *
 * 覆盖两件事：
 * 1. 同一轮里连着来多个 `error` 事件（模型级重试每次尝试失败都发一个）时，
 *    消息尾部**只有最后一条**错误文案，不是 N 段堆叠；
 * 2. 错误文案之后的正文增量**另起一段**，不会被接在 `⚠️ …` 后面。
 */
import { appendAgentPart, appendAssistantPart } from './stores/agent-helpers.ts'
import type { AgentMessagePart, AiMessagePart } from '@shared/types'

let failed = 0
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    console.log(`  ✓ ${name}`)
    return
  }
  failed++
  console.error(`  ✗ ${name}`, detail ?? '')
}

// ---- Agent 会话：连续 3 次失败（3 次重试）只留最后一条 ----
{
  let parts: AgentMessagePart[] = []
  parts = appendAgentPart(parts, { type: 'error', message: '第一次：socket hang up', retryable: true })
  parts = appendAgentPart(parts, { type: 'error', message: '第二次：socket hang up', retryable: true })
  parts = appendAgentPart(parts, { type: 'error', message: '第三次：terminated', retryable: true })

  check('Agent：3 个 error 只留 1 段', parts.length === 1, parts)
  check(
    'Agent：留下的是最后一个错误',
    parts.length === 1 && parts[0].type === 'text' && parts[0].text === '⚠️ 第三次：terminated',
    parts
  )
  check('Agent：错误段带 error 标记', parts.length === 1 && parts[0].error === true, parts)
}

// ---- 重试成功后正文另起一段，不与错误文案合并 ----
{
  let parts: AgentMessagePart[] = []
  parts = appendAgentPart(parts, { type: 'error', message: '中途断流' })
  parts = appendAgentPart(parts, { type: 'text-delta', delta: '好了，' })
  parts = appendAgentPart(parts, { type: 'text-delta', delta: '继续。' })

  check('Agent：错误 + 正文 = 2 段', parts.length === 2, parts)
  check(
    'Agent：正文增量自己合并成一段',
    parts.length === 2 && parts[1].type === 'text' && parts[1].text === '好了，继续。',
    parts
  )
  check('Agent：正文段没有 error 标记', parts.length === 2 && parts[1].error === undefined, parts)
}

// ---- 正文之后再报错：正常追加（错误文案不会顶掉已有正文）----
{
  let parts: AgentMessagePart[] = []
  parts = appendAgentPart(parts, { type: 'text-delta', delta: '先说结论。' })
  parts = appendAgentPart(parts, { type: 'error', message: '随后断流' })

  check('Agent：正文 + 错误 = 2 段且正文完整', parts.length === 2 && parts[0].text === '先说结论。', parts)
}

// ---- 工具调用之后的错误：仍是新的一段 ----
{
  let parts: AgentMessagePart[] = []
  parts = appendAgentPart(parts, {
    type: 'tool-call',
    toolCallId: 'c1',
    toolName: 'read_file',
    input: {}
  })
  parts = appendAgentPart(parts, { type: 'error', message: '网关 502' })

  check('Agent：工具调用后错误独立成段', parts.length === 2 && parts[1].error === true, parts)
}

// ---- 终端 AI 助手：同样的语义，保留 `\n\n` 前缀 ----
{
  let parts: AiMessagePart[] = []
  parts = appendAssistantPart(parts, { type: 'error', message: 'ECONNRESET' })
  parts = appendAssistantPart(parts, { type: 'error', message: 'ECONNRESET again' })
  check('AI 助手：2 个 error 只留 1 段', parts.length === 1, parts)
  check(
    'AI 助手：保留 \\n\\n 前缀',
    parts.length === 1 && parts[0].text === '\n\n⚠️ ECONNRESET again',
    parts
  )

  parts = appendAssistantPart(parts, { type: 'text-delta', delta: '恢复' })
  check('AI 助手：错误后正文另起一段', parts.length === 2 && parts[1].text === '恢复', parts)
}

if (failed) {
  console.error(`\n[verify-agent-error-parts] ${failed} 项断言失败`)
  process.exit(1)
}
console.log('\n[verify-agent-error-parts] 全部通过')