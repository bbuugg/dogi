// 共享类型定义：主进程 / preload / 渲染进程共用

export type ThemeMode = 'system' | 'light' | 'dark'

/**
 * 界面配色方案（强调色）：只影响按钮、选中态、焦点框等强调色，
 * 中性色（背景/边框/文字）仍由明暗主题（ThemeMode）决定。
 * `custom` 表示用 customColor 指定的任意颜色（见 Preferences.customColor）。
 */
export type ColorThemeName =
  | 'neutral'
  | 'blue'
  | 'cyan'
  | 'green'
  | 'violet'
  | 'rose'
  | 'orange'
  | 'amber'
  | 'custom'

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
  /** 界面配色方案（强调色），缺省 neutral */
  colorTheme: ColorThemeName
  /**
   * 自定义强调色（十六进制，如 #3b82f6）：colorTheme === 'custom' 时生效。
   * 只取色相与彩度，亮度会按明暗主题自动夹到可读区间。
   */
  customColor: string
  /** 终端配色方案，缺省 auto（跟随应用主题） */
  terminalTheme: TerminalThemeName
  /** 选中终端文本时自动复制到剪贴板，缺省开启 */
  copyOnSelect: boolean
  /** 鼠标右键粘贴剪贴板内容到终端，缺省关闭 */
  rightClickPaste: boolean
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
  /** 服务器指标采集间隔（毫秒），缺省 2000 */
  monitorInterval: number
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

/**
 *主机阶段（连接过程中推送，供渲染端展示进度）：
 * resolving → handshake → authenticating → opening-shell → ready；
 * 握手阶段失败自动重连时插入 retrying。
 */
export type SshConnectStage =
  /** 解析主机并建立 TCP 连接 */
  | 'resolving'
  /** TCP 已连通，正在握手（密钥交换） */
  | 'handshake'
  /** 握手完成，正在认证 */
  | 'authenticating'
  /** 认证通过，正在打开 shell */
  | 'opening-shell'
  /** 连接失败，正在自动重试 */
  | 'retrying'
  /** 就绪（渲染端据此收起进度提示） */
  | 'ready'

export interface SshConnectProgress {
  sessionId: string
  stage: SshConnectStage
  /** 仅 retrying：当前是第几次尝试 */
  attempt?: number
  /** 仅 retrying：最大尝试次数 */
  maxAttempts?: number
}

export type SshAuthType = 'password' | 'privateKey'

/** 主机类型：远程 SSH / 本地终端 */
export type HostKind = 'ssh' | 'local'

/**主机分组：仅用于侧边栏归类；删除分组时组内连接回到「未分组」 */
export interface SshGroup {
  id: string
  name: string
  /** 分组强调色（CSS 颜色字符串）；组内连接默认继承，可被连接自身的 color 覆盖 */
  color?: string
  createdAt: number
}

export interface SshProfile {
  id: string
  /** 主机类型：ssh 远程连接 / local 本地终端 */
  kind: HostKind
  /** 所属分组 id；缺省表示未分组 */
  groupId?: string
  /** 连接自身的强调色；缺省表示继承所属分组的颜色 */
  color?: string
  name: string
  /** 仅 ssh：主机地址 */
  host: string
  /** 仅 ssh：端口 */
  port: number
  /** 仅 ssh：登录用户名 */
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
  /** 仅 local：启动环境（可执行文件，PATH 可解析） */
  command?: string
  /** 仅 local：启动参数 */
  args?: string[]
  /** 仅 local：终端启动后自动执行的命令 */
  autoCommand?: string
  keepaliveInterval?: number
  createdAt: number
  updatedAt: number
}

/** 全局快捷键触发的应用动作 */
export type AppShortcutAction =
  | 'open-settings'
  | 'new-session'
  | 'open-command-palette'
  | 'toggle-ai-panel'
  | 'open-scripts'

