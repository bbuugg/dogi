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
  /**
   * Agent 一轮对话结束时发系统通知（仅当应用不在前台），缺省开启。
   * 不关心类型判定的地方读它即可，通知内容与前台判定见 services/system/notify.ts。
   */
  notifyOnAgentFinish: boolean
  /**
   * 关闭标签页前二次确认，缺省开启。
   * 在确认框里勾选「以后都不再提示」会自动把它改成 false（可在设置里重新打开）。
   */
  confirmCloseTab: boolean
  /**
   * 活动栏里被隐藏的功能区 id 列表（缺省空数组 = 全部显示）。
   * 设置里关闭某个功能区后它既不出现在活动栏，也不会被激活。
   */
  hiddenActivities: string[]
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

// ---------- SFTP（远程文件管理，复用 SSH 主机配置的凭据） ----------

/** 远程目录里的一项（SFTP 列表行） */
export interface SftpEntry {
  /** 文件/目录名（不含路径） */
  name: string
  /** 完整远程路径（posix 风格） */
  path: string
  isDir: boolean
  /** 字节（目录无意义，恒为 0） */
  size: number
  /** 最后修改时间（毫秒时间戳；取不到时为 0） */
  mtime: number
}

/** 一次上传/下载/复制/移动的进度（主进程经 'sftp:progress' 推送） */
export interface SftpTransferProgress {
  connId: string
  /** 传输唯一 id（同一连接可并行多笔） */
  transferId: string
  kind: 'upload' | 'download' | 'copy' | 'move'
  /** 文件名（不含目录） */
  name: string
  /** 已传输字节 */
  bytes: number
  /** 总字节（远端未报告时为 0，此时只展示已传字节） */
  total: number
  /** 是否结束（成功；失败见 error） */
  done?: boolean
  error?: string
}

/** 触发系统对话框的上传/下载请求结果 */
export interface SftpTransferResult {
  ok: boolean
  /** 用户在对话框点了取消 */
  canceled?: boolean
  /** 下载成功时的本地保存路径 */
  savedPath?: string
  /** 上传成功时的文件数 */
  count?: number
  error?: string
}

/** 应用内快捷键触发的动作（只在 Dogi 窗口聚焦时生效） */
export type AppShortcutAction =
  | 'open-settings'
  | 'new-session'
  | 'open-command-palette'
  /** 开关 AI Agent 工作区内嵌终端（默认 Ctrl/Cmd+Shift+`） */
  | 'toggle-agent-terminal'

/**
 * 单条快捷键配置：动作 + Electron accelerator 字符串。
 * accelerator 为空字符串表示「禁用」该动作。
 * 跨平台写法用 `CommandOrControl`（mac 解析为 ⌘、Win/Linux 解析为 Ctrl）。
 *
 * 这些是**应用内**快捷键（由渲染端监听 keydown 自行匹配），**不是系统级热键** ——
 * 注册成系统级会占用全局组合键、和别的程序抢，所以刻意不用 Electron 的 globalShortcut。
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
  /**
   * 所属分组；undefined = 未分组。
   * 只由 `scripts:arrange`（拖拽重排）改动 —— 普通的保存/新建不要碰它。
   */
  groupId?: string
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
  /**
   * 所属分组；undefined = 未分组。
   * 只由 `notes:arrange`（拖拽重排）改动 —— 普通的保存/新建不要碰它。
   */
  groupId?: string
  createdAt: number
  updatedAt: number
}

/** 脚本分组：侧边栏里的分组节点（只承担归类 + 排序，不设颜色） */
export interface ScriptGroup {
  id: string
  name: string
  createdAt: number
}

