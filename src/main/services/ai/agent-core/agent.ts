/**
 * Agent 对话编排：系统提示词、历史消息转换、流事件适配。
 * 工具集见 tools.ts；streamText 的实际调用由主进程（持有模型配置）完成。
 */
import type { ModelMessage, TextPart, ToolCallPart, ToolResultPart } from 'ai'

/** 工具结果的输出结构（ai 包没有单独导出这个类型，从 ToolResultPart 派生） */
type ToolResultOutput = ToolResultPart['output']
import { type AgentFileState, type AgentFileSnapshot } from './tools'
import { buildSkillsPromptSection, type AgentSkill } from './skills'
import { buildProjectDocSection, type ProjectDoc } from './project-doc'
import type { ContextCompression, TurnUsage } from '@shared/types'
import { describeError } from '../error-utils'

export type { AgentFileState, AgentFileSnapshot, AgentSkill }

/** Agent 消息（渲染端历史的结构化镜像，与 @shared/types.AgentChatMessage 同构） */
export type AgentMessagePart =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool-call'; toolCallId: string; toolName: string; input: unknown }
  | {
      type: 'tool-result'
      toolCallId: string
      toolName: string
      output: unknown
      isError?: boolean
    }

export interface AgentHistoryMessage {
  id: string
  role: 'user' | 'assistant'
  parts: AgentMessagePart[]
  createdAt: number
}

/** 流事件（与 @shared/types.AgentStreamEvent 同构；reasoning-delta 为思考内容增量） */
export type AgentStreamEvent =
  | { type: 'text-delta'; delta: string }
  | { type: 'reasoning-delta'; delta: string }
  | { type: 'tool-call'; toolCallId: string; toolName: string; input: unknown }
  | {
      type: 'tool-result'
      toolCallId: string
      toolName: string
      output: unknown
      isError?: boolean
    }
  /** 一轮结束时的用量统计（input/output/total tokens、tps、耗时等） */
  | { type: 'usage'; usage: TurnUsage }
  /** 本轮请求发出前触发了上下文压缩（只是通知，不进消息历史） */
  | { type: 'context-compressed'; info: ContextCompression }
  | { type: 'finish'; finishReason: string }
  | { type: 'error'; message: string }

/**
 * 权限模式（与 ToolRunContext.permissionMode 同口径，取值即 `AiPermissionMode`）。
 * 三档：full 全放开 / confirm 改动前确认 / readonly 只读（改动类工具直接拒绝）。
 */
export type AgentPermissionMode = 'full' | 'confirm' | 'readonly'

/**
 * 构建 Agent 系统提示词：说明工作区、**跨工具的行为约定**与安全边界。
 *
 * ⚠️ **刻意不逐条复述每个工具的用法**（2026-10 精简）：工具自身的 `description` 每轮都随
 * 请求发出去，提示词里再列一遍等于每一步白烧 ~1.5-2K token（pi 的整份系统提示 + 工具定义
 * 不到 1K token，靠的就是不重复）。这里只留「工具描述里写不下、或跨多个工具」的规则。
 * **新增工具时把用法写进它自己的 description，不要加回这里。**
 *
 * `skills` 非空时追加「可用技能」段落（只有名称 + 描述，正文由 read_skill 按需加载，
 * 见 skills.ts 的渐进式披露说明）。
 *
 * `permissionMode` 追加「权限模式」段落（移植自 fishwork）：**让模型预先知道哪些动作会被
 * 拦下来** —— 否则它只知道「工具失败了」，不知道是被用户拒绝，容易反复重试同一个动作。
 *
 * `projectDoc` 是工作区根目录的 `AGENTS.md`（由 readProjectDoc 读出），
 * 非空时注入且**声明优先级高于本提示词里其它通用约定**，见 project-doc.ts
 *「为什么全文注入」「为什么只读工作区根目录」。
 */
