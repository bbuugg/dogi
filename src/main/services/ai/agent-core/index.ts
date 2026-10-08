/**
 * Dogi 工作区 AI Agent 核心（工具集 / 系统提示词 / 事件适配 / 工作区路径与忽略规则）。
 *
 * 原本是独立的 npm workspace 包 `@dogi/ai-agent`，现已收回主进程源码树
 * （只有一个消费方，分包只会多一层 alias / external 配置）。
 * 仍然与 Electron 解耦：只依赖 ai / zod / node 内置模块，随主进程一起打包。
 */
export {
  buildAgentSystemPrompt,
  toModelMessages,
  adaptAgentPart
} from './agent'
export type {
  AgentHistoryMessage,
  AgentMessagePart,
  AgentStreamEvent,
  AgentFileState,
  AgentFileSnapshot,
  AgentSkill,
  AgentPermissionMode
} from './agent'
export { readProjectDoc, buildProjectDocSection, PROJECT_DOC_NAMES } from './project-doc'
export type { ProjectDoc } from './project-doc'
export { adaptMastraPart } from './mastra-stream'
export type { MastraAdaptedEvent } from './mastra-stream'
export { normalizeUsage, readChunkUsage } from './usage'
export type { RawUsage } from './usage'
export { buildSkillsPromptSection, buildReadSkillDef, SKILL_FILE } from './skills'
export { resolveInside, createIgnoreChecker, parseGitignore, relPathOf } from './workspace'
export { createAgentFileState, buildWorkspaceToolDefs } from './tools'
