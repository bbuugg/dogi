/**
 * 助手消息落盘时的「整轮耗时」（回归测试）。
 *
 * ## 防的是什么
 *
 * 折叠条抬头有两种口径（`packages/agent-kit/.../message-parts.tsx`）：整轮结束后报
 * 「已工作 N 秒」，拿不到耗时才退回「思考 ×5 · 工具调用 ×5」的计数摘要。
 *
 * 内置后端正常跑完时耗时在 `usage.durationMs` 里；但**被用户中止 / 出错**的那一轮常常
 * 一个 usage chunk 都没收到（点停止时模型可能正卡在思考或工具执行里），`usage` 做不出来。
 * 以前 `AgentChatMessage` 上不写任何耗时，于是中止后抬头直接退化成计数摘要，看着像
 * 这一轮没结束；刷新后从落盘数据读，更补不回来。
 *
 * 现在 `agent.ts` 的 finish 帧在没有 `usage` 时单独给 `durationMs`，这条用例钉住落盘口径：
 * 有 `usage` 就只写 `usage`（它自带耗时），没有才写 `durationMs`，绝不两个都写。
 */
import { describe, expect, it } from 'vitest'
import type { TurnUsage } from '@fizz/contracts/types'
import { buildAssistantMessage } from './assistant-message'

const parts = [{ type: 'text' as const, text: '半截回复' }]

const usage: TurnUsage = {
  inputTokens: 100,
  outputTokens: 20,
  totalTokens: 120,
  durationMs: 8_000,
  tps: 2.5
}

describe('buildAssistantMessage · 整轮耗时', () => {
  it('没有 usage（中止 / 出错的轮次）：单独写 durationMs，不编造 usage', () => {
    const message = buildAssistantMessage({
      parts,
      id: 'a-1',
      durationMs: 193_000,
      now: 1
    })

    expect(message.durationMs).toBe(193_000)
    // 0 token 的假 usage 会污染会话统计与消息底部那行
    expect(message.usage).toBeUndefined()
    expect(message.role).toBe('assistant')
    expect(message.parts).toBe(parts)
  })

  it('有 usage：只写 usage（它自带 durationMs，不再重复写一个可能不同的数）', () => {
    const message = buildAssistantMessage({
      parts,
      id: 'a-1',
      usage,
      durationMs: 193_000,
      now: 1
    })

    expect(message.usage).toEqual(usage)
    expect(message.durationMs).toBeUndefined()
  })

  it('两个都没有（老调用方 / 准备阶段就失败）：消息上不多出任何字段', () => {
    const message = buildAssistantMessage({ parts, id: 'a-1', now: 1 })

    expect(message.durationMs).toBeUndefined()
    expect(message.usage).toBeUndefined()
    expect(message.id).toBe('a-1')
  })
})