export function buildAgentSystemPrompt(
  workspacePath: string,
  workspaceName: string,
  skills: AgentSkill[] = [],
  permissionMode: AgentPermissionMode = 'full',
  projectDoc?: ProjectDoc | null
): string {
  const lines = [
    `你是一个运行在 Dogi 中的 AI Agent（编程与运维助手），工作区是「${workspaceName}」（${workspacePath}）。`,
    '你的职责：理解用户意图，主动使用工具在工作区内完成开发与运维任务。',
    // ⚠️ 这里**只写跨工具的行为规则**，不再逐条复述每个工具是干什么的 ——
    // 那些说明与工具自身的 `description` 完全重复，而工具定义每轮都随请求发出去，
    // 重复一遍等于每一步白烧 ~1.5-2K token（对齐 pi 的「系统提示 + 工具定义 < 1K token」思路）。
    // 新增工具时把「怎么用」写进它自己的 description，别加回这里。
    '各工具的用途、参数与用法见工具自身的说明（tool 定义里的 description）。',
    '使用约定：',
    '- 需要工具时直接调用工具，不要在正文里用「[调用工具 xxx]」「[工具 xxx 返回]」这类文字复述调用过程或结果 —— 写出来只会让用户看到一串假动作；',
    '- 所有路径一律使用相对工作区根目录的路径；',
    '- 动手前先用 list_files / find_files / search_files 摸清结构与定位目标，再 read_file；可以并行发起多个独立的读取 / 搜索调用提高效率；',
    '- read_file 的输出每行带「行号: 内容」前缀 —— 构造 edit_file 的 oldString 时只取冒号后面的原文，绝不要把行号前缀带进去；',
    '- 修改文件前必须先 read_file 看清原文，编辑基于最新内容；改完如有可能，用 execute_command 跑项目自带的类型检查 / lint（如 npm run typecheck）验证，这是最快的静态验证手段；',
    '- 工具结果被压成「开头 + 结尾 + 产物提示」时**那不是全部**：关键信息（报错行 / 配置项 / 中段条目）可能就在被省略的部分，按结果里给的参数用 read_tool_output 补齐；不要为同一段内容反复重跑同一条命令，也不要为同一文件反复小窗口读取；',
    '- 执行命令前先简要说明意图；命令输出是事实依据，失败时结合输出排查原因，不要盲目反复重试同一条命令；',
    '- 删除文件、覆盖文件、危险命令（rm -rf、git push --force、DROP TABLE 等）先说明影响再执行；',
    '- 任务完成时用简洁的中文总结做了什么、验证结果如何，以及遗留事项。'
  ]
  const skillsSection = buildSkillsPromptSection(skills)
  if (skillsSection) lines.push('', skillsSection)
  lines.push('', buildPermissionSection(permissionMode))
  // ⚠️ 项目约束文档放在**最后**：它声明「优先级高于其它通用约定」，
  // 紧接着的一段在提示词里权重更高，放最后才不会被前面的通用约定稀释。
  if (projectDoc) lines.push('', buildProjectDocSection(projectDoc))
  return lines.join('\n')
}

/**
 * 权限模式说明段落：让模型**预先知道**哪些动作会被系统真的执行、哪些会被拦下来。
 *
 * 移植自 fishwork 的 prompt.ts。不写这段的实际后果：confirm 模式下模型看不到
 * 「这一类动作需要用户点头」，工具被拒后只会当成普通失败，于是换个写法再试一遍，
 * 反复弹确认卡 —— 描述清楚它才知道该停下来说明、换个方案。
 */
function buildPermissionSection(mode: AgentPermissionMode): string {
  if (mode === 'readonly') {
    return [
      '权限模式：**只读**。写文件 / 改文件 / 删文件 / 执行命令会被系统**直接拒绝**（不弹确认、也没有例外）。',
      '你只能使用只读工具（list_files / read_file / search_files / find_files / git_read 等）了解现状，',
      '然后把「需要改什么、为什么」讲清楚让用户自己动手 —— 不要反复尝试写 / 执行，那只会拿到同一份拒绝。'
    ].join('\n')
  }
  if (mode === 'confirm') {
    return [
      '权限模式：**确认**。写文件 / 改文件 / 删文件 / 执行命令前会向用户弹出确认请求，',
      '用户拒绝时会明确告诉你原因。请据此调整方案（改用别的做法、或停下来问用户），不要原样重试。'
    ].join('\n')
  }
  return '权限模式：**完全放开**。写文件 / 改文件 / 删文件 / 执行命令会直接执行，不弹确认（rm -rf、git push --force 等破坏性命令仍要在动手前说明）。'
}

/** 历史里工具结果回传时的字符上限：太小模型看不到内容（会反复重读同一个文件），太大撑爆上下文 */
const TOOL_RESULT_LIMIT = 4000

/**
 * 超限时保留的**头部 / 尾部**字符数（合计略小于上限，给中间的省略说明留位置）。
 *
 * ⚠️ 必须是「头 + 尾」而不是只留头：尾部往往是报错原文、命令的最终结论、测试汇总 ——
 * 只留头等于把模型最需要的那几行丢掉（`execute_command` 那条路早就是头+尾了，这里是补上）。
 */
const TOOL_RESULT_HEAD = 2500
const TOOL_RESULT_TAIL = 1400

/** 工具结果 -> 模型消息的输出结构（字符串走 text，其余序列化成 json；失败走 error-text） */
function toToolOutput(output: unknown, isError?: boolean): ToolResultOutput {
  const raw =
    typeof output === 'string' ? output : (JSON.stringify(output, null, 1) ?? String(output))
  let value = raw
  if (raw.length > TOOL_RESULT_LIMIT) {
    const omitted = raw.length - TOOL_RESULT_HEAD - TOOL_RESULT_TAIL
    value =
      `${raw.slice(0, TOOL_RESULT_HEAD)}\n\n` +
      `…（中段 ${omitted} 字符已省略，共 ${raw.length} 字符。需要完整内容时重新调用该工具，` +
      `或按结果里给出的产物 id 用 read_tool_output 续读）\n\n` +
      `${raw.slice(-TOOL_RESULT_TAIL)}`
  }
  return isError ? { type: 'error-text', value } : { type: 'text', value }
}

