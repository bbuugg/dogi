/**
 * 回归：**分屏两个标签时，模型 pill 不能同步成同一个**。
 *
 * ## 防的是什么
 *
 * 用户报的现象：主区域开两个对话标签、并排分离（分屏），各自用不同模型；点第一个
 * 标签，两个标签的模型 pill 都变成第一个的；点第二个，又都变成第二个的。
 *
 * 根因：`chatTarget` / `reasoningEffort` / `mcpServerIds` / `browserSettings` 在 store 上
 * 是**单份**的（「焦点会话的现场」），`openConversation` 每开一个会话就按那个会话重写。
 * 单标签时「焦点即视图」没问题，分屏时两个标签同时可见，非焦点那个的 composer 读的
 * 也是这份 —— 于是跟着焦点标签一起变。
 *
 * ## 钉住三件事
 *
 * 1. `scopedSettingsOf(非焦点会话)` 给出**它自己**的模型（从会话清单派生），不是全局那份；
 * 2. `setChatTarget(target, 非焦点会话)` 只写那个会话：不改全局 `chatTarget`，也不去
 *    探 ACP 档位（那属于焦点标签的草稿态）；
 * 3. 不传 scope 的旧调用行为不变（仍然作用于焦点会话）。
 */
import { describe, expect, it, vi } from 'vitest'
import { createConversationSlice } from '../index'

const FOCUS = 'conv-a'
const OTHER = 'conv-b'

/** 两条会话、两份模型配置：分屏时各自一份模型 */
function makeStore() {
  const api = { setConversationTarget: vi.fn(async () => ({ ok: true })) }
  const conversations = [
    {
      id: FOCUS,
      backend: 'builtin',
      configId: 'cfg-a',
      modelId: 'model-a',
      workspaceId: 'ws-1',
      title: 'A',
      createdAt: 1,
      updatedAt: 1
    },
    {
      id: OTHER,
      backend: 'builtin',
      configId: 'cfg-b',
      modelId: 'model-b',
      workspaceId: 'ws-1',
      title: 'B',
      createdAt: 2,
      updatedAt: 2
    }
  ]
  const models = [
    { id: 'cfg-a', name: 'A', models: [{ id: 'model-a', name: 'model-a' }] },
    { id: 'cfg-b', name: 'B', models: [{ id: 'model-b', name: 'model-b' }] }
  ]
  const boot = {
    conversations,
    conversationsLoaded: true,
    workspaces: [{ id: 'ws-1', path: '/tmp/ws', name: 'ws' }],
    runningConversations: {},
    models,
    acpAgents: [],
    // 焦点会话 A 的现场
    chatTarget: { backend: 'builtin', configId: 'cfg-a', modelId: 'model-a' },
    reasoningEffort: null,
    mcpServerIds: [],
    browserSettings: null,
    slices: {},
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
  // slice 初始化会写回 `activeConversationId: null` 等默认值：摆成「焦点在 A」的那一刻
  Object.assign(state, boot, { activeConversationId: FOCUS })

  const conversationOf = (id: string): Record<string, unknown> =>
    (state.conversations as Record<string, unknown>[]).find(
      (c) => c.id === id
    ) as Record<string, unknown>
  return { state, api, slice, conversationOf }
}

describe('scopedSettingsOf：按会话取现场', () => {
  it('非焦点会话给的是它自己的模型', () => {
    const { state, slice } = makeStore()
    const scoped = (
      slice.scopedSettingsOf as (id: string | null) => {
        chatTarget: { configId?: string; modelId?: string } | null
      }
    )(OTHER)

    expect(scoped.chatTarget?.configId).toBe('cfg-b')
    expect(scoped.chatTarget?.modelId).toBe('model-b')
    // 关键：**不是**全局那份（以前分屏两个 pill 都显示它）
    expect(scoped.chatTarget).toEqual({
      backend: 'builtin',
      configId: 'cfg-b',
      modelId: 'model-b'
    })
    expect(state.chatTarget).toEqual({
      backend: 'builtin',
      configId: 'cfg-a',
      modelId: 'model-a'
    })
  })

  it('焦点会话与新对话页仍用 store 里那份（含还没发送的改动）', () => {
    const { state, slice } = makeStore()
    state.chatTarget = { backend: 'builtin', configId: 'cfg-b', modelId: 'model-b' }
    const scopedOf = slice.scopedSettingsOf as (id: string | null) => {
      chatTarget: unknown
    }

    expect(scopedOf(FOCUS).chatTarget).toEqual(state.chatTarget)
    expect(scopedOf(null).chatTarget).toEqual(state.chatTarget)
  })
})

describe('setChatTarget：作用域', () => {
  it('在非焦点会话上选模型：只写那条会话，不动焦点标签的待发目标', () => {
    const { state, api, slice, conversationOf } = makeStore()
    const setChatTarget = slice.setChatTarget as (
      target: { backend: string; configId: string; modelId: string },
      scope?: string | null
    ) => void

    // 模拟「在 B 标签的下拉里从 model-b 换成 model-a」
    setChatTarget({ backend: 'builtin', configId: 'cfg-a', modelId: 'model-a' }, OTHER)

    // 全局那份（焦点会话 A 的现场）不动
    expect(state.chatTarget).toEqual({
      backend: 'builtin',
      configId: 'cfg-a',
      modelId: 'model-a'
    })
    // B 自己那条被改（乐观写本地清单，pill 立刻生效；同时落盘）
    expect(conversationOf(OTHER).configId).toBe('cfg-a')
    expect(conversationOf(OTHER).modelId).toBe('model-a')
    expect(api.setConversationTarget).toHaveBeenCalledWith(OTHER, {
      backend: 'builtin',
      configId: 'cfg-a',
      modelId: 'model-a'
    })
    // 焦点会话 A 的清单项不能被顺手改掉
    expect(conversationOf(FOCUS).modelId).toBe('model-a')
  })

  it('不传 scope 时行为不变：写全局那份 + 落焦点会话', () => {
    const { state, api, slice } = makeStore()
    const setChatTarget = slice.setChatTarget as (target: {
      backend: string
      configId: string
      modelId: string
    }) => void

    setChatTarget({ backend: 'builtin', configId: 'cfg-b', modelId: 'model-b' })

    expect(state.chatTarget).toEqual({
      backend: 'builtin',
      configId: 'cfg-b',
      modelId: 'model-b'
    })
    expect(api.setConversationTarget).toHaveBeenCalledWith(
      FOCUS,
      expect.objectContaining({ configId: 'cfg-b', modelId: 'model-b' })
    )
  })
})

describe('setMcpServerIds：作用域', () => {
  it('非焦点会话只改自己的清单', () => {
    const { state, slice, conversationOf } = makeStore()
    const setMcpServerIds = slice.setMcpServerIds as (
      ids: string[],
      scope?: string | null
    ) => void

    setMcpServerIds(['mcp-files'], OTHER)

    expect(state.mcpServerIds).toEqual([])
    expect(conversationOf(OTHER).mcpServerIds).toEqual(['mcp-files'])
  })
})
