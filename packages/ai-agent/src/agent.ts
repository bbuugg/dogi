/**
 * Agent 对话编排：系统提示词、历史消息转换、流事件适配。
 * 工具集见 tools.ts；streamText 的实际调用由主进程（持有模型配置）完成。
 */
import type { ModelMessage } from 'ai'
import { buildAgentTools, type AgentPermissionMode, type AgentToolOptions } from './tools'

/** Agent 单轮对话的最大工具步数（工作流比终端助手更长） */
export const MAX_STEPS = 25

export type { AgentPermissionMode, AgentToolOptions }
export { buildAgentTools }

/** Agent 消息（渲染端历史的结构化镜像，与 @shared/types.AiChatMessage 同构） */
export type AgentMessagePart =
  | { type: 'text'; text: string }
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

/** 流事件（与 @shared/types.AiStreamEvent 同构） */
export type AgentStreamEvent =
  | { type: 'text-delta'; delta: string }
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

/** 构建 Agent 系统提示词：说明工作区、工具约定与安全边界 */
export function buildAgentSystemPrompt(workspacePath: string, workspaceName: string): string {
  return [
    `你是一个运行在 OpsDesk 中的 AI Agent（编程与运维助手），工作区是「${workspaceName}」（${workspacePath}）。`,
    '你的职责：理解用户意图，主动使用工具在工作区内完成开发与运维任务。',
    '可用工具：',
    '- list_files / read_file：动手前先了解项目结构与目标文件；',
    '- search_files：按正则定位符号、配置与报错来源；',
    '- write_file：创建 / 整体覆盖文件（覆盖前先 read_file 确认原文）；',
    '- edit_file：局部查找替换编辑（oldText 要带足够上下文，避免误伤相似片段）；',
    '- execute_command：在工作区目录执行命令（构建、测试、git、安装依赖、启动服务等）。',
    '使用约定：',
    '- 所有路径一律使用相对工作区根目录的路径；',
    '- 执行命令前先简要说明意图；命令输出是事实依据，失败时结合输出排查原因，不要盲目反复重试同一条命令；',
    '- 删除文件、覆盖文件、危险命令（rm -rf、git push --force、DROP TABLE 等）先说明影响再执行；',
    '- 涉及修改文件时，先 read_file 看清楚原文再编辑；编辑后如可能，用 execute_command 验证（构建 / 测试）；',
    '- 任务完成时用简洁的中文总结做了什么、验证结果如何，以及遗留事项。'
  ].join('\n')
}

/** 渲染端对话历史 -> 模型消息（文本保留，工具过程转为摘要行） */
export function toModelMessages(history: AgentHistoryMessage[]): ModelMessage[] {
  const messages: ModelMessage[] = []
  for (const msg of history) {
    const lines: string[] = []
    for (const part of msg.parts) {
      if (part.type === 'text' && part.text.trim()) {
        lines.push(part.text)
      } else if (part.type === 'tool-call') {
        lines.push(`[调用工具 ${part.toolName}]`)
      } else if (part.type === 'tool-result') {
        const output =
          typeof part.output === 'string'
            ? part.output.slice(0, 400)
            : JSON.stringify(part.output)?.slice(0, 400)
        lines.push(`[工具 ${part.toolName} 返回] ${output}`)
      }
    }
    const content = lines.join('\n').trim()
    if (content) messages.push({ role: msg.role, content })
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
