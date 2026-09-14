// 共享类型定义：主进程 / preload / 渲染进程共用

export type ThemeMode = 'system' | 'light' | 'dark'

/**
 * 终端配色方案：
 * - auto：跟随应用明暗主题
 * - 其余为固定配色，不随应用主题变化
 */
export type TerminalThemeName =
  | 'auto'
  | 'dark'
  | 'light'
  | 'solarized-dark'
  | 'dracula'
  | 'nord'

export interface Preferences {
  theme: ThemeMode
  /** 终端配色方案，缺省 auto（跟随应用主题） */
  terminalTheme: TerminalThemeName
  /** 选中终端文本时自动复制到剪贴板，缺省开启 */
  copyOnSelect: boolean
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

/** 全局快捷键触发的应用动作 */
export type AppShortcutAction = 'open-settings' | 'new-session'

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

/**
 * AI 执行终端命令的权限模式（可在对话输入框处实时切换）：
 * - full：完全访问，AI 可直接执行终端命令
 * - confirm：确认模式，AI 每次执行终端命令前都需要用户确认，用户可取消
 */
export type AiPermissionMode = 'full' | 'confirm'

export interface AiSettings {
  activeConfigId?: string
  /** AI 执行终端命令的权限模式；在对话输入框处实时切换 */
  permissionMode: AiPermissionMode
  systemPrompt?: string
}

/** 主进程向渲染进程发起的命令执行确认请求 */
export interface AiConfirmRequest {
  /** 确认请求 id，回复时原样带回 */
  id: string
  /** 所属 AI 对话请求 id */
  requestId: string
  toolCallId: string
  toolName: string
  /** 待执行的命令 */
  command: string
  /** 目标终端会话 */
  sessionId?: string
  sessionTitle?: string
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
