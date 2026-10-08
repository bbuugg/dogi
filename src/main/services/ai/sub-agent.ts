/**
 * 子 Agent（`delegate` 工具）：把「翻代码找路」与「挑改动里的毛病」这两类**只读**活儿
 * 外包给一个临时的嵌套 Agent，只把它最后的报告回填成一条工具结果。
 *
 * 与 fishwork 的 explorer / reviewer 对齐，但形态不同：dogi 的子 Agent **没有独立会话** ——
 * 它就是父 Agent 的一次工具调用。这样做的取舍：
 * - 好处：不需要新的会话类型、不需要新的存储、不需要在侧边栏里多出一堆条目，
 *   父 Agent 拿到的就是一段可继续推理的文本；
 * - 代价：子 Agent 的中间过程（读了哪些文件、跑了多少步）界面上看不到，
 *   只有一行「delegate 运行中」。**这正是它被默认关闭的原因**（见 AiSettings.subAgents）。
 *
 * ⚠️ 三条硬约束（改这个文件时别破坏它们）：
 * 1. **只读**：工具白名单是写死的（`SUB_AGENT_TOOL_NAMES`），并且子 Agent 的
 *    `permissionMode` 强制为 `readonly`、`requestConfirm` 一律拒绝 —— 三重保险，
 *    任何一层被改坏都还有另外两层挡着（fail closed）；
 * 2. **不吞插话**：组装子 Agent 工具集时 `allowSteer: false`。`appendSteer` 是「取走」
 *    语义，子 Agent 内部某一步取走了用户的插话，父 Agent 就永远等不到了（见 steer.ts）；
 * 3. **不抛错**：失败一律返回说明性文本（同 guardWrite 的拒绝语义）—— 抛错会让整轮对话
 *    以 error 收场，而子 Agent 失败本来只是「这一步没做成」，父 Agent 完全可以自己接着干。
 */
import { z } from 'zod'
import {
  toolRegistry,
  type AiToolDef,
  type SubAgentKind,
  type SubAgentRunner,
  type ToolRunContext
} from './tool-registry'
import { createAgentFileState } from './agent-core'
import { DEFAULT_SUB_AGENT_MAX_STEPS } from '@shared/ai-timeouts'
import { describeError } from './error-utils'

export type { SubAgentKind, SubAgentRunner }

/** 界面/提示词里用的中文名 */
export const SUB_AGENT_LABELS: Record<SubAgentKind, string> = {
  explorer: '探索',
  reviewer: '评审'
}

/**
 * 子 Agent 的**只读白名单**。
 *
 * 刻意不含：`edit_file` / `write_file` / `delete_file` / `execute_command`（有副作用）、
 * `read_skill`（技能正文对子 Agent 的价值远不如它带来的提示词膨胀）、
 * `browser_*` / `web_fetch`（子 Agent 是「读这个工作区」，不是「上网」）。
 * 含 `read_tool_output`：白名单里的 `read_file` / `git_read` 输出过长时会落盘，
 * 不给它续读入口的话它只能反复重跑同一条命令。
 */
export const SUB_AGENT_TOOL_NAMES: readonly string[] = [
  'list_files',
  'find_files',
  'read_file',
  'search_files',
  'git_read',
  'read_tool_output'
]

/** 子 Agent 报告回填时的字符上限（与 agent-core/agent.ts 的 TOOL_RESULT_LIMIT 同量级，但更宽） */
const REPORT_INLINE_MAX = 12_000

/**
 * 子 Agent 的系统提示词。
 *
 * 两个角色共用大量约定，差异只在「你负责什么」与「输出长什么样」两段。
 * ⚠️ 必须显式告诉它「输出会被上级直接读」：不写的话它很容易写成
 * 「如上所述」「见前面提到的文件」—— 那些指代在父 Agent 眼里全是空的。
 */
