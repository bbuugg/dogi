/**
 * Dogi 工作区 AI Agent 核心（工具集 / 系统提示词 / 事件适配 / 工作区路径与忽略规则）。
 *
 * 原本是独立的 npm workspace 包 `@dogi/ai-agent`，现已收回主进程源码树
 * （只有一个消费方，分包只会多一层 alias / external 配置）。
 * 仍然与 Electron 解耦：只依赖 ai / zod / node 内置模块，随主进程一起打包。
 */
export {
  MAX_STEPS,
  buildAgentSystemPrompt,
  toModelMessages,
  adaptAgentPart,
  buildAgentTools
} from './agent'
export type {
  AgentHistoryMessage,
  AgentMessagePart,
  AgentPermissionMode,
  AgentStreamEvent,
  AgentToolOptions,
  AgentSkill
} from './agent'
export { buildSkillsPromptSection, buildReadSkillTool, SKILL_FILE } from './skills'
export { resolveInside, createIgnoreChecker, parseGitignore, relPathOf } from './workspace'
