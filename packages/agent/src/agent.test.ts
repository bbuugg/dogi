/**
 * 这组测的是「一次尝试失败时，用户只该看到一条提示，且这一轮必须被标成失败」。
 *
 * 防的两个回归（都出在 `agent.ts` 的流内 error 分支 / 收尾判定）：
 *
 * 1. 同一个故障被说两遍：上游渠道全挂时 AI SDK 自己重试 3 次后往 fullStream 里吐一条
 *    error part（`Failed after 3 attempts. Last error: AI_APICallError: …`），以前我们
 *    当场下发了；这次尝试又一个内容都没产出，收尾时又合成一条「上游返回空响应」——
 *    对话框里两句 `⚠️ ` 各挂一颗「重新加载」。
 * 2. 吐了半截正文就报错，却被当成跑完了：多步续写时「下一步请求」撞上限流 / 断网
 *    （`concurrency reached` 这类）会留下半截回复 + 一句 `⚠️ `，收尾却报 `done`，
 *    于是既不重试、内容也不完整。现在按失败收尾：没执行过工具就自动重试（`retry`
 *    事件让前端清掉半截），执行过工具则只标失败、不重跑（避免重复副作用）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStreamEvent, AiModelConfig } from '@fizz/contracts/types'

const { streamText } = vi.hoisted(() => ({ streamText: vi.fn() }))

vi.mock('ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ai')>()),
  streamText
}))
vi.mock('./resolve-model', () => ({ resolveModel: () => ({ modelId: 'mock' }) }))
// 重试退避真的等 1s 会把整组拖慢，且与这里要验的东西无关（只关心「重试过」）
vi.mock('./retry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./retry')>()),
  sleepWithSignal: async () => true
}))

const { runAgent } = await import('./agent')

/** 造一份 AI SDK 的 fullStream：parts 就是上游依次吐出来的东西 */
function fakeStream(parts: unknown[]) {
  return {
    fullStream: (async function* () {
      for (const part of parts) yield part
    })()
  }
}

const UPSTREAM_ERROR =
  'Failed after 3 attempts. Last error: AI_APICallError: No available channel for model ' +
  'cline/glm-5.3-flash under group default (distributor)'

/** 已经吐了半截正文之后才失败（在线表现：`concurrency reached, current: 11, limit: 10`） */
const MID_STREAM_ERROR =
  'Failed after 3 attempts. Last error: AI_APICallError: concurrency reached, ' +
  'current: 11, limit: 10'

function baseOptions(onEvent: (event: AgentStreamEvent) => void) {
  return {
    workspace: { id: 'w1', name: 'W', path: '', createdAt: 0, updatedAt: 0 },
    history: [],
    model: {
      provider: 'openai',
      apiKey: 'sk-test',
      models: [],
      model: 'm1'
    } as unknown as AiModelConfig,
    skills: [],
    /** 走自造 setup：不读工作区、不挂真实工具（本组只关心事件流） */
    setup: { instructions: 'SYS', tools: {} },
    toolIntent: false,
    maxRetries: 1,
    onEvent
  }
}

type ErrorEvent = Extract<AgentStreamEvent, { type: 'error' }>
const errorEvents = (events: AgentStreamEvent[]): ErrorEvent[] =>
  events.filter((e): e is ErrorEvent => e.type === 'error')

describe('runAgent 的失败提示', () => {
  beforeEach(() => {
    streamText.mockReset()
  })

  it('流内已报错且整轮无内容时，只下发一条错误（不再追加「上游返回空响应」）', async () => {
    streamText.mockImplementation(() => fakeStream([{ type: 'error', error: new Error(UPSTREAM_ERROR) }]))

    const events: AgentStreamEvent[] = []
    const result = await runAgent(baseOptions((event) => events.push(event)))

    // 第 1 次失败 → 一次重试 → 第 2 次仍失败且次数到顶
    expect(streamText).toHaveBeenCalledTimes(2)
    expect(events.filter((e) => e.type === 'retry')).toHaveLength(1)

    const errors = errorEvents(events)
    expect(errors).toHaveLength(1)
    expect(errors[0].message).toBe(UPSTREAM_ERROR)
    expect(result.finishReason).toBe('error')
    expect(result.error).toBe(UPSTREAM_ERROR)
  })

  it('上游静默回空响应（没有任何 error part）时，仍然只报一条空响应', async () => {
    streamText.mockImplementation(() => fakeStream([]))

    const events: AgentStreamEvent[] = []
    const result = await runAgent(baseOptions((event) => events.push(event)))

    const errors = errorEvents(events)
    expect(errors).toHaveLength(1)
    expect(errors[0].message).toContain('上游返回空响应')
    expect(result.finishReason).toBe('error')
  })

  it('已经产出过内容 + 尾部流内 error（未执行工具）：按失败处理并允许重试，不报成 done', async () => {
    streamText.mockImplementation(() =>
      fakeStream([
        { type: 'text-delta', text: '你好' },
        { type: 'error', error: new Error(MID_STREAM_ERROR) }
      ])
    )

    const events: AgentStreamEvent[] = []
    const result = await runAgent(baseOptions((event) => events.push(event)))

    // 半截正文 + 失败 → 重跑整轮（`retry` 事件让前端把半截内容清掉，避免正文重复）
    expect(streamText).toHaveBeenCalledTimes(2)
    expect(events.some((e) => e.type === 'retry')).toBe(true)
    expect(result.finishReason).toBe('error')
    expect(result.error).toBe(MID_STREAM_ERROR)

    // 每次尝试至多一条错误，且绝不掺「上游返回空响应」
    const errors = errorEvents(events)
    expect(errors.length).toBeLessThanOrEqual(2)
    expect(errors.every((e) => e.message === MID_STREAM_ERROR)).toBe(true)
  })

  it('已经执行过工具 + 尾部流内 error：不重试（避免重复副作用），但这一轮仍标成失败', async () => {
    streamText.mockImplementation(() =>
      fakeStream([
        { type: 'tool-call', toolCallId: 't1', toolName: 'echo', input: {} },
        { type: 'tool-result', toolCallId: 't1', toolName: 'echo', output: 'ok' },
        { type: 'text-delta', text: '好的' },
        { type: 'error', error: new Error(MID_STREAM_ERROR) }
      ])
    )

    const events: AgentStreamEvent[] = []
    const result = await runAgent(baseOptions((event) => events.push(event)))

    // 执行过工具就不能重跑（会重复写入 / 命令），只标失败让用户自己决定
    expect(streamText).toHaveBeenCalledTimes(1)
    expect(events.some((e) => e.type === 'retry')).toBe(false)
    expect(result.finishReason).toBe('error')
    expect(result.error).toBe(MID_STREAM_ERROR)

    // 流里已经下发过那条错误了，收尾不许再补一条
    expect(errorEvents(events)).toHaveLength(1)
  })
})
