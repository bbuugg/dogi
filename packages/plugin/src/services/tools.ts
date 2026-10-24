/**
 * 工具注册表：`ctx.tools` 的实体。**这是插件「加 / 覆盖」Agent 工具的唯一入口。**
 *
 * 覆盖规则（信任模型的落点）：
 * - 每个注册项都带 `priority`（缺省 0）。同名工具里 **priority 最高者胜出**；
 * - 最高 priority 出现**并列**时**直接抛错** —— 默认谁也别想悄悄盖掉内置工具：
 *   内置工具以 priority 0 注册，插件想覆盖必须显式把自己的 priority 调到 > 0
 *   （见设置页的信任开关），否则加载期就炸，错误会一路冒到日志与 UI；
 * - priority 不同时**静默取高者** —— 这正是「用户显式调高 priority 后允许覆盖」。
 *
 * 工具名冲突的报错刻意写得「大声」：带上各自的来源（source）与 priority，
 * 让人一眼看出是谁想盖谁、该怎么调。
 */
import { Service } from '../service'
import type { Context } from '../context'
import type { Dispose } from '../types'

/** 注册来源：内置能力（随产品分发）还是插件（本地目录 / 未来 npm） */
export type ToolOrigin = 'builtin' | 'plugin'

export interface ToolRegistration {
  name: string
  tool: unknown
  priority: number
  origin: ToolOrigin
  /** 人可读的来源标识（插件名 / 'builtin'），冲突报错与设置页展示用 */
  source: string
  /** 是否会改动东西（写文件 / 执行命令）。审批闸门据此决定要不要走确认 */
  mutating: boolean
}

export interface RegisterToolOptions {
  /** 越大越优先；同名并列最高会抛错（见类注释） */
  priority?: number
  origin?: ToolOrigin
  source?: string
  /**
   * 这个工具会不会改动东西（写盘 / 执行命令 / 改远端 / 把数据发出去）。缺省 false。
   *
   * ⚠️ **不是纯元数据**：装配期会据此套审批闸门（见 `@fizz/agent` 的 `wrapToolsWithApproval`）——
   * `readonly` 模式直接拒绝调用、`confirm` 模式先问用户、`full` 模式放行，与内置文件工具
   * 同一套语义。所以只读工具老实写 false，会改动外部状态的才写 true。
   */
  mutating?: boolean
}

/** `entries()` 的元素：解析后的胜出工具 + 它的注册信息 */
export interface ResolvedTool {
  name: string
  tool: unknown
  registration: ToolRegistration
}

export class ToolsService extends Service {
  /** 名字 → 该名字的所有注册（含被盖掉的，便于 UI 展示冲突） */
  private readonly _byName = new Map<string, ToolRegistration[]>()
  /** 首次出现的名字顺序，`build()` 按它输出，保证工具集键序稳定 */
  private readonly _order: string[] = []

  constructor(ctx: Context) {
    super(ctx)
  }

  get name(): string {
    return 'tools'
  }

  /** 注册单个工具；返回 disposer（从注册表摘掉这一条） */
  register(name: string, tool: unknown, opts: RegisterToolOptions = {}): Dispose {
    // 形状体检：工具必须是 AI SDK 的 `{ description, execute }`。**少了可调用的 execute 就
    // 在这里拒绝** —— 少了它 AI SDK 会把它当「客户端工具」：模型照调，但没人执行、也不产出
    // tool-result，前端会永远停在「执行中」，是最难查的一种静默失败（真实踩过：写成 handler）。
    // 装配期大声报错，好过让一整轮对话莫名卡住。
    if (typeof tool !== 'object' || tool === null || typeof (tool as { execute?: unknown }).execute !== 'function') {
      throw new Error(
        `工具「${name}」没有可调用的 execute（来源 ${opts.source ?? 'unknown'}）：` +
          'AI SDK 的工具对象必须是 { description, execute } 的形状（无参工具可省略 inputSchema）；' +
          "handler 是别家的叫法，这里必须叫 execute。"
      )
    }
    const reg: ToolRegistration = {
      name,
      tool,
      priority: opts.priority ?? 0,
      origin: opts.origin ?? 'plugin',
      source: opts.source ?? 'unknown',
      mutating: opts.mutating ?? false
    }
    const list = this._byName.get(name)
    if (list) list.push(reg)
    else {
      this._byName.set(name, [reg])
      this._order.push(name)
    }
    return this.bind(() => {
      const cur = this._byName.get(name)
      if (!cur) return
      const i = cur.indexOf(reg)
      if (i >= 0) cur.splice(i, 1)
      if (cur.length === 0) {
        this._byName.delete(name)
        const j = this._order.indexOf(name)
        if (j >= 0) this._order.splice(j, 1)
      }
    })
  }

