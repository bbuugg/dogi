/**
 * 多智能体协作（collab）的运行时编排器。
 *
 * 设计要点（与子任务派活的差别）：
 * - **显式编排**：主智能体通过 `delegate_to_agent` / `delegate_many` 调我们自己的工具，
 *   任务、并发、深度、循环、预算都由这里控制；不走子任务那套 `agent-<id>` 工具。
 * - **按拓扑路由**：谁能派给谁由 `CollabSettings.edges`（画布上的接线）决定 ——
 *   主智能体只能派给有 `main → agent` 线的子 Agent，`ask_agent` 也只能问自己有出线的对象。
 *   接线是**唯一的**路由依据，没有「没配就默认全通」的后门（老配置在归一化时补线）。
 * - **同进程、同工作区**：每个子 Agent 都是 `runAgent({ setup })` 跑一轮内置 Agent，
 *   共享工作区 / 审批通道 / 命令停止表 / 上下文压缩，天然可以读写同一份文件。
 * - **状态旁路**：任务 / 消息 / 实时状态通过 `collab-*` 流事件推给前端，**不写进主消息**。
 * - **持久化**：`onState` 回调把任务 / 消息 / 最近状态交给调用方写 `collab.json`；
 *   主对话的消息仍由原链路落 `conversation.json`。
 */
import { randomUUID } from 'node:crypto'
import { tool } from 'ai'
import { z } from 'zod'
import type {
  AgentChatMessage,
  AgentConfirmInput,
  AgentConversation,
  AgentStreamEvent,
  AgentWorkspace,
  AiModelConfig,
  AiPermissionMode,
  CollabAgentConfig,
  CollabAgentRuntime,
  CollabAgentStatus,
  CollabMessage,
  CollabSettings,
  CollabState,
  CollabTask
} from '@fizz/contracts/types'
import { DEFAULT_COLLAB_SETTINGS, normalizeCollabSettings } from '@fizz/contracts/types'
import type { SkillInfo } from '@fizz/skills'
import { buildAgentSetup, runAgent, type RunAgentResult } from './agent'
import type { ProjectDoc } from './project-doc'

export interface CollabRuntimeOptions {
  conversation: AgentConversation
  workspace: AgentWorkspace
  skills: SkillInfo[]
  projectDoc?: ProjectDoc | null
  /** 主会话模型（子 Agent 没单独配模型时回退到它） */
  mainModel: AiModelConfig
  /** 按配置解析子 Agent 的模型；解析失败 / 配置已删 = null（回退主模型） */
  resolveModel: (configId?: string, modelId?: string) => AiModelConfig | null
  /** 历史运行态（`collab.json`）；用于刷新 / 重启后继续画布与 Agent 记忆 */
  initialState?: CollabState | null
  /** 运行中实时读取全局权限档（用于主智能体；子 Agent 用各自配置） */
  getPermissionMode?: () => AiPermissionMode
  /** main 会话的审批回调；子 Agent 的请求会被补上 agentId / agentName */
  requestConfirm?: (req: AgentConfirmInput) => Promise<boolean>
  commandStops?: Map<string, () => void>
  /** 主 run 的中止信号：触发后所有子任务一起停 */
  signal?: AbortSignal
  /** 流事件出口（服务端 SSE） */
  emit: (event: AgentStreamEvent) => void
  /** 运行态变化（服务端节流写 `collab.json`） */
  onState?: (state: CollabState) => void
}

const TASK_OUTPUT_LIMIT = 24_000
const TASK_RETURN_LIMIT = 12_000
const THREAD_TEXT_LIMIT = 8_000
const THREAD_TASK_LIMIT = 8

function textOf(value: unknown, limit: number): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '')
  const safe = text || ''
  return safe.length > limit ? `${safe.slice(0, limit)}\n…（已截断）` : safe
}