export function buildSubAgentSystemPrompt(
  kind: SubAgentKind,
  workspacePath: string,
  workspaceName: string
): string {
  const role =
    kind === 'explorer'
      ? [
          '你的职责：**探索**。回答「这个功能实现在哪几个文件里」「这个调用链是怎么走的」',
          '「要改 X 需要动哪些地方」这类问题 —— 把相关代码找出来、读明白，然后交一份地图。',
          '输出格式（严格遵守）：',
          '1. 一段结论（3-6 句），直接回答被问到的问题；',
          '2. 「关键文件」清单：每行 `相对路径:行号 — 这个文件在这里起什么作用`；',
          '3. 「必要片段」：只在结论无法脱离代码讲清时才贴，每段不超过 20 行，前面标出路径与行号。'
        ]
      : [
          '你的职责：**评审**。审查指定的改动 / 文件 / 方案，找出真实存在的问题。',
          '输出格式（严格遵守）：',
          '1. 一段总体判断（能不能接受、最要紧的是什么）；',
          '2. 「问题清单」：每条一行 —— `[严重程度] 相对路径:行号 — 问题是什么 → 建议怎么改`。',
          '   严重程度只用三档：`阻塞`（会出错/有安全问题）、`建议`（该改但不影响正确性）、`疑问`（不确定，需要人确认）；',
          '3. 没有发现问题时就直说「未发现问题」，并列出你**检查过哪些方面** —— 别为了凑数硬找。',
          '',
          '⚠️ 只报你**在代码里真实看到**的问题。不要臆测、不要为了显得勤奋而堆砌泛泛而谈的建议',
          '（「建议加注释」「建议补测试」这类没有具体指向的话一律不要写）。'
        ]

  return [
    `你是一个运行在 Dogi 里的**子 Agent（${SUB_AGENT_LABELS[kind]}）**，工作区是「${workspaceName}」（${workspacePath}）。`,
    '你是被上级 Agent 临时派来做一件事的，做完就结束 —— 没有人会在你之后跟你继续对话。',
    '',
    ...role,
    '',
    '硬约束：',
    '- 你**只有只读工具**（看目录 / 找文件 / 读文件 / 搜内容 / 看 git）。你**不能**改文件、',
    '  不能执行命令、不能上网 —— 不要尝试，也不要建议「我先改一下看看」。',
    '- 所有路径一律使用**相对工作区根目录**的路径；',
    '- 你的输出会被上级 Agent **原样读走**，所以必须自包含：不要出现「如上所述」「见前面的文件」',
    '  这类指代，不要省略路径与行号；',
    '- 没有人能回答你的提问，**不要反问**。信息不足就按最合理的假设继续往下做，',
    '  并在最后用「假设」一节列出你替上级做的假设；',
    '- 不要复述你的调用过程（不要写「我调用了 read_file」），直接给结论；',
    '- 用中文回答。'
  ].join('\n')
}

/**
 * `delegate` 工具定义。
 *
 * `available` 只看「这一轮有没有注入 subAgent 执行器」—— 设置里没开子 Agent 时
 * agentService 不注入，模型连这个工具都看不到（比给个恒失败的工具干净得多）。
 */
