/**
 * 回归：`openConversation` 的「已是当前会话」早退必须带上「本地现场还在」。
 *
 * ## 防的是什么
 *
 * 「多智能体协作」建完会话后消息区**永远停在骨架屏**（用户报「打开后消息列表始终
 * 显示 loading」）：
 *
 * 1. `newConversation` 建完会话就把 `activeConversationId` 设成它（界面要立刻切进去）；
 * 2. 调用方紧接着那次 `openConversation(id)` 命中「已是当前会话，什么都不做」早退；
 * 3. 可那一刻 `slices[id]` 根本不存在 —— **没有任何人发装载请求**，也没有任何请求在飞；
 * 4. `messagesLoading` 的兜底是「本屏绑了会话、现场还没建 → true」，于是骨架屏永不消失
 *    （重试按钮也不会出现：`messagesError` 同样是空的）。
 *
 * 刷新后恢复标签同理会中：`activeConversationId` 已从 localStorage 还原成同一条，
 * 而 `slices` 是空的。
 *
 * 这里钉住两件事：**现场没建时必须装载**；**现场在时仍然早退**（切回来不该白闪重拉）。
 */
import { describe, expect, it, vi } from 'vitest'
import { createConversationSlice } from '../index'
import type { ConvSlice } from '../types'

const CONVERSATION_ID = 'conv-collab'

/** 协作会话的最小 api 桩：装载链路会读的那几个方法（其余缺失由各处的 catch / 兜底吃掉） */
function makeApi() {
  return {
    getConversation: vi.fn(async () => ({
      id: CONVERSATION_ID,
      workspaceId: 'ws-1',
      backend: 'builtin',
      title: '多智能体协作',
      messages: [],
      createdAt: 1,
      updatedAt: 1
    })),
    // 协作运行态（`loadConversation` 的 collab 分支）
    getCollabState: vi.fn(async () => ({ collab: null })),
    // 收尾时 `attachRun` 的探测：null = 这条会话没有在跑的 run
    activeRun: vi.fn(async () => ({ run: null })),
    // 打开会话顺带同步队列
    getConversationQueue: vi.fn(async () => ({ items: [] }))
  }
}

/** 最小 store：只给 `openConversation` / `loadConversation` 这条链路实际会读的字段 */
function makeStore(api: Record<string, unknown>) {
  const collabConversation = {
    id: CONVERSATION_ID,
    backend: 'builtin',
    kind: 'collab',
    configId: 'cfg-1',
    workspaceId: 'ws-1',
    title: '多智能体协作',
    createdAt: 1,
    updatedAt: 1
  }
  const boot = {
    conversations: [collabConversation],
    conversationsLoaded: true,
    workspaces: [{ id: 'ws-1', path: '/tmp/ws', name: 'ws' }],
    runningConversations: {},
    models: [],
    acpAgents: [],
    chatTarget: null,
    slices: {} as Record<string, ConvSlice>,
    getApi: () => api,
    setBusy: () => undefined,
    setError: () => undefined
  }
  const state: Record<string, unknown> = {
    ...boot,
    activeConversationId: null
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
  // `createConversationSlice` 的初始现场会盖掉上面铺的字段（它自己写 activeConversationId: null、
  // 空 slices），装完再摆回「新建会话刚建好、还没人装载」的那一刻
  Object.assign(state, boot, { activeConversationId: CONVERSATION_ID })

  const sliceOf = (id: string): ConvSlice | undefined =>
    (state.slices as Record<string, ConvSlice>)[id]
  return { state, slice, sliceOf }
}

function open(slice: Record<string, unknown>, id: string): void {
  ;(slice.openConversation as (conversationId: string) => void)(id)
}

describe('openConversation：已是当前会话时的早退', () => {
  it('本地现场没建时必须装载（否则消息区永远停在骨架屏）', async () => {
    const api = makeApi()
    const { state, slice, sliceOf } = makeStore(api)

    // 刚建会话的那一刻：已经激活，但没有人装载过
    expect(state.activeConversationId).toBe(CONVERSATION_ID)
    expect(sliceOf(CONVERSATION_ID)).toBeUndefined()

    open(slice, CONVERSATION_ID)

    // 现场被建出来，且装载走完（loading 落地为 false）
    await vi.waitFor(() => {
      expect(sliceOf(CONVERSATION_ID)?.loading).toBe(false)
    })
    expect(api.getConversation).toHaveBeenCalledWith(CONVERSATION_ID)
  })

  it('现场还在时仍然早退，不重复重拉', async () => {
    const api = makeApi()
    const { slice, sliceOf } = makeStore(api)

    open(slice, CONVERSATION_ID)
    await vi.waitFor(() => {
      expect(sliceOf(CONVERSATION_ID)?.loading).toBe(false)
    })

    api.getConversation.mockClear()
    open(slice, CONVERSATION_ID)
    await new Promise((resolve) => setTimeout(resolve, 0))

    // 切走再切回来时消息已在内存里：重拉只会让界面白闪一次
    expect(api.getConversation).not.toHaveBeenCalled()
  })
})
