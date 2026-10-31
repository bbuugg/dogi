/**
 * 回归：**分屏时上下文压缩的状态跟着会话走，不串台**。
 *
 * ## 防的是什么
 *
 * `contextNotice`（「上下文已压缩」的提示条）和 `contextCompressing`（圆环转圈 + 输入框
 * 禁发）以前住在 `CoreSlice` —— store 上的**全局**字段，`compressContextNow` 也是按
 * 活跃会话走的。分屏时在 B 标签手动压一次上下文：A 标签也会闪提示、圆环也转、
 * 输入框也禁发。更糟的是 `compressContextNow` 在 A 里点会压到 B 的上下文上。
 *
 * 和「模型 pill 一起变」是同一个根因：**某一条会话的属性被放进了全局**。
 *
 * ## 钉住三件事
 *
 * 1. `setContextNotice(notice, 会话)` 只写那条会话的 slice，别的会话读不到；
 * 2. 自动消失的 8 秒定时器**每条会话一个**：B 后出现的提示不会重置 A 的倒计时；
 * 3. `compressContextNow(会话)` 压的是那条会话（请求带它的 id），转圈标志也只落在它上面。
 */
import { describe, expect, it, vi } from 'vitest'
import { createConversationSlice } from '../index'

const FOCUS = 'conv-a'
const OTHER = 'conv-b'

function makeStore() {
  const api = {
    setConversationQueue: vi.fn(async () => ({ ok: true })),
    setConversationTarget: vi.fn(async () => ({ ok: true })),
    compressContext: vi.fn(
      async (
        _conversationId: string,
        _onEvent: (event: unknown) => void
      ): Promise<{ ok: boolean; summary?: unknown; reason?: string }> => ({
        ok: true,
        summary: { turns: 3 }
      })
    )
  }
  const conversations = [
    { id: FOCUS, backend: 'builtin', workspaceId: 'ws-1', title: 'A' },
    { id: OTHER, backend: 'builtin', workspaceId: 'ws-1', title: 'B' }
  ]
  const boot = {
    conversations,
    workspaces: [{ id: 'ws-1', path: '/tmp/ws', name: 'ws' }],
    runningConversations: {},
    models: [],
    acpAgents: [],
    chatTarget: null,
    reasoningEffort: null,
    mcpServerIds: [],
    browserSettings: null,
    slices: {},
    getApi: () => api,
    setBusy: () => undefined,
    setError: () => undefined
  }
  const state: Record<string, unknown> = { ...boot, activeConversationId: null }
  const set = (partial: unknown): void => {
    const patch =
      typeof partial === 'function' ? (partial as (s: unknown) => object)(state) : partial
    Object.assign(state, patch as object)
  }
  const get = (): unknown => state
  const slice = (
    createConversationSlice as unknown as (
      set: unknown,
      get: unknown,
      api: unknown
    ) => Record<string, unknown>
  )(set, get, {})
  Object.assign(state, slice)
  // slice 初始化会把 activeConversationId 写回 null：摆成「焦点在 A」的那一刻
  Object.assign(state, boot, { activeConversationId: FOCUS })

  type Notice = { beforeTokens: number; afterTokens: number; at: number } | null
  return {
    state,
    api,
    readSlice: slice.readSlice as (id: string | null) => {
      contextNotice: Notice
      contextCompressing: boolean
    },
    setContextNotice: slice.setContextNotice as (
      notice: Notice,
      scope?: string | null
    ) => void,
    compressContextNow: slice.compressContextNow as (
      scope?: string | null
    ) => Promise<{ ok: boolean; reason?: string }>
  }
}

const notice = (beforeTokens: number) => ({
  beforeTokens,
  afterTokens: beforeTokens / 4,
  at: 1
})

describe('setContextNotice：按会话', () => {
  it('只在触发压缩的那个标签上出现', () => {
    const { readSlice, setContextNotice } = makeStore()

    setContextNotice(notice(1000), OTHER)

    expect(readSlice(OTHER).contextNotice).toEqual(notice(1000))
    // 焦点会话 A 不受影响 —— 以前它读的是同一个全局字段，于是两个标签一起闪
    expect(readSlice(FOCUS).contextNotice).toBeNull()
  })

  it('8 秒后自动消失，且两条会话的倒计时互不重置', () => {
    vi.useFakeTimers()
    try {
      const { readSlice, setContextNotice } = makeStore()

      setContextNotice(notice(1000), FOCUS)
      vi.advanceTimersByTime(5000)
      // B 的提示晚 5 秒出现：不能把 A 的定时器清掉重来
      setContextNotice(notice(2000), OTHER)
      vi.advanceTimersByTime(3000)

      expect(readSlice(FOCUS).contextNotice).toBeNull()
      expect(readSlice(OTHER).contextNotice).toEqual(notice(2000))

      vi.advanceTimersByTime(5000)
      expect(readSlice(OTHER).contextNotice).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('新会话（没有会话）不记：那是「谁的上下文」都没有的页面', () => {
    const { readSlice, setContextNotice } = makeStore()
    setContextNotice(notice(1000), null)
    expect(readSlice(FOCUS).contextNotice).toBeNull()
    expect(readSlice(OTHER).contextNotice).toBeNull()
  })
})

describe('compressContextNow：按会话', () => {
  it('压的是传进来的那条会话，转圈标志也只落在它上面', async () => {
    const { api, readSlice, compressContextNow, state } = makeStore()
    let finish: (v: { ok: boolean; summary: unknown }) => void = () => undefined
    api.compressContext.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve as (v: { ok: boolean; summary: unknown }) => void
      }) as never
    )

    const pending = compressContextNow(OTHER)

    // 进行中：只有 B 在转
    expect(api.compressContext.mock.calls[0][0]).toBe(OTHER)
    expect(readSlice(OTHER).contextCompressing).toBe(true)
    expect(readSlice(FOCUS).contextCompressing).toBe(false)

    finish({ ok: true, summary: { turns: 3 } })
    expect(await pending).toEqual({ ok: true })

    // 结束后熄掉，并且只更新 B 那条会话的检查点
    expect(readSlice(OTHER).contextCompressing).toBe(false)
    const convOf = (id: string) =>
      (state.conversations as Record<string, unknown>[]).find((c) => c.id === id)
    expect(convOf(OTHER)?.contextSummary).toEqual({ turns: 3 })
    expect(convOf(FOCUS)?.contextSummary).toBeUndefined()
  })

  it('同一条会话正在压缩时不重复发请求；不同会话互不阻塞', async () => {
    const { api, readSlice, compressContextNow } = makeStore()
    let finish: (v: { ok: boolean; summary: unknown }) => void = () => undefined
    api.compressContext.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve as (v: { ok: boolean; summary: unknown }) => void
      }) as never
    )

    const first = compressContextNow(OTHER)
    const again = await compressContextNow(OTHER)
    expect(again).toEqual({ ok: false, reason: '压缩正在进行中' })
    expect(api.compressContext).toHaveBeenCalledTimes(1)

    // 另一个标签压自己的上下文：不该被 B 挡住
    void compressContextNow(FOCUS)
    expect(readSlice(FOCUS).contextCompressing).toBe(true)

    finish({ ok: true, summary: {} })
    await first
  })
})