function statusIsActive(status: CollabAgentStatus): boolean {
  return status === 'running' || status === 'queued' || status === 'waiting'
}

/** 子 Agent 空闲看门狗：多久没有任何事件就取消该任务（0 = 关闭） */
function idleTimeoutMs(): number {
  const raw = process.env.FIZZ_COLLAB_AGENT_IDLE_TIMEOUT_MS?.trim()
  const parsed = raw ? Number(raw) : NaN
  if (Number.isFinite(parsed) && parsed >= 0) return parsed
  return 120_000
}

interface TaskRun {
  task: CollabTask
  controller: AbortController
  promise: Promise<CollabTask>
  depth: number
  ancestors: string[]
}

export class CollabRuntime {
  readonly settings: CollabSettings
  private readonly opts: CollabRuntimeOptions
  private readonly tasks = new Map<string, CollabTask>()
  private readonly messages: CollabMessage[] = []
  private readonly statuses: Record<string, CollabAgentRuntime> = {}
  private readonly threads = new Map<string, AgentChatMessage[]>()
  private readonly active = new Map<string, TaskRun>()
  private readonly runningByAgent = new Map<string, string>()
  private readonly queued: Array<() => void> = []
  private tasksThisTurn = 0
  private closed = false
  private persistTimer: NodeJS.Timeout | null = null

  constructor(opts: CollabRuntimeOptions) {
    this.opts = opts
    this.settings = normalizeCollabSettings(opts.conversation.collab ?? DEFAULT_COLLAB_SETTINGS)
    const initial = opts.initialState
    if (initial) {
      for (const task of initial.tasks) this.tasks.set(task.id, task)
      this.messages.push(...initial.messages)
      Object.assign(this.statuses, initial.statuses)
      for (const task of initial.tasks) {
        if (task.status === 'done' && task.output) this.remember(task)
      }
    }
    const now = Date.now()
    this.statuses.main = { status: 'running', startedAt: now, updatedAt: now }
    for (const agent of this.settings.agents) {
      if (!this.statuses[agent.id]) {
        this.statuses[agent.id] = { status: 'idle', updatedAt: Date.now() }
      } else if (statusIsActive(this.statuses[agent.id]!.status)) {
        this.statuses[agent.id] = { status: 'idle', updatedAt: Date.now() }
      }
    }
    if (opts.signal) {
      if (opts.signal.aborted) this.close()
      else opts.signal.addEventListener('abort', () => this.close(), { once: true })
    }
  }

