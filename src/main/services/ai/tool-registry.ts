/**
 * AI 工具注册表：终端 AI 助手与工作区 Agent **共用**的工具目录。
 *
 * 背景：两条 AI 线统一到同一个对话引擎（`services/ai/agent.ts`）之后，
 * 工具不能再各自现场拼装 —— 内置工具（终端操作 / 工作区文件 / 浏览器 / 技能 /
 * 提问）在启动时**注册**成静态定义，客户端工具（渲染端执行，见 client-tools.ts）
 * 作为动态提供方在每次组装时并入，MCP 工具仍按现成 ToolSet 注入。
 * 一次对话用哪些工具，由 `buildToolset` 按作用域统一决定。
 *
 * 两层分离：
 * - `AiToolDef` 只描述「这个工具是什么、怎么执行」，不持有任何一次对话的状态；
 *   过去靠闭包注入的 requestId / 工作区 / 终端会话等，全部改为 `ToolRunContext`
 *   在**每次执行时**注入 —— 工具集可以跨轮复用，状态归服务层。
 * - `buildToolset` 负责按作用域过滤、动态可用性（技能 / 浏览器让位）、
 *   客户端工具并入（定义随请求携带）、MCP 同名让位，产出 ai-sdk 认的 `ToolSet`。
 */
import { jsonSchema, tool, type ToolSet } from 'ai'
import { z } from 'zod'
import type { AgentWorkspace, ConfirmDecision } from '@shared/types'
import type { AgentFileState, AgentPermissionMode, AgentSkill } from './agent-core'
import { appendSteer } from './steer'
import { pluginHooks } from './plugin-hooks'

/** 对话作用域：决定哪些工具进入这一轮的工具集 */
export type ToolScope = 'workspace' | 'terminal'

/**
 * 子 Agent 种类。两者都是**只读**角色（白名单见 sub-agent.ts）：
 * - `explorer`：探索 —— 「这个功能在哪几个文件里」「调用链是怎样的」；
 * - `reviewer`：评审 —— 「这段改动有什么问题」。
 *
 * 与 fishwork 的 explorer / reviewer 对齐；差别在于 dogi 的子 Agent 没有独立会话，
 * 它只是父 Agent 的一次工具调用（结果以文本回填）。
 */
export type SubAgentKind = 'explorer' | 'reviewer'

/**
 * 子 Agent 执行器：由 agentService **在设置开启时**注入到 `ToolRunContext`。
 * 缺省不注入 → `delegate` 工具整体不暴露（见 builtin-tools 里 `delegate` 的 available）。
 *
 * ⚠️ 为什么是「注入执行器」而不是让 `delegate` 工具自己去 new 一个 Agent：
 * 子 Agent 要用**当前这一轮的模型配置**（config / modelId / temperature / maxTokens），
 * 这些只有 agentService 持有；工具定义（AiToolDef）按约定不捕获任何一次对话的状态。
 */
export interface SubAgentRunner {
  /** 本次可用的种类（留成函数是为了将来按模型能力收窄） */
  kinds(): readonly SubAgentKind[]
  /** 跑一个子 Agent，返回它的最终报告（纯文本）。失败应返回说明性文本而不是抛错 */
  run(req: { kind: SubAgentKind; task: string; toolCallId: string }): Promise<string>
}

/**
 * 一次**对话请求**的运行上下文：由 agentService 在每轮 chat 时构造，
 * 传给每个工具的 execute。过去两条线各拼一套闭包（requestId / confirm / 队列），
 * 现在统一从这里取。
 */
export interface ToolRunContext {
  requestId: string
  conversationId: string
  scope: ToolScope
  /** workspace 作用域：本轮绑定的工作区（工具只能在其内读写与执行命令） */
  workspace?: AgentWorkspace
  /** terminal 作用域：本轮工具绑定的终端会话（发起对话的那个终端页面） */
  targetSessionId?: string | null
  /** 本轮请求的中止信号 */
  signal: AbortSignal
  /** 权限模式：full 全放开 / confirm 改动前请示 / readonly 直接拒绝改动类工具 */
  permissionMode: AgentPermissionMode
  /**
   * 确认请示入口（service 注入，已串行化）；上下文字段按来源可选。
   * 返回**四档裁决**（见 ConfirmDecision）—— 「总是允许 / 总是拒绝」的记忆由 service 持有，
   * 命中记忆时它不会再弹卡、直接回一个 once 档。
   */
  requestConfirm(req: {
    toolCallId: string
    toolName: string
    command: string
    /** 终端来源：目标会话与标题（确认卡展示用） */
    sessionId?: string
    sessionTitle?: string
  }): Promise<ConfirmDecision>
  /** workspace：会话级「先读后改」状态（read_file 记快照，write/edit 校验） */
  fileState?: AgentFileState
  /** workspace：本轮扫描到的可用技能 */
  skills?: AgentSkill[]
  /** workspace：Windows 上 execute_command 的 POSIX shell（Git Bash），null = 回退 PowerShell */
  bashPath?: string | null
  /** terminal：同一对话内工具执行的串行队列（前一条跑完下一条才开始） */
  queueToolExecution?: <T>(fn: () => Promise<T>) => Promise<T>
  /**
   * workspace：**命令实时输出的旁路**（execute_command 用，见 `tool-output-throttle.ts`）。
   *
   * 子进程 stdout / stderr 每来一块就回调一次，service 侧节流后包成 `tool-output-delta`
   * 事件下发给渲染端 —— 界面上运行中的命令卡因此能一帧帧看到输出。
   *
   * 不注入 = 行为与从前完全一致（只等命令跑完一次性拿到结果），所以终端作用域与子 Agent
   * 都不需要它。
   */
  onToolOutput?: (toolCallId: string, stream: 'stdout' | 'stderr', chunk: string) => void
  /**
   * workspace：子 Agent 执行器。**只在设置里开启子 Agent 时才注入** ——
   * 没注入时 `delegate` 工具不暴露（模型看不到就不会去用）。
   */
  subAgent?: SubAgentRunner
}