/** 笔记分组：侧边栏里的分组节点（只承担归类 + 排序，不设颜色） */
export interface NoteGroup {
  id: string
  name: string
  createdAt: number
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
 * 接口调试的协议类型。
 * - `http`：一次性请求/响应（缺省值，历史数据里没有该字段的都按 http 处理）
 * - `ws`：长连接，由 `WsPage` 调试，连接与收发消息见 `WsEvent`
 */
export type ApiProtocol = 'http' | 'ws'

/**
 * 保存的接口请求：侧边栏列表项，同时是 PanelView 里「接口请求」标签的打开对象。
 * 一个请求 = 一个标签，所以这里不带「未保存草稿」的概念（新建即落盘）。
 *
 * WebSocket 复用了这张表：`protocol: 'ws'` 时 `method`/`body` 不参与语义
 * （连接靠 `url` + `headers` + `subprotocols`），这样分组、拖拽、搜索、草稿
 * 那一整套都不用再造一份。
 */
export interface ApiRequestEntry {
  id: string
  /** 展示名，缺省由「方法 + 地址」推导（见渲染端 apiNameOf） */
  name: string
  method: string
  url: string
  headers: ApiHeaderPair[]
  body: string
  /** 协议类型；undefined 视为 'http'（兼容历史数据） */
  protocol?: ApiProtocol
  /** 仅 WebSocket：子协议（Sec-WebSocket-Protocol），如 ['graphql-ws'] */
  subprotocols?: string[]
  /**
   * 仅 WebSocket：跳过 TLS 证书校验（wss 自签证书），缺省关闭。
   *
   * 注意取值方向与字段名相反（沿用 undici 的 `connect.rejectUnauthorized`）：
   * **`false` 才是「不校验」**，`true` / 缺省都是正常校验。
   * 所以不需要跳过时应当**不写这个字段**，而不是写 `true`。
   */
  rejectUnauthorized?: boolean
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

// ---------- WebSocket 调试 ----------

/** 打开 WebSocket 连接的入参 */
export interface WsConnectOptions {
  url: string
  /** 附加请求头（握手时带上，如 Authorization / Cookie / Origin） */
  headers?: Record<string, string>
  /** 子协议（Sec-WebSocket-Protocol） */
  protocols?: string[]
  /**
   * 跳过 TLS 证书校验（wss 自签证书）。
   * 与 `ApiRequestEntry.rejectUnauthorized` 同一套取值：**`false` = 不校验**。
   */
  rejectUnauthorized?: boolean
}

/** 连接状态（比 WebSocket.readyState 的数字更好读，渲染端直接用这个） */
export type WsReadyState = 'connecting' | 'open' | 'closing' | 'closed'

/**
 * `ws:open` 的结果。
 *
 * 不抛异常（与 `executeHttp` 的约定一致）：
 * - `error`：连地址都没通过校验 / 构造 socket 就失败了，渲染端直接显示失败；
 * - `warning`：连上了但降级了（例如环境缺 undici，自定义请求头被忽略）。
 * 握手本身的结果（成功或失败）不在这里，而是走 `WsEvent`。
 */
export interface WsOpenResult {
  connId: string
  error?: string
  warning?: string
}

/** 待发送的一帧 */
export interface WsSendPayload {
  data: string
  encoding: 'text' | 'base64'
}

/**
 * 主进程 → 渲染端的连接事件。
 *
 * 每条事件都带 `connId`：同时可能有好几个 WebSocket 标签各自连着，
 * 渲染端只处理自己那条连接的事件（见 WsPage 的过滤）。
 */
export type WsEvent =
  | { connId: string; type: 'open'; protocol: string }
  | {
      connId: string
      type: 'message'
      /** 文本帧给原文；二进制帧给 base64（由 `encoding` 区分） */
      data: string
      encoding: 'text' | 'base64'
      /** 原始字节数（文本帧是 utf8 字节数，用于界面显示体积） */
      bytes: number
      at: number
    }
  | { connId: string; type: 'close'; code: number; reason: string; at: number }
  | { connId: string; type: 'error'; message: string }

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
  /**
   * 默认模型 id（兼容旧数据/必填主键）。
   * 配置支持挂多个模型 id（`models`），会话按「模型配置 / 模型 id」两级选择，
   * 发送时把选中的 id 经请求的 `modelId` 传给主进程。
   */
  model: string
  /** 配置下可选的全部模型 id（含 `model`；单模型时可缺省） */
  models?: string[]
  /** 仅 openai / openai-compatible 有效；缺省按 kind 取默认 */
  apiStyle?: AiApiStyle
  temperature?: number
  maxTokens?: number
  /** 携带的历史消息条数 */
  contextMessages?: number
  createdAt: number
  updatedAt: number
}

// ---------- 技能（Agent Skills 约定：目录 + SKILL.md） ----------

/**
 * 技能来源。发现顺序即优先级（同一个目录被多个来源覆盖时先到先得）：
 * - `workspace` 当前工作区的 `<工作区>/.dogi/skills`（跟项目走）
 * - `user`      用户级 `~/.dogi/skills`（跨项目复用）
 * - `agents`    跨智能体共享的 `~/.agents/skills`（vercel-labs 的 skills CLI 及
 *               amp / codex / cursor / claude-code / opencode / trae 等一批 agent 都读它，
 *               本机实测存在，技能用 `SKILL.md` + frontmatter，格式与本项目一致）
 * - `claude`    兼容既有生态的 `~/.claude/skills`
 * - `custom`    用户在设置里手动添加的技能根目录
 */
export type SkillSource = 'workspace' | 'user' | 'agents' | 'claude' | 'custom'

/** 一个已发现的技能（磁盘就是唯一真源，这里只是扫描结果的投影） */
export interface SkillInfo {
  /** 技能 id：SKILL.md 的绝对路径（唯一、稳定；启停状态按它记） */
  id: string
  name: string
  description: string
  /** 技能目录绝对路径 */
  dir: string
  /** SKILL.md 绝对路径 */
  file: string
  source: SkillSource
  /** 来源根目录（设置页按它分组 / 打开） */
  root: string
}

/** 一个技能根目录的扫描情况（UI 用来显示「扫了哪些地方」） */
export interface SkillRootInfo {
  source: SkillSource
  dir: string
  /** 目录是否存在（不存在的目录不会自动创建） */
  exists: boolean
  /** 该根目录下发现多少个技能 */
  count: number
}

/** 技能的用户配置：启停 + 额外根目录（技能内容在磁盘上，这里只记用户的选择） */
export interface SkillSettings {
  /** 被停用的技能 id —— 默认全开，新加的技能自动生效 */
  disabled: string[]
  /** 额外技能根目录（绝对路径） */
  extraDirs: string[]
}

/** `skills:list` 的返回体：一次拿全，免得 UI 分几次请求 */
export interface SkillListResult {
  skills: SkillInfo[]
  roots: SkillRootInfo[]
  settings: SkillSettings
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

/**
 * AI Agent 后端：
 * - ai-sdk：内置 AI SDK 驱动（复用模型配置），工具由应用自己提供
 * - acp：连接外部 ACP agent（如 codex-acp），应用作为 ACP 客户端
 */
export type AgentBackend = 'ai-sdk' | 'acp'

/** ACP 后端的外部 agent 启动配置（stdio 通信） */
export interface AcpAgentConfig {
  id: string
  /** 显示名称，如 Codex CLI / Gemini CLI */
  name: string
  /** 可执行文件（绝对路径或 PATH 可解析名；Windows 下 npm 脚本需 .cmd 后缀） */
  command: string
  args: string[]
  /**
   * 从该 agent 拉取（session/new 的 configOptions，category=model）并勾选的模型 id 列表。
   * 空 = 未选择，使用 agent 自己的当前模型。
   */
  models?: string[]
}

/** 本地 PATH 中检测到的已知 ACP agent */
export interface DetectedAcpAgent {
  /** 展示名称 */
  name: string
  /** 可执行命令（PATH 可解析名） */
  command: string
  /** 建议的启动参数（如 gemini -> ["--acp"]） */
  args: string[]
  /** 解析到的绝对路径 */
  path: string
}

export interface AiSettings {
  activeConfigId?: string
  /** AI 执行终端命令的权限模式；在对话输入框处实时切换 */
  permissionMode: AiPermissionMode
  systemPrompt?: string
  /** 预定义的 ACP agent 配置（设置页维护，工作区在 AI Agent 模型下拉处选择） */
  acpAgents?: AcpAgentConfig[]
  /** 当前 ACP 后端使用的配置 id（缺省取 acpAgents[0]） */
  activeAcpId?: string
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

// ---------- ask_followup_question：AI 向用户提结构化选择题 ----------

/** 一个选项的展示形态：纯文本，或带说明的对象 */
export interface FollowupOption {
  label: string
  description?: string
}

/**
 * 一道题：由主进程归一化后发给渲染端。
 *
 * `id` 由主进程补齐（模型没给就按 `q1`/`q2`... 生成），渲染端/工具结果都靠它对齐。
 * `multiSelect` 区分单选 / 多选；`options` 已是纯 `label`+`description` 形态。
 */
export interface FollowupQuestion {
  id: string
  question: string
  /** 极短标签（≤12 字），作为卡片上的小标签 */
  header: string
  options: FollowupOption[]
  multiSelect: boolean
}

/**
 * AI 通过 `ask_followup_question` 工具向用户发起的提问表单。
 *
 * 主进程发起 → 渲染端在对话流里渲染成一张可回答的卡片（一题一区，底部统一提交）→
 * 用户作答 → IPC 回填 → 工具 resolve，**同一个 streamText 回合继续往下跑**（机制同确认卡）。
 */
export interface AskFollowupRequest {
  /** 提问表单 id，回答时原样带回 */
  id: string
  /** 所属对话请求 id（中止 / 流结束时按「跳过」清理） */
  requestId: string
  /** 发起这次提问的工具调用 id —— 渲染端据此把卡片插到对话流的正确位置 */
  toolCallId: string
  /** 可选表单标题 */
  title?: string
  questions: FollowupQuestion[]
  /** 归属的终端会话（终端 AI 助手才有）：卡片被折叠挡住时用它把面板撑开 */
  sessionId?: string
}

/** 单题答案：选中项的 label 列表 */
export interface FollowupAnswerItem {
  id: string
  question: string
  selected: string[]
}

/**
 * 用户对整张表单的回答，作为工具结果回给模型。
 */
export interface AskFollowupAnswer {
  answers: FollowupAnswerItem[]
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
  /**
   * 本次对话使用的模型配置 id（**每个终端会话各自独立**）。
   * 缺省时回退到设置里的默认模型（`aiSettings.activeConfigId`）。
   */
  configId?: string
  /** 配置下的具体模型 id（配置挂了多个模型时按会话选择）；缺省用配置的 `model` */
  modelId?: string
}

export type AiMessagePart =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
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
  /** 模型思考内容增量（推理模型 / 思考型模型） */
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

// ---------- AI Agent（工作区编程/运维助手） ----------

/** Agent 工作区：绑定的本地目录，工具只能在工作区内读写与执行命令 */
export interface AgentWorkspace {
  id: string
  /** 展示名（默认取目录名，可改） */
  name: string
  /** 绝对路径 */
  path: string
  /** 该工作区使用的 Agent 后端（每会话独立，在模型下拉处切换）；缺省 ai-sdk */
  backend?: AgentBackend
  createdAt: number
  updatedAt: number
}

/** Agent 聊天消息（与 AiChatMessage 同构，part 形状一致） */
export interface AgentChatMessage {
  id: string
  role: 'user' | 'assistant'
  parts: AgentMessagePart[]
  createdAt: number
}

/** 工作区目录项（文件树用；`path` 相对工作区根、统一 '/' 分隔） */
export interface AgentFsEntry {
  name: string
  path: string
  type: 'file' | 'dir'
}

/** 读到的文件内容（编辑器用；二进制与超大文件在主进程就被挡掉） */
export interface AgentFsFile {
  path: string
  content: string
  /** 字节数 */
  size: number
}

/**
 * Agent 会话：一个工作区下可以有多个独立会话。
 *
 * 消息随会话一起持久化 —— 会话列表的意义就是能随时切回去接着聊，
 * 而 ACP 后端的 agent 上下文按会话隔离（见 services/ai/acp-agent.ts）。
 */
export interface AgentConversation {
  id: string
  /** 所属工作区 id */
  workspaceId: string
  /** 标题（默认由首条用户消息截断生成，可重命名） */
  title: string
  /** 该会话的完整消息历史 */
  messages: AgentChatMessage[]
  /**
   * 该会话使用的后端与选中项 —— **按会话独立**，互不影响。
   * - 未设置 `backend` 时回退到工作区的 `backend`；
   * - `configId` 的含义由 `backend` 决定：`ai-sdk` 下是 `AiModelConfig.id`，
   *   `acp` 下是 `AcpAgentConfig.id`；未设置时回退到设置里的默认模型 / 默认 ACP 预置。
   */
  backend?: AgentBackend
  configId?: string
  /** 具体模型 id：`ai-sdk` 下是配置里的模型 id；`acp` 下是 agent 上报的模型 value。缺省用配置/agent 默认 */
  modelId?: string
  createdAt: number
  updatedAt: number
}

export type AgentMessagePart =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
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

/** 发起 Agent 对话的请求体：绑定一个工作区（工具全部作用于该目录）+ 一个会话 */
export interface AgentChatRequest {
  workspaceId: string
  /** 会话 id：ACP 后端据此复用 / 新建独立的 agent session（不同会话不共享上下文） */
  conversationId: string
  history: AgentChatMessage[]
  /** 本次对话使用的后端；缺省回退到会话记录 / 工作区设置 */
  backend?: AgentBackend
  /**
   * 本次对话选中的 id —— 含义由 `backend` 决定：
   * `ai-sdk` 下是 `AiModelConfig.id`，`acp` 下是 `AcpAgentConfig.id`。
   * 缺省回退到设置里的默认模型 / 默认 ACP 预置。
   */
  configId?: string
  /** 具体模型 id：`ai-sdk` 下是配置里的模型 id；`acp` 下是 agent 上报的模型 value */
  modelId?: string
}

/** Agent 流事件（形状与 AiStreamEvent 一致；reasoning-delta 为思考内容增量） */
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

/** Agent 确认模式下 execute_command 执行前的主进程请示 */
export interface AgentConfirmRequest {
  /** 确认请求 id，回复时原样带回 */
  id: string
  /** 所属 Agent 对话请求 id */
  requestId: string
  toolCallId: string
  toolName: string
  /** 待执行的命令 */
  command: string
  workspaceId?: string
  workspaceName?: string
}

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

/** 系统已安装 IDE 的启动信息（由主进程按平台探测：Windows/macOS/Linux 路径与 PATH 命令） */
export interface IdeInfo {
  id: string
  name: string
  /** 可直接 spawn 的命令（完整路径，或 PATH 内命令名） */
  command: string
  /** 固定前置参数（如 macOS 的 open -a <app>）；打开目录时在末尾追加目录参数 */
  args?: string[]
}

/** 系统打开操作的结果（openFileManager / openTerminal / openIde 共用） */
export interface OpenResult {
  ok: boolean
  error?: string
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

// ---------- 数据导入 / 导出（左下角菜单：主机 / 笔记 / 接口请求 打成 zip） ----------

/** 可导入 / 导出的数据类型（一种类型 = 压缩包里的一个 JSON 文件） */
export type TransferKind = 'hosts' | 'notes' | 'api'

/**
 * 压缩包里单个 JSON 文件的结构。
 *
 * 三类数据共用这一个外壳（`kind` 区分），分组与条目分开存：
 * 导入时先写分组再写条目，条目里的 `groupId` 才指得到东西。
 */
export interface TransferPayload {
  /** 数据格式版本（不兼容时拒绝导入） */
  version: 1
  kind: TransferKind
  exportedAt: number
  /** 分组（笔记 / 接口 / 主机的分组表） */
  groups: unknown[]
  /** 条目：笔记 / 接口请求 / 主机配置 */
  items: unknown[]
}

/** 解析出的一个「可导入项」：对应压缩包里的一个文件 */
export interface TransferEntry {
  kind: TransferKind
  /** 压缩包内的文件名，如 hosts.json */
  file: string
  /** 条目数（不含分组） */
  itemCount: number
  /** 分组数 */
  groupCount: number
}

/** 导出结果 */
export interface TransferExportResult {
  ok: boolean
  /** 用户在保存对话框里取消了 */
  canceled?: boolean
  /** 保存到的 zip 路径 */
  path?: string
  /** 各类型实际导出的条目数（分组不计入） */
  counts?: Partial<Record<TransferKind, number>>
  error?: string
}

/** 选择并解析导入包的结果（内容暂存在主进程，bundleId 是它的句柄） */
export interface TransferPickResult {
  ok: boolean
  canceled?: boolean
  bundleId?: string
  entries?: TransferEntry[]
  error?: string
}

/** 执行导入的结果 */
export interface TransferImportResult {
  ok: boolean
  /** 各类型新增的条目数 */
  added?: Partial<Record<TransferKind, number>>
  /** 各类型覆盖更新（id 已存在）的条目数 */
  updated?: Partial<Record<TransferKind, number>>
  error?: string
}