  /** 批量注册（同一个 priority / source），返回一次性摘掉全部的 disposer */
  registerAll(tools: Record<string, unknown>, opts: RegisterToolOptions = {}): Dispose {
    const disposers = Object.keys(tools).map((name) => this.register(name, tools[name], opts))
    return () => {
      for (const d of disposers) d()
    }
  }

  /** 按名字取「胜出者」（不抛错：无冲突时的高者；有冲突时取最高，不在这里报错） */
  get(name: string): ToolRegistration | undefined {
    const list = this._byName.get(name)
    return list ? this._pick(name, list, false) : undefined
  }

  /** 列出全部注册项（`build()` 顺序） */
  list(): ToolRegistration[] {
    const out: ToolRegistration[] = []
    for (const name of this._order) out.push(...(this._byName.get(name) ?? []))
    return out
  }

  /** 是否存在冲突（并列最高 priority），供设置页 / 加载期体检 */
  conflicts(): { name: string; registrations: ToolRegistration[] }[] {
    const out: { name: string; registrations: ToolRegistration[] }[] = []
    for (const name of this._order) {
      const list = this._byName.get(name)
      if (list && list.length > 1) {
        try {
          this._pick(name, list, true)
        } catch {
          out.push({ name, registrations: [...list] })
        }
      }
    }
    return out
  }

  /**
   * 解析后的胜出清单（**含各自的注册信息**，如 `mutating`）。
   *
   * `build()` 就是它的投影；需要「按注册声明做事」的装配期逻辑用这个 —— 典型是给
   * `mutating: true` 的工具套审批闸门（`@fizz/agent` 的 `wrapToolsWithApproval`）。
   * 与 `build()` 一样：同名并列最高 priority 在这里抛错。
   */
  entries(): ResolvedTool[] {
    const out: ResolvedTool[] = []
    for (const name of this._order) {
      const list = this._byName.get(name)
      if (!list || list.length === 0) continue
      const registration = this._pick(name, list, true)
      out.push({ name, tool: registration.tool, registration })
    }
    return out
  }

  /**
   * 产出最终的「工具名 → 工具对象」。同名冲突（并列最高 priority）在这里抛错 ——
   * 装配期就炸，不会等到模型调用一个来路不明的同名工具。
   */
  build(): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    for (const { name, tool } of this.entries()) out[name] = tool
    return out
  }

  private _pick(name: string, list: ToolRegistration[], strict: boolean): ToolRegistration {
    if (list.length === 1) return list[0]
    const sorted = [...list].sort((a, b) => b.priority - a.priority)
    const topPriority = sorted[0].priority
    const atTop = sorted.filter((r) => r.priority === topPriority)
    if (atTop.length > 1) {
      if (!strict) return atTop[atTop.length - 1]
      const detail = atTop
        .map((r) => `${r.source}(priority=${r.priority}, ${r.origin})`)
        .join('  vs  ')
      throw new Error(
        `工具名冲突：「${name}」被多个同优先级注册项争用 —— ${detail}。` +
          '默认不允许插件覆盖内置工具；若确需覆盖，请在插件配置里显式把 priority 调高（> 0）。'
      )
    }
    return atTop[0]
  }
}