/**
 * 单个内置工具的静态定义。
 *
 * ⚠️ `execute` 必须是纯「输入 + ctx → 结果」的函数：**不要**在模块加载期或注册期
 * 捕获任何一次对话的状态（requestId / 会话绑定…），那些都在 ctx 上。
 */
export interface AiToolDef {
  name: string
  /** 描述依赖运行环境时（如 execute_command 的 shell 说明）用函数，每次组装现算 */
  description: string | ((ctx: ToolRunContext) => string)
  inputSchema: z.ZodType
  /** 哪个作用域能用：`both` 表示两边都进 */
  scope: ToolScope | 'both'
  /**
   * 动态可用性（缺省恒可用）：read_skill 无技能时不暴露、浏览器工具在 MCP
   * 带了同名 browser_* 工具时整体让位（两套同名会静默互相覆盖）。
   */
  available?: (info: { ctx: ToolRunContext; mcpToolNames: string[] }) => boolean
  /**
   * 执行。**闸门（权限模式 / 确认卡）在各自的 execute 里**：改动类工具要等预检通过
   * 才弹卡（guardWrite 在「确认也会失败」的检查之后才请示），包在注册层只会白白打扰用户；
   * 客户端工具没有主进程闸 —— 确认与拒绝都在渲染端按客户端权限设置处理。
   */
  execute(
    input: unknown,
    call: { toolCallId: string },
    ctx: ToolRunContext
  ): Promise<unknown>
}

class ToolRegistry {
  private defs = new Map<string, AiToolDef>()

  /** 注册一个内置工具。同名重复注册是编程错误，直接抛 */
  register(def: AiToolDef): void {
    if (this.defs.has(def.name)) {
      throw new Error(`AI 工具重复注册：${def.name}`)
    }
    this.defs.set(def.name, def)
  }

  registerAll(defs: AiToolDef[]): void {
    for (const def of defs) this.register(def)
  }

  unregister(name: string): void {
    this.defs.delete(name)
  }

  get(name: string): AiToolDef | undefined {
    return this.defs.get(name)
  }

  names(): string[] {
    return [...this.defs.keys()]
  }