  /** 主智能体可用的工具集（由 chat-turn 合并进 `extraTools`） */
  mainTools(): Record<string, unknown> {
    return {
      list_collab_agents: tool({
        description:
          '列出本协作会话里可派活的子 Agent（id / 名字 / 职责 / 状态 / 当前任务）。派活前先看一遍，选最合适的人。',
        inputSchema: z.object({}),
        execute: async () => {
          if (this.closed) return '协作会话已结束。'
          const main = {
            id: 'main',
            name: this.settings.mainName,
            role: '主智能体：与用户对话、拆解任务、汇总子 Agent 结果',
            status: this.statuses.main?.status ?? 'idle'
          }
          const reachable = this.reachableFromMain()
          return JSON.stringify(
            {
              main,
              agents: reachable.map((agent) => ({
                id: agent.id,
                name: agent.name,
                role: agent.role,
                status: this.statuses[agent.id]?.status ?? 'idle',
                currentTaskId: this.statuses[agent.id]?.taskId,
                permissionMode: agent.permissionMode,
                model: agent.modelId ?? '（跟随主会话）'
              }))
            },
            null,
            2
          )
        }
      }),
      delegate_to_agent: tool({
        description:
          '把一个子任务派给指定子 Agent，并等待它完成。适合需要先拿到结果才能继续的串行工作。' +
          '子 Agent 与你共享同一个工作区；只读 Agent 不能修改文件。返回它的输出摘要。',
        inputSchema: z.object({
          agentId: z.string().describe('子 Agent id（先用 list_collab_agents 查）'),
          task: z.string().describe('要它做的事，写清楚目标、范围与期望产出'),
          context: z.string().optional().describe('可选：补充上下文 / 相关文件 / 约束')
        }),
        execute: async ({ agentId, task, context }) => {
          const created = await this.delegate({
            agentId,
            prompt: task,
            context,
            from: 'main',
            depth: 1,
            ancestors: ['main']
          })
          if ('error' in created) return created.error
          return this.taskResultForModel(created.task)
        }
      }),
      delegate_many: tool({
        description:
          '把多个**互不依赖**的子任务并行派给多个子 Agent，等它们全部完成后一起返回。' +
          `最多并行 ${this.settings.maxParallel} 个；有依赖关系时改用 delegate_to_agent 串行。`,
        inputSchema: z.object({
          tasks: z
            .array(
              z.object({
                agentId: z.string(),
                task: z.string(),
                context: z.string().optional()
              })
            )
            .min(1)
            .max(8)
        }),
        execute: async ({ tasks }) => {
          const results = await this.delegateMany(
            tasks.map((t) => ({
              agentId: t.agentId,
              prompt: t.task,
              ...(t.context ? { context: t.context } : {}),
              from: 'main',
              depth: 1,
              ancestors: ['main']
            }))
          )
          return results.map((r) => ('error' in r ? r.error : this.taskResultForModel(r.task))).join('\n\n---\n\n')
        }
      }),
      send_message_to_agent: tool({
        description:
          '继续和某个子 Agent 对话：沿用它与你的历史上下文再跑一次。适合追问、让它补充、或基于它上一轮结果继续。',
        inputSchema: z.object({
          agentId: z.string(),
          message: z.string().describe('要补充 / 追问的内容')
        }),
        execute: async ({ agentId, message }) => {
          const created = await this.delegate({
            agentId,
            prompt: message,
            from: 'main',
            depth: 1,
            ancestors: ['main'],
            reuseThread: true
          })
          if ('error' in created) return created.error
          return this.taskResultForModel(created.task)
        }
      }),
      cancel_agent_task: tool({
        description: '取消一个正在跑的子任务（按 taskId）。取消后它的输出作废。',
        inputSchema: z.object({ taskId: z.string() }),
        execute: async ({ taskId }) => {
          const ok = this.cancelTask(taskId)
          return ok ? `已取消任务 ${taskId}` : `没有找到在跑的任务 ${taskId}`
        }
      })
    }
  }

  /** 主智能体的额外系统提示词：说明谁可派、怎么派、边界在哪 */
  mainPrompt(): string {
    // 只报**连得上的**：列了派不过去的名字，模型只会照着名单反复失败
    const agents = this.reachableFromMain()
    const roster = agents.length
      ? agents
          .map(
            (a) =>
              `- ${a.name}（id: ${a.id}，${a.permissionMode === 'readonly' ? '只读' : a.permissionMode === 'confirm' ? '改动需确认' : '完全访问'}）：${a.role || '通用协作助手'}`
          )
          .join('\n')
      : '（当前没有连得上的子 Agent；你可以先与用户对话，需要人手时请用户在画布上添加 Agent 并从你这里连一条线过去。）'
    return [
      '## 多智能体协作',
      '你是一个协作会话的主智能体。你的职责是：与用户对话、把复杂任务拆成可独立执行的子任务、派给合适的子 Agent、最后汇总成给用户的答案。',
      '',
      '可用子 Agent：',
      roster,
      '',
      '派活规则：',
      `- 先用 \`list_collab_agents\` 确认当前可用的 Agent 与状态；派活时写清目标、范围、验收标准。`,
      `- 互不依赖的子任务用 \`delegate_many\` 并行（最多 ${this.settings.maxParallel} 个）；有先后依赖时串行 \`delegate_to_agent\`。`,
      '- 子 Agent 的输出是**材料**，不是最终答复：你必须自己核对、取舍、组织后再回答用户，不要直接把大段原始输出倒给用户。',
      '- 子 Agent 与你共享同一工作区。它们默认只读；需要改动时优先由你自己执行，或派给明确具有写权限的 Agent。',
      `- 一轮最多派 ${this.settings.maxTasksPerTurn} 个子任务；不要为了「看起来忙」而重复派同一个任务。`,
      `- 子 Agent 可以再向下派活（最大深度 ${this.settings.maxDepth}），但你要对最终结果负责。`,
      '- 派活 / 结果会显示在画布上，用户能看到每个 Agent 的状态与输出。'
    ].join('\n')
  }

