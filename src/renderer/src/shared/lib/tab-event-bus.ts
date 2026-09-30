/**
 * 标签页事件总线 + 按标签注册表。
 *
 * 每个放入 PanelView 的标签内容共享一条 `TabEventBus`（注册表按 tabId 持有，
 * 由 `PanelView` 的 `TabContentGuard` 在 mount 时创建、unmount 时释放并传入）。
 *
 * 关闭走「推送 + 回执」模型，方向是页面主导：
 *
 *   用户点关闭 → store.requestClosePanelTab → requestTabClose(tabId)
 *     → bus.emit('close-request')：页面（及 shell 的防手滑层）注册的 handler
 *       依次执行，在**标签面板内部**完成状态确认（未保存改动 / 运行中 / 防手滑）；
 *       任一返回 false → 中止，标签原样留着
 *     → 全部放行 → bus.emit('close') → 注册表预接的监听 → closeExecutor
 *       （store 启动时经 `setTabCloseExecutor` 注入 `closePanelTab`）→ 真正关闭
 *
 * 设计要点：
 * - **纯客户端**：不经过 IPC、不进 store（注册表是模块级 Map）。本模块**不反向
 *   import store**（会与 app-store 成环），「真正执行关闭」由 store 注入 executor。
 * - **多 handler**：`close-request` 可挂多个 handler（页面一个 + 防手滑一个），
 *   按注册顺序逐一 await，任一返回 false 即阻止关闭 —— 单槽位互相覆盖的旧实现
 *   已废弃（页面级 guard 曾被父层通用 guard 覆盖成死代码）。
 * - **生命周期跟随标签**：标签销毁时由 `TabContentGuard` 释放；标签跨组移动是
 *   卸载重挂，总线随之重建，页面 handler 在重挂时重新注册。
 */
export class TabEventBus {
  private handlers: Record<string, Array<(...args: unknown[]) => unknown>> = {}

  /** 注册事件监听器，返回取消注册的函数 */
  on(event: string, handler: (...args: unknown[]) => unknown): () => void {
    if (!this.handlers[event]) this.handlers[event] = []
    this.handlers[event].push(handler)
    return () => {
      const arr = this.handlers[event]
      if (!arr) return
      const idx = arr.indexOf(handler)
      if (idx !== -1) arr.splice(idx, 1)
    }
  }

  /** 触发事件，按注册顺序调用所有 handler，返回所有结果的数组 */
  emit(event: string, ...args: unknown[]): unknown[] {
    const arr = this.handlers[event]
    if (!arr) return []
    return arr.map((fn) => {
      try {
        return fn(...args)
      } catch {
        return undefined
      }
    })
  }

  /**
   * 「关闭请求」确认：调用所有 `close-request` handler，任一返回 `false` 即阻止。
   * handler 可以是同步或异步（返回 Promise）。
   */
  async canClose(): Promise<boolean> {
    const arr = this.handlers['close-request']
    if (!arr || arr.length === 0) return true
    for (const fn of arr) {
      try {
        const result = await fn()
        if (result === false) return false
      } catch {
        // handler 报错不阻止关闭（与「没注册」同等对待）
      }
    }
    return true
  }

  /**
   * 请求关闭：先过 `close-request` 确认，全部放行才 emit `close`
   * （由注册表接住转给 executor 真正关闭）。返回是否放行。
   */
  async requestClose(): Promise<boolean> {
    if (!(await this.canClose())) return false
    this.emit('close')
    return true
  }

  /** 是否有 handler 注册了指定事件 */
  hasHandler(event: string): boolean {
    return !!this.handlers[event]?.length
  }
}

// ---------------------------------------------------------------------------
// 按 tabId 的总线注册表
// ---------------------------------------------------------------------------

const tabBuses = new Map<string, TabEventBus>()

/** 「真正执行关闭」的回调，由 store 在启动时注入（本模块不反向依赖 store） */
let closeExecutor: ((tabId: string) => void) | null = null

export function setTabCloseExecutor(fn: (tabId: string) => void): void {
  closeExecutor = fn
}

/** 取（或创建）某条标签的总线。幂等；创建时接好 `close` → executor 的回执。 */
export function getTabBus(tabId: string): TabEventBus {
  let bus = tabBuses.get(tabId)
  if (!bus) {
    bus = new TabEventBus()
    bus.on('close', () => closeExecutor?.(tabId))
    tabBuses.set(tabId, bus)
  }
  return bus
}

/** 释放某条标签的总线（由所有者 `TabContentGuard` 在 unmount 时调用） */
export function releaseTabBus(tabId: string): void {
  tabBuses.delete(tabId)
}

/**
 * 请求关闭一个标签：触发该标签总线上注册的 `close-request` handler 做内部确认，
 * 全部放行后 emit `close` 真正关闭。返回是否放行。
 * 总线不存在（页面尚未挂载的窗口期）时没有可确认的状态，直接执行关闭。
 */
export async function requestTabClose(tabId: string): Promise<boolean> {
  const bus = tabBuses.get(tabId)
  if (!bus) {
    closeExecutor?.(tabId)
    return true
  }
  return bus.requestClose()
}