  /**
   * 组装一次对话的 ToolSet。
   *
   * 顺序与让位规则（与两条线统一前保持一致，别改语义）：
   * 1. 内置静态定义（按作用域 + available 过滤）；
   * 2. 客户端工具（定义随请求携带）：**只补空缺，不覆盖内置** ——
   *    渲染端注册的工具与内置同名时视为配置错误，跳过并 warn；
   * 3. `extra`（MCP）最后展开，同名覆盖一切 —— 历史行为就是「MCP 覆盖内置」。
   */
  buildToolset(opts: {
    ctx: ToolRunContext
    /** 额外并入的现成 ToolSet（MCP 工具），排在最后 */
    extra?: ToolSet
    /**
     * 随请求携带的客户端工具（渲染端定义 + 执行器）。
     * **权限与确认全在渲染端**：主进程不做任何闸，直接把调用广播回去。
     */
    clientTools?: Array<{
      name: string
      description: string
      inputSchema?: Record<string, unknown>
      execute(input: unknown, call: { toolCallId: string }, ctx: ToolRunContext): Promise<unknown>
    }>
    /**
     * 只组装这些**内置**工具（缺省 = 全部符合作用域的）。子 Agent 的只读白名单用它。
     * ⚠️ 只过滤内置定义，不影响 `extra`（MCP）与 `clientTools` —— 子 Agent 两者都不传。
     */
    only?: readonly string[]
    /**
     * 是否在工具结果后拼接「运行中插话」（缺省 true）。
     *
     * ⚠️ 子 Agent **必须关掉**：插话是给父 Agent 的指令，而 `appendSteer` 是
     * 「取走」语义 —— 子 Agent 内部的某一步取走了它，父 Agent 就永远等不到了。
     */
    allowSteer?: boolean
  }): ToolSet {
    const { ctx, extra } = opts
    const allowSteer = opts.allowSteer !== false
    const only = opts.only ? new Set(opts.only) : null
    const mcpToolNames = Object.keys(extra ?? {})
    /** 组装期用无类型的桶，最后一次性断言成 ToolSet（工具形状由各定义保证） */
    const result: Record<string, unknown> = {}
    const taken = new Set<string>()

    /**
     * **所有工具的统一边界**（内置 / 客户端 / MCP 都走这里）：
     *
     * 1. `tool:call` 插件钩子 —— 任一插件说拦就拦，**拦下即短路**：不执行工具，
     *    把理由当成工具结果回给模型（同 guardWrite 的拒绝语义，不抛错）；
     * 2. 真正执行；
     * 3. `tool:result` 插件钩子 —— 可改写结果（仅字符串生效）；
     * 4. `appendSteer` —— 把用户「运行中插话」拼到结果后面（见 steer.ts）。
     *
     * ⚠️ 顺序不能换：钩子看到的是**原始结果**（脱敏类插件不该被插话文本污染），
     * 插话在最后加 —— 它是要模型**立刻照做**的，放最前面容易被前面的长文本淹掉。
     *
     * 钩子出错 / 超时在 registry 内部已兜住（当没挂），这里不必再包一层。
     */
    const invokeTool = async (
      name: string,
      input: unknown,
      run: () => Promise<unknown>
    ): Promise<unknown> => {
      const hooksOn = pluginHooks.active
      if (hooksOn) {
        const blocked = await pluginHooks.runCall({
          toolName: name,
          input,
          conversationId: ctx.conversationId,
          scope: ctx.scope,
          ...(ctx.workspace?.path ? { workspacePath: ctx.workspace.path } : {})
        })
        if (blocked) {
          console.warn(`[tool-registry] 工具 ${name} 被插件 ${blocked.pluginId} 拦下`)
          return `【这一步被插件拦下，未执行】${blocked.reason}`
        }
      }
      const raw = await run()
      let final = raw
      if (hooksOn) {
        const rewritten = await pluginHooks.runResult({
          toolName: name,
          input,
          result: raw,
          conversationId: ctx.conversationId,
          scope: ctx.scope
        })
        if (rewritten) final = rewritten.result
      }
      return allowSteer ? appendSteer(ctx.conversationId, final) : final
    }

    const warnConflict = (name: string, from: string): void => {
      if (taken.has(name)) {
        console.warn(`[tool-registry] 工具 ${name} 被 ${from} 覆盖（同名让位）`)
      }
    }

    for (const def of this.defs.values()) {
      if (def.scope !== 'both' && def.scope !== ctx.scope) continue
      if (only && !only.has(def.name)) continue
      if (def.available && !def.available({ ctx, mcpToolNames })) continue
      warnConflict(def.name, 'builtin')
      taken.add(def.name)
      result[def.name] = tool({
        description:
          typeof def.description === 'function' ? def.description(ctx) : def.description,
        inputSchema: def.inputSchema,
        execute: (input: unknown, options: { toolCallId: string }) =>
          invokeTool(def.name, input, () =>
            def.execute(input, { toolCallId: options.toolCallId }, ctx)
          )
      })
    }

    for (const def of opts.clientTools ?? []) {
      if (taken.has(def.name)) {
        console.warn(`[tool-registry] 客户端工具 ${def.name} 与内置工具同名，已忽略（内置优先）`)
        continue
      }
      taken.add(def.name)
      result[def.name] = tool({
        description: def.description,
        // 渲染端没给 schema 就按空对象入参（模型仍能调用，只是没有参数）
        inputSchema: jsonSchema(def.inputSchema ?? { type: 'object', properties: {} }),
        execute: (input: unknown, options: { toolCallId: string }) =>
          invokeTool(def.name, input, () =>
            def.execute(input, { toolCallId: options.toolCallId }, ctx)
          )
      })
    }

    // MCP 最后：同名覆盖内置（历史行为；内置侧的 browser_* 有整组让位逻辑，见 browser 工具的 available）
    for (const [name, impl] of Object.entries(extra ?? {})) {
      warnConflict(name, 'mcp')
      // MCP 工具也包一层：钩子与插话对「一步」的定义与内置工具完全一致
      const t = impl as { execute?: (...args: unknown[]) => Promise<unknown> }
      if (typeof t?.execute !== 'function') {
        result[name] = impl
        continue
      }
      const inner = t.execute.bind(impl)
      result[name] = {
        ...(impl as object),
        execute: (input: unknown, options: { toolCallId: string }) =>
          invokeTool(name, input, () => inner(input, options))
      }
    }
    return result as ToolSet
  }
}

export const toolRegistry = new ToolRegistry()