  /** 当前快照（写盘 / GET 用；不含 liveText，避免把流式半截写进磁盘） */
  snapshot(): CollabState {
    const statuses: Record<string, CollabAgentRuntime> = {}
    for (const [id, status] of Object.entries(this.statuses)) {
      const { liveText: _liveText, ...rest } = status
      statuses[id] = rest
    }
    return {
      version: 1,
      tasks: [...this.tasks.values()].sort((a, b) => a.createdAt - b.createdAt).slice(-200),
      messages: this.messages.slice(-500),
      statuses,
      updatedAt: Date.now()
    }
  }

  /** 取消单个任务（前端 / `cancel_agent_task` 工具共用） */
  cancelTask(taskId: string): boolean {
    const run = this.active.get(taskId)
    if (!run) return false
    run.controller.abort()
    this.finishTask(run.task, 'cancelled', undefined, '已取消')
    return true
  }

  /** 主轮结束 / 外部中止：停掉全部子任务并落一次快照 */
  close(): void {
    if (this.closed) return
    this.closed = true
    for (const run of this.active.values()) run.controller.abort()
    for (const wake of this.queued.splice(0)) wake()
    this.statuses.main = { status: 'idle', updatedAt: Date.now() }
    if (this.persistTimer) {
      clearTimeout(this.persistTimer)
      this.persistTimer = null
    }
    this.opts.onState?.(this.snapshot())
  }

  private delegate(input: {
    agentId: string
    prompt: string
    context?: string
    from: string
    depth: number
    ancestors: string[]
    parentTaskId?: string
    reuseThread?: boolean
  }): Promise<{ task: CollabTask } | { error: string }> {
    if (this.closed) return Promise.resolve({ error: '协作会话已结束，不能再派活。' })
    const agent = this.settings.agents.find((a) => a.id === input.agentId)
    if (!agent) return Promise.resolve({ error: `没有找到 Agent：${input.agentId}` })
    if (input.depth > this.settings.maxDepth + 1) {
      return Promise.resolve({ error: `超过最大派活深度 ${this.settings.maxDepth}，请直接完成或回报给上级。` })
    }
    if (input.ancestors.includes(agent.id)) {
      return Promise.resolve({ error: `检测到循环派活：${agent.name} 已经在本次调用链里。` })
    }
    if (!this.canDelegate(input.from, agent.id)) {
      // 报错里带上「谁 → 谁」：模型据此能自己改用别的 Agent，用户也能看懂该连哪条线
      const fromName =
        input.from === 'main'
          ? this.settings.mainName
          : (this.settings.agents.find((a) => a.id === input.from)?.name ?? input.from)
      return Promise.resolve({
        error: `「${fromName}」到「${agent.name}」之间没有接线，派不过去。需要的话让用户在画布上把两者连起来。`
      })
    }
    if (this.tasksThisTurn >= this.settings.maxTasksPerTurn) {
      return Promise.resolve({ error: `本轮派活次数已达上限 ${this.settings.maxTasksPerTurn}。` })
    }
    this.tasksThisTurn += 1
    const now = Date.now()
    const task: CollabTask = {
      id: `task-${randomUUID().slice(0, 8)}`,
      agentId: agent.id,
      agentName: agent.name,
      from: input.from,
      ...(input.parentTaskId ? { parentTaskId: input.parentTaskId } : {}),
      prompt: input.prompt,
      ...(input.context ? { context: input.context } : {}),
      status: 'queued',
      createdAt: now
    }
    this.tasks.set(task.id, task)
    const controller = new AbortController()
    const promise = this.enqueue(agent.id, task.id, () =>
      this.runTask(agent, task, controller, input.depth, input.ancestors, !!input.reuseThread)
    )
    this.active.set(task.id, {
      task,
      controller,
      promise,
      depth: input.depth,
      ancestors: input.ancestors
    })
    this.emitTask(task)
    this.addMessage({
      from: input.from,
      to: agent.id,
      kind: input.from === 'main' ? 'delegate' : 'ask',
      text: input.prompt,
      taskId: task.id
    })
    void promise
    return promise.then((settled) => ({ task: settled }))
  }

