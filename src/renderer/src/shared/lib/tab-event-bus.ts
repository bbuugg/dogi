/**
 * 标签页关闭协议：**页面主导的确认 + 回执**。
 *
 * 用户入口一律走 `store.requestClosePanelTab`（× / 右键菜单 / Ctrl+W / 关闭整个组
 * 都汇到它），链路是：
 *
 *   用户点关闭
 *     → store.requestClosePanelTab
 *     → requestTabClose({ tabId, groupId, title })          ← 本模块
 *     → 总线依次 await 页面注册的 `close-guard`
 *         页面在**标签内部**判断（未保存改动 / 运行中），需要问就调 `ctx.confirm(...)`
 *         返回 `{ allow, owned }`：
 *           allow=false            → 拦下，标签原样留着
 *           allow=true + owned     → 放行，且**这次确认由页面负责**（不管有没有真弹窗）
 *           allow=true（无 owned） → 放行，页面没接管 → shell 的 `close-fallback` 兜底问一句
 *     → 全部放行 → 真正关闭（executor 由 store 注入，见 `setTabCloseExecutor`）
 *
 * 四条硬约束（改这个模块时别破坏）：
 *
 * 1. **fail closed**：guard 抛错 = 拦下 + 报错，**绝不静默放行**。这个模块存在的意义
 *    就是别丢用户的数据，宁可关不掉也不能悄悄关掉。（旧实现在 catch 里 `return true`，
 *    笔记保存逻辑一出错就静默丢草稿 —— 方向反了。）
 * 2. **没有总线就不关**：总线由 `TabContentGuard` 在标签内容挂载时创建。查不到总线
 *    意味着「没有任何页面能对这次关闭表态」，此时放行等于绕过全部确认。正常不会发生
 *    （`PaneTree` 递归渲染每个叶子组、组内标签全部保活挂载，见 PanelView），
 *    所以它一旦出现就是异常，按 `unmounted` 拒掉并让调用方提示用户。
 * 3. **不抢焦点**：确认框由**组级宿主**提供（`registerCloseHost` / `closeHosts`），
 *    与「哪个标签是激活的」无关。旧实现要先 `activatePanelTab` 再 `setTimeout(50)`
 *    等 React 摘掉 `hidden` —— 那是在赌渲染时序（慢机器上确认框留在 `hidden` 里，
 *    关闭静默卡死），而且批量关闭时标签条会挨个闪过去。
 * 4. **本模块不 import store**（会与 app-store 成环）：注册表都是模块级 Map，
 *    「真正执行关闭」由 store 经 `setTabCloseExecutor` 注入。
 *
 * 关于 `owned` 与「防手滑」的分工：`owned` 表达的是「**谁负责这次确认**」，不是
 * 「有没有弹过窗」。笔记 / Agent 无论脏不脏都返回 `owned: true`（它们的关闭确认由
 * 自己全权负责，干净时直接放行、不需要再问一句）；终端 / 脚本 / 插件等页面不注册
 * guard，于是由 shell 的 `close-fallback` 兜底问一次「确定关闭标签「x」？」。
 * 旧实现用一个写死的类型白名单（`PAGE_MANAGED_CLOSE_TYPES`）来区分这两类页面，
 * 新增页面时漏加就弹两次窗 —— 现在这个事实由页面自己在返回值里声明。
 */
import type { InlineConfirmFn } from '@/shared/components/InlineConfirm'

/**
 * 页面在标签内部做完判断后的**裁决**。
 */
export interface CloseDecision {
  /** 是否允许关闭 */
  allow: boolean
  /**
   * 这次关闭的确认**由页面负责**（我已判断过，无论有没有真的弹窗）——
   * shell 的通用防手滑确认据此让位，避免同一件事问两遍。
   * 缺省 false：页面没接管，由 shell 兜底问一句。
   */
  owned?: boolean
}

/** 关闭时交给页面 guard 的上下文 */
export interface CloseContext {
  /**
   * 画在**组面板内**的确认框。页面在 guard 里 `await ctx.confirm({...})` 即可，
   * 不必自己持有确认框组件 —— 这样关闭非激活标签时它也是可见可点的。
   */
  confirm: InlineConfirmFn
  /** 标签显示名（自定义标题优先），确认文案用 */
  title: string
}

/** 页面的关闭判断函数：返回 false 阻止关闭；可以是 async */
export type CloseGuard = (ctx: CloseContext) => CloseDecision | Promise<CloseDecision>

/**
 * 一次关闭请求的结果。
 *
 * `rejected` 是**用户自己的选择**（点了取消），调用方不必再打扰他；
 * 其余三种都是「关不掉」，必须让用户知道 —— 否则会表现为「点了 × 没反应」。
 */
export type CloseResult =
  | { allow: true }
  | { allow: false; reason: 'rejected' }
  /** 标签内容或它的组面板还没挂载：没有任何人能对这次关闭表态（见模块头第 2 条） */
  | { allow: false; reason: 'unmounted' }
  /** guard 抛错或返回了非法裁决：按 fail closed 拦下（见模块头第 1 条） */
  | { allow: false; reason: 'guard-error'; detail: string }

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** guard 的执行结果：要么给出裁决，要么给出「它坏了」 */
type GuardOutcome = { decision: CloseDecision } | { failed: string }