/**
 * 渲染端对话历史 -> 模型消息。
 *
 * 工具过程必须用**原生 tool-call / tool-result 结构**，不能压成
 * `[调用工具 xxx]` / `[工具 xxx 返回] xxx` 这类纯文本摘要 ——
 * 模型会把这个格式当成「助手的说话方式」，在自己的正文里照抄出来
 * （实测：多步工具链后开始输出 `[调用工具 read_file]` 这种假调用文本）。
 *
 * 一轮里的工具过程是扁平交错的（text, call, result, text, call, result…），
 * 按「一批 tool-call 及其全部结果」切成若干段：每段 = assistant（文本 + tool-call）
 * + tool（结果），与模型 API 要求的消息顺序一致。
 */
export function toModelMessages(
  history: Array<{ role: 'user' | 'assistant'; parts: AgentMessagePart[] }>
): ModelMessage[] {
  const messages: ModelMessage[] = []
  for (const msg of history) {
    if (msg.role === 'user') {
      const text = msg.parts
        .map((p) => (p.type === 'text' ? p.text : ''))
        .join('')
        .trim()
      if (text) messages.push({ role: 'user', content: text })
      continue
    }

    let content: Array<TextPart | ToolCallPart> = []
    let results: ToolResultPart[] = []
    /** 已发出、还没配到结果的 toolCallId */
    const pending = new Set<string>()

    const flush = () => {
      // 有调用没结果（用户中止 / 工具没跑完）：补一条占位结果，
      // 否则 assistant 里的 tool-call 在协议上找不到配对，请求会被 provider 拒掉
      for (const id of pending) {
        const call = content.find(
          (p): p is ToolCallPart => p.type === 'tool-call' && p.toolCallId === id
        )
        if (call) {
          results.push({
            type: 'tool-result',
            toolCallId: id,
            toolName: call.toolName,
            output: { type: 'error-text', value: '该工具调用未执行完成（被中止或对话已结束）' }
          })
        }
      }
      pending.clear()
      if (content.length) messages.push({ role: 'assistant', content })
      if (results.length) messages.push({ role: 'tool', content: results })
      content = []
      results = []
    }

    for (const part of msg.parts) {
      if (part.type === 'text') {
        if (part.text.trim()) content.push({ type: 'text', text: part.text })
      } else if (part.type === 'tool-call') {
        content.push({
          type: 'tool-call',
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          input: part.input ?? {}
        })
        pending.add(part.toolCallId)
      } else if (part.type === 'tool-result') {
        // 孤儿结果（找不到对应调用）：丢弃，否则同样过不了 provider 校验
        if (!pending.has(part.toolCallId)) continue
        pending.delete(part.toolCallId)
        results.push({
          type: 'tool-result',
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          output: toToolOutput(part.output, part.isError)
        })
        // 这一批调用全部有结果了，收束成一段
        if (pending.size === 0) flush()
      }
      // reasoning：思考内容不回传（对模型无价值，部分 provider 还要求签名才能回传）
    }
    flush()
  }
  return messages
}

/** 将 AI SDK 流事件转换为 Agent 流事件（兼容字段名差异） */
export function adaptAgentPart(
  part: { type: string } & Record<string, unknown>
): AgentStreamEvent | null {
  switch (part.type) {
    case 'text-delta':
      return { type: 'text-delta', delta: String(part.text ?? '') }
    // AI SDK 7 的 fullStream 里思考内容是 reasoning-delta（增量在 text 字段），
    // reasoning-start / reasoning-end 只是起止标记，不带内容
    case 'reasoning-delta':
      return { type: 'reasoning-delta', delta: String(part.text ?? '') }
    case 'tool-call':
      return {
        type: 'tool-call',
        toolCallId: String(part.toolCallId),
        toolName: String(part.toolName),
        input: part.input ?? part.args ?? null
      }
    case 'tool-result':
      return {
        type: 'tool-result',
        toolCallId: String(part.toolCallId),
        toolName: String(part.toolName),
        output: part.output ?? part.result ?? null
      }
    case 'tool-error':
      return {
        type: 'tool-result',
        toolCallId: String(part.toolCallId),
        toolName: String(part.toolName),
        output: `工具执行失败: ${describeError(part.error)}`,
        isError: true
      }
    case 'error':
      return { type: 'error', message: describeError(part.error) }
    case 'abort':
      return { type: 'finish', finishReason: 'aborted' }
    default:
      return null
  }
}