  private async delegateMany(
    inputs: Array<{
      agentId: string
      prompt: string
      context?: string
      from: string
      depth: number
      ancestors: string[]
    }>
  ): Promise<Array<{ task: CollabTask } | { error: string }>> {
    return Promise.all(inputs.map((input) => this.delegate(input)))
  }

  private enqueue(
    agentId: string,
    taskId: string,
    run: () => Promise<CollabTask>
  ): Promise<CollabTask> {
    // 同一个 Agent 同时只跑一个任务（避免两个任务抢同一份会话记忆）
    if (this.runningByAgent.has(agentId)) {
      return new Promise<CollabTask>((resolve) => {
        this.queued.push(() => {
          void this.runExclusive(agentId, taskId, run).then(resolve)
        })
      })
    }
    return this.runExclusive(agentId, taskId, run)
  }

  private async runExclusive(
    agentId: string,
    taskId: string,
    run: () => Promise<CollabTask>
  ): Promise<CollabTask> {
    if (this.closed) {
      const dummy = this.active.get(taskId)?.task
      if (dummy) return this.finishTask(dummy, 'cancelled', undefined, '已取消')
    }
    // 并行上限：按「正在跑的任务数」而不是排队数限流
    while (this.activeRunning() >= this.settings.maxParallel && !this.closed) {
      await new Promise<void>((resolve) => this.queued.push(resolve))
    }
    if (this.closed) {
      const task = this.active.get(taskId)?.task
      if (task) return this.finishTask(task, 'cancelled', undefined, '已取消')
    }
    this.runningByAgent.set(agentId, 'running')
    try {
      return await run()
    } finally {
      this.runningByAgent.delete(agentId)
      const next = this.queued.shift()
      if (next) next()
    }
  }

  private activeRunning(): number {
    return [...this.tasks.values()].filter((t) => t.status === 'running').length
  }

