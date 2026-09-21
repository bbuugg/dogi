/**
 * @opsdesk/ai-agent —— OpsDesk 工作区 AI Agent 核心（npm workspace 包）。
 * 与 Electron 解耦：只依赖 ai / zod / node 内置模块，源码由主进程 vite 直接打包。
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
  AgentToolOptions
} from './agent'
export { resolveInside, createIgnoreChecker, parseGitignore } from './workspace'
