/**
 * 钩子（hook）：插件**改写** Agent 行为的地方 —— 与 `ctx.events` 的「只通知、不干预」互补。
 *
 * 两种形态：
 * - **waterfall（拦截改写）**：监听器签名 `(...args, next)`。范式是
 *   `const out = next(); return 改写(out)`（around 中间件：先放行、拿下游结果再加工），
 *   也可以不调 `next()` 直接返回一个值**中断链路**（后面的监听器与兜底都不再跑）。
 *   ⚠️ 框架的 `next(新值)` **不会**把新值传给下一个监听器（`waterfall` 恒以**原始 args**
 *   调用链上的下一个），所以「按入参把新值往后推」这条陆走不通 —— 想串联改写一律用
 *   around 范式。见 Context.waterfall 的实现注释。
 * - **emit（只通知）**：`turn:start` / `turn:finish` 这类生命周期事件，参数是一个对象。
 *
 * 归属（与 `ctx.tools` 完全同款，是本模块存在的理由）：`hooks` 服务由 `buildAgentSetup`
 * 建在 **turn context** 上，插件 `ctx.hooks.on(...)` 注册的监听器因此落在 turn context、
 * 能被同一轮的 `waterfall` / `emit` 看见；而 disposer 经 `bindEffect` 记在**插件 fiber** 上，
 * 插件卸载 / 下一轮重建时自动摘掉。
 * （对比：`ctx.events` 的实体是 **fiber-local** 的，在插件 fiber 上注册的监听器父层看不见。）
 */
import { EventsService } from './services/events'

/** 钩子名（用常量，避免各处手写字符串拼错） */
export const HOOKS = {
  /** 工具调用前：参数 `(toolName, input)`，可改写成新的 input */
  toolCall: 'tool:call',
  /** 工具返回后：参数 `(toolName, output)`，可改写成新的 output */
  toolResult: 'tool:result',
  /** 系统提示词渲染完成后：参数 `(text)`，可改写成新的正文 */
  promptRender: 'prompt:render',
  /** 一轮开始（emit，参数 `TurnStartPayload`） */
  turnStart: 'turn:start',
  /** 一轮收尾（emit，参数 `TurnFinishPayload`） */
  turnFinish: 'turn:finish'
} as const

export type HookName = (typeof HOOKS)[keyof typeof HOOKS]

/**
 * `waterfall` 的兜底：取出「被改写的主体」。约定 —— 钩子带两个及以上参数时，
 * **第 2 个**是主体（第 1 个是名字之类的标识）；只有一个参数时它就是主体。
 * 这样兜底既接得住 `fallback(name, payload)`，也接得住监听器 `next(payload)` 的单参形态。
 */
export function hookValue(...args: unknown[]): unknown {
  return args.length >= 2 ? args[1] : args[0]
}

/** `tool:call` 监听器：`next()` 拿到下游决定的入参 */
export type ToolCallListener = (toolName: string, input: unknown, next: () => unknown) => unknown
/** `tool:result` 监听器：`next()` 拿到下游决定的返回 */
export type ToolResultListener = (toolName: string, output: unknown, next: () => unknown) => unknown
/** `prompt:render` 监听器：`next()` 拿到下游决定的正文 */
export type PromptRenderListener = (text: string, next: () => unknown) => unknown

export interface TurnStartPayload {
  turnId: string
  workspaceId: string
  workspaceName: string
}

export interface TurnFinishPayload {
  turnId: string
  finishReason: string
  usage?: unknown
}

export type TurnStartListener = (payload: TurnStartPayload) => void
export type TurnFinishListener = (payload: TurnFinishPayload) => void

/**
 * 钩子总线：`ctx.hooks` 的实体。行为完全委托给所属 Context（与 `EventsService` 同），
 * 只是服务名不同 —— 让插件能 `inject: ['hooks']` 声明依赖，也便于测试给替身。
 */
export class HooksService extends EventsService {
  get name(): string {
    return 'hooks'
  }
}