  private async runTask(
    agent: CollabAgentConfig,
    task: CollabTask,
    controller: AbortController,
    depth: number,
    ancestors: string[],
    reuseThread: boolean
  ): Promise<CollabTask> {
    if (this.closed || controller.signal.aborted) {
      return this.finishTask(task, 'cancelled', undefined, '已取消')
    }
    task.status = 'running'
    task.startedAt = Date.now()
    this.emitTask(task)
    this.setStatus(agent.id, { status: 'running', taskId: task.id, startedAt: Date.now() })

    let text = ''
    let reasoning = ''
    let error: string | undefined
    let usage: CollabTask['usage']
    let lastEventAt = Date.now()
    let steps = 0
    const maxSteps = agent.maxSteps ?? this.settings.maxTurnsPerTask

    const onEvent = (event: AgentStreamEvent): void => {
      lastEventAt = Date.now()
      switch (event.type) {
        case 'text-delta':
          text += event.delta
          this.opts.emit({
            type: 'collab-delta',
            agentId: agent.id,
            taskId: task.id,
            channel: 'text',
            delta: event.delta
          })
          break
        case 'reasoning-delta':
          reasoning += event.delta
          this.opts.emit({
            type: 'collab-delta',
            agentId: agent.id,
            taskId: task.id,
            channel: 'reasoning',
            delta: event.delta
          })
          break
        case 'tool-call':
          steps += 1
          this.setStatus(agent.id, {
            status: 'running',
            taskId: task.id,
            toolName: event.toolName,
            step: steps
          })
          this.opts.emit({
            type: 'collab-tool',
            agentId: agent.id,
            taskId: task.id,
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            phase: 'start',
            label: textOf(event.input, 300)
          })
          break
        case 'tool-result':
          this.setStatus(agent.id, { status: 'running', taskId: task.id, step: steps })
          this.opts.emit({
            type: 'collab-tool',
            agentId: agent.id,
            taskId: task.id,
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            phase: 'end',
            ok: !event.isError,
            label: textOf(event.output, 300)
          })
          break
        case 'error':
          error = event.message
          break
        case 'finish':
          if (event.usage) {
            usage = {
              inputTokens: event.usage.inputTokens,
              outputTokens: event.usage.outputTokens,
              totalTokens: event.usage.totalTokens
            }
          }
          break
        default:
          break
      }
    }

    const model = this.modelFor(agent)
    if (!model) {
      return this.finishTask(task, 'error', undefined, '没有可用的模型配置')
    }

    // 互问还要求「这个 Agent 自己有线出去」：没出线时给工具只会让它白试一轮
    const askTool =
      this.settings.allowAgentMessaging &&
      depth < this.settings.maxDepth &&
      this.canDelegateFrom(agent.id)
        ? {
            ask_agent: tool({
              description:
                '向另一个子 Agent 提问并等待回答。只在确实需要对方专业判断时用；不要用它闲聊或重复上级已经给过的信息。',
              inputSchema: z.object({
                agentId: z.string().describe('要询问的 Agent id'),
                question: z.string(),
                context: z.string().optional()
              }),
              execute: async ({ agentId, question, context }) => {
                const result = await this.delegate({
                  agentId,
                  prompt: question,
                  ...(context ? { context } : {}),
                  from: agent.id,
                  depth: depth + 1,
                  ancestors: [...ancestors, agent.id],
                  parentTaskId: task.id
                })
                if ('error' in result) return result.error
                return this.taskResultForModel(result.task)
              }
            })
          }
        : {}

    const permissionMode = agent.permissionMode
    const requestConfirm = this.opts.requestConfirm
      ? async (req: AgentConfirmInput) => {
          this.setStatus(agent.id, { status: 'waiting', taskId: task.id })
          try {
            return await this.opts.requestConfirm!({
              ...req,
              agentId: agent.id,
              agentName: agent.name
            })
          } finally {
            this.setStatus(agent.id, { status: 'running', taskId: task.id })
          }
        }
      : undefined

    const setup = buildAgentSetup({
      workspace: this.opts.workspace,
      skills: this.opts.skills,
      projectDoc: this.opts.projectDoc ?? null,
      permissionMode,
      ...(requestConfirm ? { requestConfirm } : {}),
      ...(this.opts.commandStops ? { commandStops: this.opts.commandStops } : {}),
      onEvent,
      extraTools: askTool
    })
    setup.instructions = `${setup.instructions}\n\n## 你的角色（多智能体协作）\n你是「${agent.name}」。${agent.role ? `职责：${agent.role}。` : ''}\n${agent.instructions || '完成主智能体交给你的子任务；只做与任务相关的工作，不要擅自扩大范围。'}\n\n你的输出会作为材料交给主智能体汇总，请直接给出结论、证据与必要的文件/行号引用；不要寒暄，不要复述任务。`
    // 工具白名单：只保留配置里列出的工具（运行时找不到的键静默忽略，避免旧配置炸掉整轮）
    const allowed = new Set([...agent.tools, ...Object.keys(askTool)])
    setup.tools = Object.fromEntries(
      Object.entries(setup.tools).filter(([name]) => allowed.has(name))
    )

    const thread = this.threads.get(agent.id) ?? []
    const promptParts = [
      task.context ? `【上下文】\n${task.context}` : '',
      `【任务】\n${task.prompt}`
    ].filter(Boolean)
    const history: AgentChatMessage[] = [
      ...(reuseThread ? thread : thread.slice(-THREAD_TASK_LIMIT * 2)),
      {
        id: `collab-user-${task.id}`,
        role: 'user',
        parts: [{ type: 'text', text: promptParts.join('\n\n') }],
        createdAt: Date.now()
      }
    ]

    const idle = idleTimeoutMs()
    let watchdog: NodeJS.Timeout | null = null
    if (idle > 0) {
      watchdog = setInterval(() => {
        if (Date.now() - lastEventAt > idle && !controller.signal.aborted) {
          error = `子任务超过 ${Math.round(idle / 1000)} 秒没有任何输出，已中止`
          controller.abort()
        }
      }, Math.min(5000, Math.max(1000, Math.floor(idle / 4))))
    }

    let result: RunAgentResult | undefined
    try {
      result = await runAgent({
        workspace: this.opts.workspace,
        history,
        model,
        skills: this.opts.skills,
        projectDoc: this.opts.projectDoc ?? null,
        permissionMode,
        ...(requestConfirm ? { requestConfirm } : {}),
        ...(this.opts.commandStops ? { commandStops: this.opts.commandStops } : {}),
        setup,
        onEvent,
        signal: controller.signal,
        maxSteps
      })
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    } finally {
      if (watchdog) clearInterval(watchdog)
      setup.ctx?.dispose()
    }

    if (this.closed) return this.finishTask(task, 'cancelled', undefined, '已取消')
    if (result?.finishReason === 'aborted') {
      return this.finishTask(task, 'cancelled', text, '已取消')
    }
    if (result?.finishReason === 'error' || error || result?.error) {
      return this.finishTask(task, 'error', text, error ?? result?.error ?? '子任务失败')
    }
    if (!text.trim() && reasoning.trim()) text = reasoning
    const output = text.trim() || '（子 Agent 没有输出）'
    this.remember({ ...task, output })
    this.addMessage({
      from: agent.id,
      to: task.from,
      kind: 'result',
      text: textOf(output, 4000),
      taskId: task.id
    })
    return this.finishTask(
      { ...task, ...(usage ? { usage } : {}) },
      'done',
      output.slice(0, TASK_OUTPUT_LIMIT)
    )
  }

