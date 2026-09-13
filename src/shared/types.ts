// 共享类型定义：主进程 / preload / 渲染进程共用

export type ThemeMode = 'system' | 'light' | 'dark'

export interface Preferences {
  theme: ThemeMode
}

export type SessionType = 'local' | 'ssh'

export interface SessionInfo {
  id: string
  type: SessionType
  title: string
  profileId?: string
  pid?: number
  createdAt: number
  /** 会话是否已退出 */
  exited: boolean
}

export type SshAuthType = 'password' | 'privateKey'

export interface SshProfile {
  id: string
  name: string
  host: string
  port: number
  username: string
  authType: SshAuthType
  /** 仅用于传输，存储时主进程会用 safeStorage 加密，读取列表时不返回 */
  password?: string
  privateKey?: string
  passphrase?: string
  /** 是否已保存密码（脱敏展示用） */
  hasPassword?: boolean
  hasPrivateKey?: boolean
  hasPassphrase?: boolean
  keepaliveInterval?: number
  createdAt: number
  updatedAt: number
}

export type AiProviderKind =
  | 'openai'
  | 'anthropic'
  | 'deepseek'
  | 'google'
  | 'openai-compatible'

/**
 * OpenAI 系接口风格：
 * - chat-completions：/v1/chat/completions，第三方兼容网关（Ollama/vLLM/中转）普遍支持
 * - responses：/v1/responses，OpenAI 官方新接口
 * 省略时按 kind 取默认：openai → responses，openai-compatible → chat-completions
 */
export type AiApiStyle = 'chat-completions' | 'responses'

export interface AiModelConfig {
  id: string
  name: string
  kind: AiProviderKind
  apiKey?: string
  /** 是否已保存 apiKey（脱敏展示用） */
  hasApiKey?: boolean
  baseURL?: string
  model: string
  /** 仅 openai / openai-compatible 有效；缺省按 kind 取默认 */
  apiStyle?: AiApiStyle
  temperature?: number
  maxTokens?: number
  /** 携带的历史消息条数 */
  contextMessages?: number
  createdAt: number
  updatedAt: number
}

export interface McpServerConfig {
  id: string
  name: string
  command: string
  args: string[]
  env?: Record<string, string>
  enabled: boolean
}

export interface AiSettings {
  activeConfigId?: string
  /** AI 是否可自动执行终端命令；关闭时工具调用会被拒绝 */
  autoApprove: boolean
  systemPrompt?: string
}

/** AI 聊天消息（简化版 UIMessage，主进程与渲染进程一致） */
export interface AiChatMessage {
  id: string
  role: 'user' | 'assistant'
  parts: AiMessagePart[]
  createdAt: number
}

export type AiMessagePart =
  | { type: 'text'; text: string }
  | {
      type: 'tool-call'
      toolCallId: string
      toolName: string
      input: unknown
    }
  | {
      type: 'tool-result'
      toolCallId: string
      toolName: string
      output: unknown
      isError?: boolean
    }

export type AiStreamEvent =
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

export interface McpToolInfo {
  serverName: string
  name: string
  description?: string
}

export interface AppInfo {
  version: string
  electron: string
  node: string
  platform: string
}
