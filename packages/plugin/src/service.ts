/**
 * 服务基类：一个「挂在 Context 上、有自己生命周期」的东西（工具注册表 / 提示词注册表 /
 * 事件总线 / UI 声明表）。
 *
 * 约定（精简版的全部约束）：
 * - 子类**不要在构造函数里做副作用**——构造函数只保存 ctx；副作用一律经 `this.bind(...)`
 *   登记，会在卸载时按 LIFO 自动回收；
 * - 子类覆盖的 `dispose()` 会在容器卸载时调用，用来释放非 effect 管理的资源。
 */
import type { Context } from './context'
import { bindEffect } from './scope'
import type { Dispose } from './types'

export abstract class Service {
  constructor(protected readonly ctx: Context) {}

  /** 服务名（取自「提供它的 key」由容器负责；这里给个默认，子类可覆盖） */
  get name(): string {
    return this.constructor.name
  }

  /**
   * 在当前 Context 上登记一个可回收副作用（见 `Context.effect`）。
   * 返回的 disposer 可手动提前回收（幂等）。
   */
  protected effect(fn: () => void | Dispose): Dispose {
    return this.ctx.effect(fn)
  }

  /**
   * 把「注册项」的 disposer 绑到发起注册的插件 fiber 上（不在插件里则绑到服务所属 Context）——
   * 这样 `fork.dispose()` 能回收本插件加的工具 / 提示词段 / UI 声明。
   */
  protected bind(disposer: Dispose): Dispose {
    return bindEffect(this.ctx, disposer)
  }
}