  /**
   * 接线查询：`from` 能不能派活给 `to`。
   *
   * 只认 `settings.edges` —— 画布上删掉一条线，这条派活路径就真的断了。
   */
  private canDelegate(from: string, to: string): boolean {
    return this.settings.edges.some((edge) => edge.source === from && edge.target === to)
  }

  /** `from` 有没有任何一条出线（决定要不要给它 `ask_agent` 工具） */
  private canDelegateFrom(from: string): boolean {
    return this.settings.edges.some((edge) => edge.source === from)
  }

  /** 主智能体直接连得上的子 Agent（顺序沿用配置里的顺序） */
  private reachableFromMain(): CollabAgentConfig[] {
    return this.settings.agents.filter((agent) => this.canDelegate('main', agent.id))
  }

  private modelFor(agent: CollabAgentConfig): AiModelConfig | null {
    if (agent.configId && agent.modelId) {
      return this.opts.resolveModel(agent.configId, agent.modelId) ?? this.opts.mainModel
    }
    return this.opts.mainModel
  }

  private remember(task: Pick<CollabTask, 'agentId' | 'prompt' | 'output'>): void {
    if (!task.output) return
    const thread = this.threads.get(task.agentId) ?? []
    thread.push(
      {
        id: `collab-thread-u-${randomUUID().slice(0, 6)}`,
        role: 'user',
        parts: [{ type: 'text', text: task.prompt.slice(0, THREAD_TEXT_LIMIT) }],
        createdAt: Date.now()
      },
      {
        id: `collab-thread-a-${randomUUID().slice(0, 6)}`,
        role: 'assistant',
        parts: [{ type: 'text', text: task.output.slice(0, THREAD_TEXT_LIMIT) }],
        createdAt: Date.now()
      }
    )
    this.threads.set(task.agentId, thread.slice(-THREAD_TASK_LIMIT * 2))
  }