export function buildDelegateDef(): AiToolDef {
  return {
    name: 'delegate',
    scope: 'workspace',
    description:
      '把一个**只读**的子任务外包给子 Agent，拿回它的一份报告。适合两类场景：' +
      '① kind=explorer —— 「先摸清这块代码在哪、怎么组织的」，把翻找过程留在子 Agent 里，' +
      '你只拿结论，省下自己一步步读文件的上下文；' +
      '② kind=reviewer —— 「让另一双眼睛挑挑这段改动的毛病」，用于交付前自查。' +
      '子 Agent 只能读（看目录 / 读文件 / 搜索 / git），不能改文件也不能执行命令；' +
      '它看不到你和用户的对话，所以 task 必须**自包含**：写清要查什么、涉及哪些路径、' +
      '以及你希望它回答到什么颗粒度。',
    inputSchema: z.object({
      kind: z
        .enum(['explorer', 'reviewer'])
        .describe('explorer=探索代码位置与结构；reviewer=评审改动或文件里的问题'),
      task: z
        .string()
        .describe(
          '交给子 Agent 的任务说明。必须自包含：要查什么 / 涉及哪些路径 / 期望它回答到什么颗粒度'
        )
    }),
    available: ({ ctx }) => !!ctx.subAgent,
    execute: async (rawInput, call, ctx) => {
      const runner = ctx.subAgent
      // available 已经挡过一道；这里再挡一次是为了让「工具被单独调用」也不会崩（防御性）
      if (!runner) return '【子 Agent 未启用】请在「设置 → AI → 子 Agent」里打开后再用。'

      const { kind, task } = rawInput as { kind: SubAgentKind; task: string }
      const trimmed = (task ?? '').trim()
      if (!trimmed) return '【这一步没执行】delegate 需要一个具体的 task。'

      try {
        const report = await runner.run({ kind, task: trimmed, toolCallId: call.toolCallId })
        const text = (report ?? '').trim()
        if (!text) {
          return `【子 Agent（${SUB_AGENT_LABELS[kind]}）没有产出内容】它可能没找到相关文件。请自己动手核对，或把 task 写得更具体一些。`
        }
        // 报告过长时截断而不是落盘成产物：子 Agent 的报告是「结论」，不是可续读的原始输出，
        // 留一个产物 id 反而诱导父 Agent 去读一堆它本来就不该关心的中间细节。
        return text.length > REPORT_INLINE_MAX
          ? `${text.slice(0, REPORT_INLINE_MAX)}\n…（子 Agent 报告过长，已截断，共 ${text.length} 字符）`
          : text
      } catch (err) {
        return `【子 Agent（${SUB_AGENT_LABELS[kind]}）执行失败】${describeError(err)}\n请自己动手完成这一步，或换一种说法再派一次。`
      }
    }
  }
}

/**
 * 造一个绑定到**当前这一轮**的子 Agent 执行器（agentService 在设置开启时调用）。
 *
 * 捕获的都是「这一轮不变」的东西：模型实例、modelSettings、工作区、父级 ctx。
 * 每个子 Agent 各造一份独立的 `fileState` —— 让子 Agent 的读取去满足父 Agent 的
 * 「先读后改」会悄悄削弱那道闸（父 Agent 明明没读过却能直接改）。
 */
export function createSubAgentRunner(opts: {
  parent: ToolRunContext
  model: unknown
  modelSettings: Record<string, unknown>
}): SubAgentRunner {
  const { parent, model, modelSettings } = opts
  const workspace = parent.workspace
  return {
    kinds: () => ['explorer', 'reviewer'],
    run: async ({ kind, task }) => {
      if (!workspace) return '【子 Agent 不可用】当前对话没有绑定工作区。'

      /**
       * 子 Agent 的运行上下文：继承父级的 requestId / conversationId / signal
       * （中止父级那一轮必须能连带停掉子 Agent），但**只读**且**不吞插话**。
       */
      const ctx: ToolRunContext = {
        requestId: parent.requestId,
        conversationId: parent.conversationId,
        scope: 'workspace',
        workspace,
        signal: parent.signal,
        // 三重保险之一：即便白名单被改坏、混进了改动类工具，guardWrite 也会在这里直接拒绝
        permissionMode: 'readonly',
        // 白名单里没有任何会弹确认的工具；万一将来混进来，宁可拒绝也不要冒用父 Agent 的名义弹卡
        requestConfirm: async () => 'reject_once',
        // 独立状态：子 Agent 读过什么，不算父 Agent 读过（见上面 createSubAgentRunner 的说明）
        fileState: createAgentFileState(),
        ...(parent.bashPath !== undefined ? { bashPath: parent.bashPath } : {})
      }

      const tools = toolRegistry.buildToolset({
        ctx,
        only: SUB_AGENT_TOOL_NAMES,
        allowSteer: false
      })

      const { Agent } = await import('@mastra/core/agent')
      const agent = new Agent({
        id: `dogi-sub-${kind}`,
        name: `Dogi ${SUB_AGENT_LABELS[kind]}`,
        instructions: buildSubAgentSystemPrompt(kind, workspace.path, workspace.name),
        model: model as never,
        tools: tools as never
      })

      const result = (await agent.generate(task, {
        maxSteps: DEFAULT_SUB_AGENT_MAX_STEPS,
        abortSignal: parent.signal,
        modelSettings
      })) as { text?: unknown }

      return typeof result?.text === 'string' ? result.text : ''
    }
  }
}
