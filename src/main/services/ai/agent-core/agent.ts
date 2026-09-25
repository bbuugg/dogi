/**
 * Agent 对话编排：系统提示词、历史消息转换、流事件适配。
 * 工具集见 tools.ts；streamText 的实际调用由主进程（持有模型配置）完成。
 */
import type { ModelMessage, TextPart, ToolCallPart, ToolResultPart } from 'ai'

/** 工具结果的输出结构（ai 包没有单独导出这个类型，从 ToolResultPart 派生） */
type ToolResultOutput = ToolResultPart['output']
import { buildAgentTools, type AgentPermissionMode, type AgentToolOptions } from './tools'
import { buildSkillsPromptSection, type AgentSkill } from './skills'

/** Agent 单轮对话的最大工具步数（工作流比终端助手更长） */
export const MAX_STEPS = 25

export type { AgentPermissionMode, AgentToolOptions, AgentSkill }
export { buildAgentTools }

/** Agent 消息（渲染端历史的结构化镜像，与 @shared/types.AiChatMessage 同构） */
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

/** 流事件（与 @shared/types.AiStreamEvent 同构；reasoning-delta 为思考内容增量） */
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
  | { type: 'finish'; finishReason: string }
  | { type: 'error'; message: string }

/**
 * 构建 Agent 系统提示词：说明工作区、工具约定与安全边界。
 *
 * `skills` 非空时追加「可用技能」段落（只有名称 + 描述，正文由 read_skill 按需加载，
 * 见 skills.ts 的渐进式披露说明）。
 */
export function buildAgentSystemPrompt(
  workspacePath: string,
  workspaceName: string,
  skills: AgentSkill[] = []
): string {
  const lines = [
    `你是一个运行在 Dogi 中的 AI Agent（编程与运维助手），工作区是「${workspaceName}」（${workspacePath}）。`,
    '你的职责：理解用户意图，主动使用工具在工作区内完成开发与运维任务。',
    '可用工具：',
    '- list_files / find_files / read_file：动手前先了解项目结构与目标文件；find_files 按文件名通配符找文件（如 *.ts、**/*.test.tsx）；',
    '- search_files：按正则搜索文件内容，定位符号、配置与报错来源；结果很多时用 filesOnly 只拿「文件:命中数」，要看上下文用 context；',
    '- write_file：创建 / 整体覆盖文件（覆盖前先 read_file 确认原文）；',
    '- edit_file：局部查找替换编辑（oldText 要带足够上下文，避免误伤相似片段）；',
    '- delete_file：删除文件（目录必须显式 recursive=true）；不可恢复，删前先确认路径；',
    '- execute_command：在工作区目录执行命令（构建、测试、git、安装依赖、启动服务等）。',
    '使用约定：',
    '- 需要工具时直接调用工具，不要在正文里用「[调用工具 xxx]」「[工具 xxx 返回]」这类文字复述调用过程或结果 —— 写出来只会让用户看到一串假动作；',
    '- 所有路径一律使用相对工作区根目录的路径；',
    '- 执行命令前先简要说明意图；命令输出是事实依据，失败时结合输出排查原因，不要盲目反复重试同一条命令；',
    '- 删除文件、覆盖文件、危险命令（rm -rf、git push --force、DROP TABLE 等）先说明影响再执行；',
    '- 涉及修改文件时，先 read_file 看清楚原文再编辑；编辑后如可能，用 execute_command 验证 —— 优先跑项目自带的类型检查 / lint（如 npm run typecheck、npm run lint），这是最快的静态验证手段；',
    '- 任务完成时用简洁的中文总结做了什么、验证结果如何，以及遗留事项。'
  ]
  const skillsSection = buildSkillsPromptSection(skills)
  if (skillsSection) lines.push('', skillsSection)
  return lines.join('\n')
}

/** 历史里工具结果回传时的字符上限：太小模型看不到内容（会反复重读同一个文件），太大撑爆上下文 */
const TOOL_RESULT_LIMIT = 4000

/** 工具结果 -> 模型消息的输出结构（字符串走 text，其余序列化成 json；失败走 error-text） */
function toToolOutput(output: unknown, isError?: boolean): ToolResultOutput {
  const raw =
    typeof output === 'string' ? output : (JSON.stringify(output, null, 1) ?? String(output))
  const value =
    raw.length > TOOL_RESULT_LIMIT
      ? `${raw.slice(0, TOOL_RESULT_LIMIT)}\n…（输出过长，已截断，共 ${raw.length} 字符）`
      : raw
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

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
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