  private finishTask(
    task: CollabTask,
    status: CollabTask['status'],
    output?: string,
    error?: string
  ): CollabTask {
    const next: CollabTask = {
      ...task,
      status,
      ...(output !== undefined ? { output } : {}),
      ...(error ? { error } : {}),
      finishedAt: Date.now()
    }
    this.tasks.set(next.id, next)
    this.active.delete(next.id)
    if (status === 'done') {
      this.setStatus(next.agentId, { status: 'done', taskId: next.id })
    } else if (status === 'cancelled') {
      this.setStatus(next.agentId, { status: 'cancelled', taskId: next.id })
    } else {
      this.setStatus(next.agentId, {
        status: 'error',
        taskId: next.id,
        ...(error ? { error } : {})
      })
    }
    this.emitTask(next)
    this.schedulePersist()
    return next
  }

  private addMessage(input: Omit<CollabMessage, 'id' | 'createdAt'>): void {
    const message: CollabMessage = {
      ...input,
      id: `msg-${randomUUID().slice(0, 8)}`,
      createdAt: Date.now()
    }
    this.messages.push(message)
    if (this.messages.length > 500) this.messages.splice(0, this.messages.length - 500)
    this.opts.emit({ type: 'collab-message', message })
    this.schedulePersist()
  }

  private emitTask(task: CollabTask): void {
    this.opts.emit({ type: 'collab-task', task })
    this.schedulePersist()
  }

  private setStatus(
    agentId: string,
    patch: Partial<CollabAgentRuntime> & { status: CollabAgentStatus }
  ): void {
    const agent = this.settings.agents.find((a) => a.id === agentId)
    const next: CollabAgentRuntime = {
      ...(this.statuses[agentId] ?? { status: 'idle', updatedAt: Date.now() }),
      ...patch,
      updatedAt: Date.now()
    }
    this.statuses[agentId] = next
    this.opts.emit({
      type: 'collab-agent',
      agentId,
      agentName: agent?.name ?? agentId,
      status: next.status,
      ...(next.taskId ? { taskId: next.taskId } : {}),
      ...(next.toolName ? { toolName: next.toolName } : {}),
      ...(next.step !== undefined ? { step: next.step } : {}),
      ...(next.error ? { error: next.error } : {}),
      updatedAt: next.updatedAt
    })
    this.schedulePersist()
  }

  private taskResultForModel(task: CollabTask): string {
    if (task.status === 'error') {
      return `【${task.agentName}】任务失败：${task.error ?? '未知错误'}`
    }
    if (task.status === 'cancelled') return `【${task.agentName}】任务已取消。`
    const output = task.output ?? ''
    const clipped =
      output.length > TASK_RETURN_LIMIT
        ? `${output.slice(0, TASK_RETURN_LIMIT)}\n…（输出已截断，完整内容在画布上）`
        : output
    return `【${task.agentName}】完成（taskId: ${task.id}）\n${clipped}`
  }

  private schedulePersist(): void {
    if (!this.opts.onState) return
    if (this.persistTimer) return
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null
      this.opts.onState?.(this.snapshot())
    }, 1000)
  }
}