class TabEventBus {
  /** 页面注册的状态确认（未保存 / 运行中） */
  private guards: CloseGuard[] = []
  /** shell 注册的兜底防手滑（只在没有任何页面 `owned` 时跑） */
  private fallbacks: CloseGuard[] = []

  constructor(private readonly tabId: string) {}

  /** 注册页面级确认；返回注销函数 */
  onGuard(guard: CloseGuard): () => void {
    this.guards.push(guard)
    return () => {
      const i = this.guards.indexOf(guard)
      if (i !== -1) this.guards.splice(i, 1)
    }
  }

  /** 注册 shell 级兜底确认；返回注销函数 */
  onFallback(fallback: CloseGuard): () => void {
    this.fallbacks.push(fallback)
    return () => {
      const i = this.fallbacks.indexOf(fallback)
      if (i !== -1) this.fallbacks.splice(i, 1)
    }
  }

  /** 跑一个 guard：抛错 / 返回垃圾值都算「它坏了」，由调用方按 fail closed 处理 */
  private async runGuard(guard: CloseGuard, ctx: CloseContext): Promise<GuardOutcome> {
    try {
      const decision = await guard(ctx)
      if (!decision || typeof decision.allow !== 'boolean') {
        return { failed: 'guard 没有返回合法的 CloseDecision（缺 allow）' }
      }
      return { decision }
    } catch (err) {
      return { failed: describeError(err) }
    }
  }

  /**
   * 请求关闭：先跑页面 guard，再按需跑 shell 兜底，全放行才真正关闭。
   *
   * ⚠️ 两个循环都在**快照**上迭代：guard 内部可能触发状态变化导致注销（例如页面
   * 在确认后自己关掉了标签），直接遍历原数组会漏项 / 错项。
   */
  async requestClose(ctx: CloseContext): Promise<CloseResult> {
    let owned = false

    for (const guard of [...this.guards]) {
      const outcome = await this.runGuard(guard, ctx)
      if ('failed' in outcome) return { allow: false, reason: 'guard-error', detail: outcome.failed }
      if (outcome.decision.owned) owned = true
      if (!outcome.decision.allow) return { allow: false, reason: 'rejected' }
    }

    // 页面没接管这次确认 → shell 兜底问一句（防手滑）。
    // 注意：页面**拦下**时不会走到这里 —— 关闭已经被否决，再问防手滑毫无意义。
    if (!owned) {
      for (const fallback of [...this.fallbacks]) {
        const outcome = await this.runGuard(fallback, ctx)
        if ('failed' in outcome) return { allow: false, reason: 'guard-error', detail: outcome.failed }
        if (!outcome.decision.allow) return { allow: false, reason: 'rejected' }
      }
    }

    closeExecutor?.(this.tabId)
    return { allow: true }
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

/** 取（或创建）某条标签的总线。幂等。 */
export function getTabBus(tabId: string): TabEventBus {
  let bus = tabBuses.get(tabId)
  if (!bus) {
    bus = new TabEventBus(tabId)
    tabBuses.set(tabId, bus)
  }
  return bus
}

/** 释放某条标签的总线（由所有者 `TabContentGuard` 在 unmount 时调用） */
export function releaseTabBus(tabId: string): void {
  tabBuses.delete(tabId)
}

/** 这条标签有没有总线（= 它的内容挂载了吗）。供探针与调试用。 */
export function hasTabBus(tabId: string): boolean {
  return tabBuses.has(tabId)
}

// ---------------------------------------------------------------------------
// 组级关闭确认宿主
// ---------------------------------------------------------------------------

/**
 * 每个**面板组**一个确认框（`PanelGroupView` 用 `useInlineConfirm()` 建好后注册）。
 * 按 `groupId` 而不是 `tabId` 存：关闭确认要能在**非激活标签**上弹出来，
 * 挂在组上就与激活状态无关了（见模块头第 3 条）。
 */
const closeHosts = new Map<string, InlineConfirmFn>()

/** 注册组级确认宿主；返回注销函数（可直接当 `useEffect` 的清理） */
export function registerCloseHost(groupId: string, confirm: InlineConfirmFn): () => void {
  closeHosts.set(groupId, confirm)
  return () => {
    // 只删自己注册的那份：组重建时新宿主可能已经写进来了
    if (closeHosts.get(groupId) === confirm) closeHosts.delete(groupId)
  }
}

/** 取某组的确认宿主；返回 undefined = 这个组的面板还没挂载 */
export function getCloseHost(groupId: string): InlineConfirmFn | undefined {
  return closeHosts.get(groupId)
}

/**
 * 请求关闭一个标签：触发该标签总线上注册的 `close-guard` 做内部确认，
 * 全部放行后真正关闭。
 *
 * 调用方（store）负责把 `rejected` 之外的失败原因告诉用户 —— 静默失败会表现成
 * 「点了 × 没反应」。
 */
export function requestTabClose(req: {
  tabId: string
  groupId: string
  /** 标签显示名（自定义标题优先），确认文案用 */
  title: string
}): Promise<CloseResult> {
  const bus = tabBuses.get(req.tabId)
  const confirm = closeHosts.get(req.groupId)
  if (!bus || !confirm) return Promise.resolve({ allow: false, reason: 'unmounted' })
  return bus.requestClose({ confirm, title: req.title })
}
