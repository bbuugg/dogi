/**
 * 帧日志压缩的等价性：交接文档的 delta 是全场最密的之一，必须按 phase 合并；
 * 合并后回放出的文本要与合并前逐字一致，且不能跨 phase 拼（两段摘要标题不同）。
 */
import { describe, expect, it, vi } from 'vitest'
import type { ChatStreamFrame } from '@fizz/contracts/agent-api'

vi.mock('./state', () => ({
  chatRuns: {
    runs: new Map(),
    activeByConversation: new Map(),
    doneResolves: new Map()
  }
}))

const { compactFrames } = await import('./chat-run')

function frame(event: ChatStreamFrame['event']): ChatStreamFrame {
  return { type: 'event', requestId: 'req-1', event }
}

describe('compactFrames', () => {
  it('相邻同 phase 的交接文档 delta 合并，不同 phase 不跨拼', () => {
    const merged = compactFrames([
      frame({
        type: 'context-compaction-start',
        beforeTokens: 1000,
        summarizedTurns: 3,
        keptTurns: 2
      }),
      frame({ type: 'context-compaction-delta', phase: 'checkpoint', delta: 'a' }),
      frame({ type: 'context-compaction-delta', phase: 'checkpoint', delta: 'b' }),
      frame({ type: 'context-compaction-delta', phase: 'turn-prefix', delta: 'c' }),
      frame({ type: 'context-compaction-delta', phase: 'turn-prefix', delta: 'd' }),
      frame({
        type: 'context-compressed',
        beforeTokens: 1000,
        afterTokens: 400,
        summarizedTurns: 3,
        keptTurns: 2
      })
    ])

    const deltas = merged
      .map((f) => f.event)
      .filter((e) => e?.type === 'context-compaction-delta')
    expect(deltas).toEqual([
      { type: 'context-compaction-delta', phase: 'checkpoint', delta: 'ab' },
      { type: 'context-compaction-delta', phase: 'turn-prefix', delta: 'cd' }
    ])
    expect(merged).toHaveLength(4)
  })
})