/**
 * 单条快捷键配置：动作 + Electron accelerator 字符串。
 * accelerator 为空字符串表示「禁用」该动作。
 * 跨平台写法用 `CommandOrControl`（mac 解析为 ⌘、Win/Linux 解析为 Ctrl）。
 */
export interface ShortcutConfig {
  action: AppShortcutAction
  accelerator: string
}

/** 用户保存的脚本：在命令面板（Ctrl+Shift+P）的「运行脚本」中选择后写入并自动执行 */
export interface ScriptEntry {
  id: string
  /** 展示名称，同时用于搜索 */
  name: string
  /** 脚本正文（可多行），选择后原样写入当前终端并执行 */
  content: string
  /** 可选描述，用于搜索与展示 */
  description?: string
  createdAt: number
  updatedAt: number
}

/** 用户笔记：右侧 Monaco 编辑器承载正文，可任意指定语言 */
export interface NoteEntry {
  id: string
  /** 笔记标题，兼作列表展示与搜索 */
  title: string
  /** 笔记正文 */
  content: string
  /** Monaco 语言（见 MONACO_LANGUAGES），缺省按创建时指定，默认 markdown */
  language: string
  createdAt: number
  updatedAt: number
}

/** 一条请求头：以「键值对数组」而非对象保存，保留空行以便在界面上继续编辑 */
export interface ApiHeaderPair {
  key: string
  value: string
}

/**
 * 接口请求分组：侧边栏里的分组节点。
 * 与 SshGroup 不同，这里不设颜色 —— 接口请求的分组只承担「归类 + 排序」。
 */
export interface ApiGroup {
  id: string
  name: string
  createdAt: number
}

/**
 * 保存的接口请求：侧边栏列表项，同时是 PanelView 里「接口请求」标签的打开对象。
 * 一个请求 = 一个标签，所以这里不带「未保存草稿」的概念（新建即落盘）。
 */
export interface ApiRequestEntry {
  id: string
  /** 展示名，缺省由「方法 + 地址」推导（见渲染端 apiNameOf） */
  name: string
  method: string
  url: string
  headers: ApiHeaderPair[]
  body: string
  /**
   * 所属分组；undefined = 未分组。
   * 只由 `api:arrange`（拖拽重排）改动 —— 普通的保存/新建不要碰它，
   * 否则按 Ctrl/Cmd+S 会把请求从分组里踢出去。
   */
  groupId?: string
  createdAt: number
  updatedAt: number
}

/** 请求历史：每次发送后自动记录，按时间倒序保留最近若干条 */
export interface ApiHistoryEntry {
  id: string
  method: string
  url: string
  headers: ApiHeaderPair[]
  body: string
  /** 失败时为 0 */
  status: number
  statusText: string
  timeMs: number
  at: number
}

/** 主进程执行 HTTP 请求的入参 */
export interface ApiHttpRequest {
  method: string
  url: string
  headers?: Record<string, string>
  body?: string
  /** 超时（毫秒） */
  timeoutMs?: number
  /** 跳过 TLS 证书校验（自签证书） */
  rejectUnauthorized?: boolean
  /** 代理地址，如 http://127.0.0.1:7890 */
  proxy?: string
}

/**
 * 请求结果：网络层失败（DNS/超时/证书）不抛异常，而是返回 status=0 + error，
 * 这样界面可以照常展示耗时与错误，无需区分「异常」和「非 2xx」两条路径。
 */
export interface ApiHttpResponse {
  ok: boolean
  status: number
  statusText: string
  headers: Record<string, string>
  body: string
  /** 耗时（毫秒） */
  timeMs: number
  /** 失败时的错误信息 */
  error?: string
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

/** 发起 AI 对话的请求体：可绑定一个终端会话（该会话拥有独立的助手上下文） */
export interface AiChatRequest {
  history: AiChatMessage[]
  /** 对话绑定的终端会话：工具默认作用于此会话，不随当前激活终端变化 */
  targetSessionId?: string | null
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
