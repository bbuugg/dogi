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
import type { AgentWorkspace } from '@shared/types'
import type { AgentFileState, AgentSkill } from './agent-core'

/** 对话作用域：决定哪些工具进入这一轮的工具集 */
export type ToolScope = 'workspace' | 'terminal'

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
  /** 确认模式（true 时改动类工具在执行体内先请示） */
  permissionMode: 'full' | 'confirm'
  /** 确认请示入口（service 注入，已串行化）；上下文字段按来源可选 */
  requestConfirm(req: {
    toolCallId: string
    toolName: string
    command: string
    /** 终端来源：目标会话与标题（确认卡展示用） */
    sessionId?: string
    sessionTitle?: string
  }): Promise<boolean>
  /** workspace：会话级「先读后改」状态（read_file 记快照，write/edit 校验） */
  fileState?: AgentFileState
  /** workspace：本轮扫描到的可用技能 */
  skills?: AgentSkill[]
  /** workspace：Windows 上 execute_command 的 POSIX shell（Git Bash），null = 回退 PowerShell */
  bashPath?: string | null
  /** terminal：同一对话内工具执行的串行队列（前一条跑完下一条才开始） */
  queueToolExecution?: <T>(fn: () => Promise<T>) => Promise<T>
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
  }): ToolSet {
    const { ctx, extra } = opts
    const mcpToolNames = Object.keys(extra ?? {})
    /** 组装期用无类型的桶，最后一次性断言成 ToolSet（工具形状由各定义保证） */
    const result: Record<string, unknown> = {}
    const taken = new Set<string>()

    const warnConflict = (name: string, from: string): void => {
      if (taken.has(name)) {
        console.warn(`[tool-registry] 工具 ${name} 被 ${from} 覆盖（同名让位）`)
      }
    }

    for (const def of this.defs.values()) {
      if (def.scope !== 'both' && def.scope !== ctx.scope) continue
      if (def.available && !def.available({ ctx, mcpToolNames })) continue
      warnConflict(def.name, 'builtin')
      taken.add(def.name)
      result[def.name] = tool({
        description:
          typeof def.description === 'function' ? def.description(ctx) : def.description,
        inputSchema: def.inputSchema,
        execute: (input: unknown, options: { toolCallId: string }) =>
          def.execute(input, { toolCallId: options.toolCallId }, ctx)
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
          def.execute(input, { toolCallId: options.toolCallId }, ctx)
      })
    }

    // MCP 最后：同名覆盖内置（历史行为；内置侧的 browser_* 有整组让位逻辑，见 browser 工具的 available）
    for (const [name, impl] of Object.entries(extra ?? {})) {
      warnConflict(name, 'mcp')
      result[name] = impl
    }
    return result as ToolSet
  }
}

export const toolRegistry = new ToolRegistry()
