/**
 * 「当前插件 Context」——精简版的 Cordis `Context.current`。
 *
 * 为什么需要它：`ctx.tools.register(...)` 这类调用返回的 disposer，必须能被记到
 * **发起注册的那个插件实例**头上（而不是记到「提供 tools 服务的 turn Context」头上），
 * 否则 `fork.dispose()` 就回收不掉这个插件加的工具。
 *
 * 做法：`applyPlugin` 在跑插件 `apply` 期间把 CURRENT 指到该插件的 fiber，
 * 服务方法把 disposer 交给 `bindEffect` —— 它会优先记到 CURRENT（若有），
 * 否则记到「服务所属的 Context」。两条路径都在 `dispose()` 的 LIFO 链上，
 * 所以 turn 重建时一样会被回收。
 */
import type { Context } from './context'
import type { Dispose } from './types'

let CURRENT: Context | null = null

/** 当前正在 apply 的插件 fiber；不在插件 apply 期间则为 null */
export function currentContext(): Context | null {
  return CURRENT
}

/** 在「CURRENT = ctx」的作用域里跑 `fn`，跑完恢复（支持嵌套） */
export function withContext<T>(ctx: Context, fn: () => T): T {
  const prev = CURRENT
  CURRENT = ctx
  try {
    return fn()
  } finally {
    CURRENT = prev
  }
}

/**
 * 把 `disposer` 绑到「当前插件 fiber」（有的话）或 `owner` 上，返回幂等的提前回收器。
 */
export function bindEffect(owner: Context, disposer: Dispose): Dispose {
  return (CURRENT ?? owner)._pushEffect(disposer)
}