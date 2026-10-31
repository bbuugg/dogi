/**
 * 回归：**视图边界上，动作必须带着「本标签的会话」下去**。
 *
 * ## 防的是什么
 *
 * 用户报的现象：分屏两个标签、各用不同模型，点哪个标签两个模型 pill 就一起变成哪个。
 * 根因在 store 里的「焦点会话 == 唯一一份现场」假设 —— 详见 `agentAppFrom` 的说明。
 *
 * store 那层已经改成了按会话取（`scopedSettingsOf` + 各动作的 `scope` 参数）；这一层
 * 钉住的是**投影时真的把 id 传下去了**：漏掉任何一个，界面看着正常、分屏时就会把
 * 消息 / 停止 / 队列 / 签出作用到焦点标签上。
 *
 * 这里只测投影函数本身（纯函数，不渲染 hook），store 用 Proxy 假件：读到的每个方法
 * 都是记录调用的桩，于是「传了什么参数」一目了然。
 */
import { describe, expect, it } from 'vitest'
import type { AgentStore } from '@fizz/agent-kit/shared/lib/stores/agent-store'
import { agentAppFrom } from './useAgentApp'

const VIEW = 'conv-b'

/** 这个视图的现场（非焦点会话 → 按它自己那条会话派生出来的那份） */
const SCOPED = {
  chatTarget: {
    configId: 'cfg-b',
    modelId: 'model-b',
    backend: 'builtin' as const
  },
  reasoningEffort: 'high',
  mcpServerIds: ['mcp-x'],
  browserSettings: null
}

function makeStore() {
  const calls: Array<{ fn: string; args: unknown[] }> = []
  const overrides: Record<string, unknown> = {
    // 投影时会就地查表 / 迭代的几个集合：给空的真数组，别让 stub 顶上去
    slices: {},
    conversations: [],
    workspaces: [],
    models: [],
    acpAgents: [],
    mcpServers: [],
    runningConversations: {},
    defaultBrowserSettings: null,
    getApi: () => ({}),
    scopedSettingsOf: () => SCOPED
  }
  const store = new Proxy(
    {},
    {
      get(_target, key: string) {
        if (key in overrides) return overrides[key]
        // 其余一律当「记录调用」的桩：`app.send(...)` → stub('send', args)
        return (...args: unknown[]) => {
          calls.push({ fn: key, args })
        }
      }
    }
  ) as unknown as AgentStore

  const argsOf = (fn: string): unknown[] => {
    const hit = calls.find((c) => c.fn === fn)
    if (!hit) throw new Error(`没有调用 ${fn}`)
    return hit.args
  }
  return { store, argsOf, calls }
}

describe('agentAppFrom：读的是本视图那条会话的现场', () => {
  it('模型 / 思考强度 / MCP 取 scoped 那份，不是全局那份', () => {
    const { store } = makeStore()
    const app = agentAppFrom(store, VIEW)

    expect(app.chatTarget).toEqual(SCOPED.chatTarget)
    expect(app.reasoningEffort).toBe('high')
    expect(app.mcpServerIds).toEqual(['mcp-x'])
  })

  it('activeConversationId 就是本视图的会话（标签内「我是不是当前会话」的判断才不会错）', () => {
    const { store } = makeStore()
    expect(agentAppFrom(store, VIEW).activeConversationId).toBe(VIEW)
  })
})

describe('agentAppFrom：写动作带上本视图的 id', () => {
  it('改现场：setter 都带视图 id', () => {
    const { store, argsOf } = makeStore()
    const app = agentAppFrom(store, VIEW)

    app.setChatTarget(SCOPED.chatTarget)
    app.setReasoningEffort('low')
    app.setMcpServerIds(['mcp-y'])

    expect(argsOf('setChatTarget')[1]).toBe(VIEW)
    expect(argsOf('setReasoningEffort')[1]).toBe(VIEW)
    expect(argsOf('setMcpServerIds')[1]).toBe(VIEW)
  })

  it('发送 / 停止 / 插话带视图 id（否则非焦点标签发的消息插进焦点会话）', () => {
    const { store, argsOf } = makeStore()
    const app = agentAppFrom(store, VIEW)

    app.send('hi')
    app.stop()
    app.steer('插一句')

    // send(text, files, onStarted, scope)
    expect(argsOf('send')[3]).toBe(VIEW)
    // stop(scope)
    expect(argsOf('stop')[0]).toBe(VIEW)
    // steer(text, files, onStarted, scope)
    expect(argsOf('steer')[3]).toBe(VIEW)
  })

  it('队列 / 消息 / 签出 / 队列泵都带视图 id', () => {
    const { store, argsOf } = makeStore()
    const app = agentAppFrom(store, VIEW)

    app.pump()
    app.sendQueuedMessage('q1')
    app.deleteMessage('m1')
    app.forkConversation('m1')

    // pump(scope)
    expect(argsOf('pump')[0]).toBe(VIEW)
    // sendQueuedMessage(id, scope)
    expect(argsOf('sendQueuedMessage')[1]).toBe(VIEW)
    // deleteMessage(messageId, scope)
    expect(argsOf('deleteMessage')[1]).toBe(VIEW)
    // forkConversation(upToMessageId, opts, scope)
    expect(argsOf('forkConversation')[2]).toBe(VIEW)
  })
})

describe('agentAppFrom：新对话页', () => {
  it('id 为 null 时把 null 传下去（建新会话），不回落到焦点会话', () => {
    const { store, argsOf } = makeStore()
    const app = agentAppFrom(store, null)

    app.send('hi')
    expect(argsOf('send')[3]).toBeNull()
    expect(app.activeConversationId).toBeNull()
  })
})
