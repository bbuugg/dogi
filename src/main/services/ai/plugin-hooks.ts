/**
 * **AI 工具钩子**（对齐 fishwork 的 plugin `tool:call` / `tool:result`）。
 *
 * 插件通过主进程入口注册钩子，宿主在每个工具执行的**前后**各留一个口子：
 *
 * ```
 * 工具调用 → [tool:call 钩子] →（可能被拦下）→ 真正执行 → [tool:result 钩子] → 回给模型
 * ```
 *
 * ## 三条硬规则
 *
 * 1. **钩子出错/超时一律当没挂**：插件是外部代码，一个死循环或未捕获的 rejection
 *    绝不能把整轮对话拖死。宿主统一 try/catch + 超时兜底，插件作者不必自己包。
 * 2. **拦截不抛错**：被拦下的工具返回的是「一句拒绝理由」而不是异常 —— 同 `guardWrite`。
 *    抛错会让模型看到一个工具故障，而这里要表达的是「这一步不该做，换个做法」。
 * 3. **多个插件按注册顺序串行跑**：`tool:call` 上**任一**插件说拦就拦（拦下即短路，
 *    后面的钩子不再跑）；`tool:result` 上后一个插件拿到的是前一个改过的结果（可叠加）。
 *
 * 插件没声明 `hooks` 权限时根本注册不上（见 plugins/host.ts 的 buildMainApi）。
 */
import type {
  PluginHookEvent,
  PluginToolCallEvent,
  PluginToolCallVerdict,
  PluginToolResultEvent,
  PluginToolResultVerdict
} from '@shared/plugin'

/** 单个钩子的超时：超过就跳过它（正常钩子是纯计算 / 一次本地查表，用不了这么久） */
const HOOK_TIMEOUT_MS = 5000

type CallHook = (event: PluginToolCallEvent) => unknown
type ResultHook = (event: PluginToolResultEvent) => unknown

/** 超时包一层：返回 undefined 表示「没在时限内给出结论」，调用方按「没挂」处理 */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), ms)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

class PluginHookRegistry {
  /** 用 Map 而不是数组：按插件 id 去重，插件重载时不会留下上一版的钩子 */
  private callHooks = new Map<string, CallHook>()
  private resultHooks = new Map<string, ResultHook>()

  /** 有没有插件挂了钩子 —— 没有时整个钩子链路零开销（每个工具调用都要问一次） */
  get active(): boolean {
    return this.callHooks.size > 0 || this.resultHooks.size > 0
  }

  /**
   * 挂一个钩子（同一插件同一事件重复挂 = 覆盖）。
   *
   * 刻意**不做重载签名**（`event` 决定 handler 类型）：重载会让调用方拿到一个
   * 联合类型的 handler 参数，实际用起来到处要断言。这里用一次 `as` 换调用方干净。
   */
  register(pluginId: string, event: PluginHookEvent, hook: CallHook | ResultHook): void {
    if (event === 'tool:call') this.callHooks.set(pluginId, hook as CallHook)
    else this.resultHooks.set(pluginId, hook as ResultHook)
  }

  /** 插件被禁用 / 卸载 / 重载：连钩子一起摘掉（否则旧代码还在拦工具） */
  clearPlugin(pluginId: string): void {
    this.callHooks.delete(pluginId)
    this.resultHooks.delete(pluginId)
  }

  clearAll(): void {
    this.callHooks.clear()
    this.resultHooks.clear()
  }

  /**
   * 执行前的钩子。返回 `null` = 放行；返回字符串 = 被拦下，字符串是给模型看的理由。
   *
   * 短路语义：第一个说拦的插件就定了，后面的钩子不再跑 —— 都拦下了还去问别人
   * 既没意义，也让「谁拦的」变得说不清。
   */
  async runCall(event: PluginToolCallEvent): Promise<{ reason: string; pluginId: string } | null> {
    for (const [pluginId, hook] of this.callHooks) {
      try {
        const verdict = (await withTimeout(
          Promise.resolve(hook(event)),
          HOOK_TIMEOUT_MS
        )) as PluginToolCallVerdict | undefined
        if (!verdict?.block) continue
        const reason = verdict.reason?.trim()
        return {
          pluginId,
          reason: reason || `（被插件 ${pluginId} 拦下，未说明原因）`
        }
      } catch (err) {
        console.warn(`[plugin:${pluginId}] tool:call 钩子出错，已跳过：`, err)
      }
    }
    return null
  }

  /**
   * 执行后的钩子。返回 `null` = 结果不变；返回字符串 = 用插件改写后的结果替换。
   *
   * ⚠️ 只接受**字符串**返回值：工具结果有字符串也有结构化对象，插件回一个对象
   * 去替换字符串结果会把下游（渲染端的 tool-result 卡片）弄坏。想改结构化结果，
   * 先自己 JSON.stringify —— 这个门槛是刻意留的。
   */
  async runResult(event: PluginToolResultEvent): Promise<{ result: string; pluginId: string } | null> {
    let current = event.result
    let last: { result: string; pluginId: string } | null = null
    for (const [pluginId, hook] of this.resultHooks) {
      try {
        const verdict = (await withTimeout(
          Promise.resolve(hook({ ...event, result: current })),
          HOOK_TIMEOUT_MS
        )) as PluginToolResultVerdict | undefined
        if (typeof verdict?.result !== 'string') continue
        current = verdict.result
        last = { result: verdict.result, pluginId }
      } catch (err) {
        console.warn(`[plugin:${pluginId}] tool:result 钩子出错，已跳过：`, err)
      }
    }
    return last
  }
}

export const pluginHooks = new PluginHookRegistry()
