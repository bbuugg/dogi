/**
 * 会话装载期间的「装载中」标记（回归测试）。
 *
 * ## 防的是什么
 *
 * 刷新页面后进 ACP 会话会**闪一下空态**（消息区那句「在「工作区」里说点什么」）：
 *
 * 1. `loadConversation` 先 `await loadMessages(...)`，ACP 会话的服务端历史恒为空，
 *    收尾把 `messages` 写成 `[]`、并且**把 `loading` 撤成 false**；
 * 2. 接着还要走两个往返才知道有没有内容 —— `peekActiveRun`（这一轮还在不在跑）
 *    与 `session/load` 回放；
 * 3. 这两个往返之间 `loading` 是 false、`messages` 还是空，消息区就按「一条消息都没有」
 *    渲染空态，回放一到又被消息顶掉。
 *
 * 以前的补丁只在「会话清单还没落地」时重新亮灯（`!conversationsLoaded` 那条分支），
 * 而刷新后的恢复入口是 `PanelView` 等清单到位再把当前会话对齐到焦点标签 —— 进
 * `loadConversation` 时清单**已经** loaded，于是那条分支根本不进，空态必闪。
 *
 * 这里钉住：`peekActiveRun` 还没返回的那段窗口里，切片必须是 `loading: true`。
 */
import { describe, expect, it, vi } from 'vitest'
import type { AgentChatMessage } from '@fizz/contracts/agent-api'
import { createConversationSlice } from '../index'
import type { ConvSlice } from '../types'

/** 手写一个可外部放行的 promise（模拟「探测在不在跑」那个往返） */
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

const CONVERSATION_ID = 'conv-acp'

const replayAssistant: AgentChatMessage = {
  id: 'a-1',
  role: 'assistant',
  parts: [{ type: 'text', text: '回放出来的回复' }],
  createdAt: 1
}

/**
 * 最小 store：只给 `loadConversation` 这条链路实际会读的字段。
 *
 * `set` 同时支持 patch 对象与 updater（zustand 两种写法切片里都在用）。
 */
function makeStore(api: Record<string, unknown>) {
  const state: Record<string, unknown> = {
    activeConversationId: CONVERSATION_ID,
    conversations: [
      {
        id: CONVERSATION_ID,
        backend: 'acp',
        configId: 'cfg-1',
        acpSessionId: 'sess-1',
        workspaceId: 'ws-1',
        title: 'acp 会话',
        createdAt: 1,
        updatedAt: 1
      }
    ],
    conversationsLoaded: true,
    workspaces: [{ id: 'ws-1', path: '/tmp/ws', name: 'ws' }],
    runningConversations: {},
    models: [],
    acpAgents: [],
    chatTarget: null,
    getApi: () => api,
    setBusy: () => undefined,
    setError: () => undefined
  }
  const set = (partial: unknown): void => {
    const patch =
      typeof partial === 'function'
        ? (partial as (s: unknown) => object)(state)
        : partial
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
  // `createConversationSlice` 的初始值会覆盖上面铺的现场（它自己写 activeConversationId: null），
  // 装完再把这条会话摆回来
  Object.assign(state, {
    activeConversationId: CONVERSATION_ID,
    conversations: [
      {
        id: CONVERSATION_ID,
        backend: 'acp',
        configId: 'cfg-1',
        acpSessionId: 'sess-1',
        workspaceId: 'ws-1',
        title: 'acp 会话',
        createdAt: 1,
        updatedAt: 1
      }
    ],
    conversationsLoaded: true,
    workspaces: [{ id: 'ws-1', path: '/tmp/ws', name: 'ws' }],
    models: [],
    acpAgents: [],
    chatTarget: null,
    getApi: () => api,
    setBusy: () => undefined,
    setError: () => undefined
  })
  const read = (id: string): ConvSlice => (state.slices as Record<string, ConvSlice>)[id]
  return { state, read, loadConversation: slice.loadConversation as (id: string) => Promise<void> }
}

function acpApi(peekGate: { promise: Promise<null> }, calls: { activeRun: number }) {
  return {
    // ACP 会话的服务端历史恒为空（回放才是真源）
    getConversation: vi.fn(async (id: string) => ({
      id,
      backend: 'acp' as const,
      configId: 'cfg-1',
      acpSessionId: 'sess-1',
      workspaceId: 'ws-1',
      title: 'acp 会话',
      createdAt: 1,
      updatedAt: 1,
      messages: [] as AgentChatMessage[]
    })),
    /**
     * 第一次是 `peekActiveRun`（挂住，模拟服务端往返），之后的是 `attachRun` 的探测
     * —— 没有在跑，直接给 null。
     */
    activeRun: vi.fn(async () => {
      calls.activeRun += 1
      if (calls.activeRun === 1) {
        await peekGate.promise
        return { run: null }
      }
      return { run: null }
    }),
    getAcpTranscript: vi.fn(async () => ({ messages: [replayAssistant] }))
  }
}

describe('loadConversation · ACP 装载窗口', () => {
  it('探测「有没有在跑」的往返期间保持装载中（不再闪空态）', async () => {
    const peekGate = deferred<null>()
    const calls = { activeRun: 0 }
    const api = acpApi(peekGate, calls)
    const { read, loadConversation, state } = makeStore(api)

    const done = loadConversation(CONVERSATION_ID)
    // 走到 peekActiveRun 的等待点：loadMessages 已经收尾（loading 被撤过一次）
    await vi.waitFor(() => expect(api.activeRun).toHaveBeenCalledTimes(1))
    expect(state.conversationsLoaded).toBe(true)
    // 关键断言：这一段消息区必须显示装载中，而不是「一条消息都没有」的空态
    expect(read(CONVERSATION_ID).loading).toBe(true)
    expect(read(CONVERSATION_ID).messages).toHaveLength(0)

    peekGate.resolve(null)
    await done

    // 回放落地、装载标记撤掉
    expect(read(CONVERSATION_ID).messages).toEqual([replayAssistant])
    expect(read(CONVERSATION_ID).loading).toBe(false)
  })
})
