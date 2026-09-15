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
  /** 命令预测（历史 / 常见命令补全下拉），缺省开启 */
  commandPrediction: boolean
  /** 终端字号（Ctrl+滚轮 / Ctrl +/- 缩放），缺省 13 */
  terminalFontSize: number
  /**
   * 本地终端默认使用的 shell（ShellProfile.id），
   * 缺省 'default' 表示跟随平台默认（Windows: PowerShell；Unix: $SHELL）
   */
  localShell: string
  /**
   * 关闭主窗口时最小化到系统托盘而不是退出，缺省开启。
   * 关闭程序需在托盘图标的右键菜单中选择「退出」。
   */
  minimizeToTray: boolean
}

/** 检测到的本地可用 shell */
export interface ShellProfile {
  /** 唯一标识，如 powershell / pwsh / cmd / gitbash / wsl / bash / zsh / fish */
  id: string
  /** 展示名，如 PowerShell / CMD / Git Bash */
  name: string
  /** 可执行文件（绝对路径或 PATH 可解析名） */
  command: string
  /** 启动参数（如 Git Bash 的 --login -i） */
  args?: string[]
}

/** 本地 shell 检测结果 */
export interface ShellDetectResult {
  shells: ShellProfile[]
  /** 平台默认 shell 的 id（Preferences.localShell === 'default' 时使用） */
  defaultId: string
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

/** 单块磁盘/分区的使用情况 */
export interface DiskUsage {
  mount: string
  used: number
  total: number
  /** 使用率（0-100 整数） */
  percent: number
}

/**
 * 服务器监控指标（由主进程通过 SSH exec 周期性采集并解析 /proc、df 得到）。
 * 流量为每秒速率（字节/秒），首次采样时 CPU 使用率暂为 null。
 */
export interface ServerMetrics {
  /** CPU 使用率百分比（0-100），首次采样为 null */
  cpuPercent: number | null
  /** 逻辑核心数 */
  cores: number
  memTotal: number
  memUsed: number
  /** 内存使用率百分比（0-100） */
  memPercent: number
  load1: number
  load5: number
  load15: number
  /** 网络接收速率（字节/秒，汇总非回环网卡） */
  netRxRate: number
  /** 网络发送速率（字节/秒） */
  netTxRate: number
  disk: DiskUsage[]
  /** 系统运行时长（秒） */
  uptime: number
  /** 采集时间戳 */
  timestamp: number
}
