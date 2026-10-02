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

/**
 * 笔记（本地 Markdown 文件）的保存时机。
 *
 * - `immediate`：改完立即写盘（不等待）
 * - `delay`：停止输入若干秒后写盘（秒数见 `Preferences.noteAutoSaveDelay`）
 * - `manual`：只在你点保存 / Ctrl+S 时写盘，改动留在编辑器里（缺省）
 */
export type NoteSaveMode = 'immediate' | 'delay' | 'manual'

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
   * 笔记（本地 Markdown 文件）的保存时机，**缺省 `manual`**。
   *
   * 手动模式下改动只留在编辑器里（状态栏显示「未保存」），点保存按钮 / Ctrl+S 才写盘；
   * 关闭标签前若有未保存改动会弹「不保存 / 保存并关闭 / 取消」。
   */
  noteSaveMode: NoteSaveMode
  /** `noteSaveMode === 'delay'` 时，停止输入多少秒后自动保存（1–60，缺省 2） */
  noteAutoSaveDelay: number
  /**
   * 活动栏里被隐藏的功能区 id 列表（缺省空数组 = 全部显示）。
   * 设置里关闭某个功能区后它既不出现在活动栏，也不会被激活。
   */
  hiddenActivities: string[]
  /**
   * 自动化面板使用哪个浏览器，缺省 auto（自带 Chromium → Edge → Chrome 逐级回退）。
   * 解析逻辑见 services/browser/resolver.ts。
   */
  browserChannel: BrowserChannel
  /**
   * 给 AI 用的浏览器工具来自哪里，**缺省 `in-app`**（见 BrowserToolMode）。
   *
   * 一个开关管「有没有浏览器能力」，一个二选一管「用哪套引擎」：两套工具**同名**
   * （`browser_navigate` 等），同时注册会互相覆盖，所以只能二选一。
   */
  browserToolMode?: BrowserToolMode
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

/**
 * 本地 mosh-client 探测结果（新建 / 编辑 Mosh 主机时提示，连接前也用它做前置检查）：
 * - native：本机直接可执行（MSYS2 / Cygwin / brew / 系统包）
 * - wsl：Windows 无原生客户端时回退到 WSL 内执行
 * - none：两处都没有，hint 给出安装指引
 */
export interface MoshClientStatus {
  kind: 'native' | 'wsl' | 'none'
  /** native：mosh-client 可执行文件路径；wsl：发行版内的 mosh-client 路径 */
  path?: string
  /** kind=none 时的安装指引 / 诊断信息 */
  hint?: string
}

export type SessionType = 'local' | 'ssh'

/**
 * 主机平台：SSH 会话就绪后探测一次（`cmd /c ver` → Windows，否则 `uname -s`）并
 * 记在会话上；探测失败保持缺省（undefined）。监控采集、AI 提示等据此分支。
 */
export type HostPlatform = 'linux' | 'windows' | 'other'

export interface SessionInfo {
  id: string
  type: SessionType
  title: string
  profileId?: string
  pid?: number
  createdAt: number
  /** 会话是否已退出 */
  exited: boolean
  /** 是否为 Mosh 会话（SSH 引导 + 本地 mosh-client，见 4.12）；仅用于展示区分 */
  mosh?: boolean
  /** 探测到的主机平台；未探测 / 探测失败时为 undefined */
  platform?: HostPlatform
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
  /** 补充说明（有跳板机时标注当前正在连接哪一跳，如「跳板 1/2：root@10.0.0.1」） */
  detail?: string
}

export type SshAuthType = 'password' | 'privateKey'

/** 主机类型：远程 SSH / 远程桌面 RDP / 本地终端 */
export type HostKind = 'ssh' | 'rdp' | 'local'

/**主机分组：仅用于侧边栏归类；删除分组时组内连接回到「未分组」 */
export interface SshGroup {
  id: string
  name: string
  /** 分组强调色（CSS 颜色字符串）；组内连接默认继承，可被连接自身的 color 覆盖 */
  color?: string
  createdAt: number
}

/** 终端字符集：SSH 会话的输入 / 输出字符集（缺省 = utf-8） */
export type TerminalCharset = 'utf-8' | 'gbk'

export interface SshProfile {
  id: string
  /** 主机类型：ssh 远程连接 / rdp 远程桌面 / local 本地终端 */
  kind: HostKind
  /** 所属分组 id；缺省表示未分组 */
  groupId?: string
  /** 连接自身的强调色；缺省表示继承所属分组的颜色 */
  color?: string
  name: string
  /** ssh / rdp：主机地址 */
  host: string
  /** ssh / rdp：端口（名称随 kind 变化：SSH 默认 22，RDP 默认 3389） */
  port: number
  /** ssh / rdp：登录用户名 */
  username: string
  authType: SshAuthType
  /** ssh / rdp：仅用于传输，存储时主进程会用 safeStorage 加密，读取列表时不返回 */
  password?: string
  privateKey?: string
  passphrase?: string
  /** 是否已保存密码（脱敏展示用） */
  hasPassword?: boolean
  hasPrivateKey?: boolean
  hasPassphrase?: boolean
  /** 仅 rdp：登录域（AD 域账号填域名，本机账户留空） */
  domain?: string
  /** 仅 local：启动环境（可执行文件，PATH 可解析） */
  command?: string
  /** 仅 local：启动参数 */
  args?: string[]
  /** 仅 local：终端启动后自动执行的命令 */
  autoCommand?: string
  /**
   * 仅 ssh：用 Mosh 连接（UDP 抗断线）——SSH 只负责引导 mosh-server，
   * 终端数据走本地 mosh-client。需远端安装 mosh-server、本地有 mosh-client。
   */
  useMosh?: boolean
  /**
   * 仅 ssh：跳板机（另一条 ssh 配置的 id）。连接时先连跳板机，再经它
   * forwardOut 到目标；支持多级串联，循环由运行时检测并拒绝。
   * 与 Mosh 互斥（mosh 走 UDP，无法经 SSH 隧道）。
   */
  jumpProfileId?: string
  /**
   * 仅 ssh：终端字符集。中文 Windows 服务器（控制台代码页 936）上老程序输出
   * GBK、终端显示乱码时切到 gbk；缺省 utf-8（Linux 主机的标准情况）。
   */
  terminalCharset?: TerminalCharset
  keepaliveInterval?: number
  createdAt: number
  updatedAt: number
}

// ---------- SSH 隧道（本地转发 / 远程转发 / SOCKS5 动态代理） ----------

/** 隧道类型：local 本地转发（-L）；remote 远程转发（-R）；dynamic 动态 SOCKS5 代理（-D） */
export type SshTunnelType = 'local' | 'remote' | 'dynamic'

export interface SshTunnel {
  id: string
  /** 承载连接的主机配置 id（凭据在主进程按它解密） */
  profileId: string
  type: SshTunnelType
  /** 监听侧地址：local/dynamic 在本机监听（默认 127.0.0.1）；remote 在服务器上监听 */
  bindHost: string
  /** 监听侧端口 */
  bindPort: number
  /** 目标侧地址：local 为远端解析的目标；remote 为本机可达的目标（仅 dynamic 不用） */
  targetHost?: string
  /** 目标侧端口（仅 local / remote） */
  targetPort?: number
  /** 备注（列表展示用） */
  label?: string
  /** 应用启动后自动拉起 */
  autoStart?: boolean
  createdAt: number
  updatedAt: number
}

export type SshTunnelStatus = 'stopped' | 'starting' | 'running' | 'error'

/** 隧道运行时状态（主进程推送；渲染端只读展示） */
export interface SshTunnelRuntime {
  id: string
  status: SshTunnelStatus
  /** 仅 error：最近一次失败的描述 */
  error?: string
  /** 当前活跃的转发连接数 */
  conns?: number
  startedAt?: number
}

// ---------- 主机密钥指纹（known_hosts，TOFU 校验） ----------

/** 一条已记录的主机密钥指纹（首次连接静默记录；指纹变化时连接硬失败） */
export interface SshKnownHost {
  host: string
  port: number
  /** 密钥算法（从密钥 blob 解析，如 ssh-ed25519） */
  algo: string
  /** SHA256 指纹（sha256 摘要的 base64，无填充，与 OpenSSH SHA256: 风格一致） */
  fingerprint: string
  addedAt: number
}

// ---------- 主机日志（SSH / 终端命令 / 隧道 / SFTP 等主机相关事件） ----------

/** 日志级别（error 用于失败与意外中断） */
export type HostLogLevel = 'info' | 'warn' | 'error'

/** 日志分类：按产生日志的子系统划分，界面按它过滤 */
export type HostLogScope = 'ssh' | 'terminal' | 'tunnel' | 'sftp' | 'rdp'

/**
 * 一条主机日志（主进程的 hostLogger 追加；渲染端只读展示）。
 * 内存环形缓冲 + userData/logs/host.log（JSONL）落盘，跨重启保留。
 * ⚠️ 同一 seq 可能被再次广播（终端命令的输出增量回填同一条目，后到覆盖先到；
 * 落盘文件同 seq 后写覆盖先写）——按 seq 覆盖，不要盲目 push。
 */
export interface HostLogEntry {
  /** 自增序号（进程内唯一，重启后从落盘的最大值继续），渲染端用作 key */
  seq: number
  /** 时间戳（毫秒） */
  ts: number
  scope: HostLogScope
  level: HostLogLevel
  /** 一句话描述（单行） */
  message: string
  /** 补充细节（可选，多行；界面折叠展示） */
  detail?: string
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
  /**
   * 本地侧绝对路径：上传 = 源文件，下载 = 目标文件（复制 / 移动没有）。
   * 完成后任务面板据此提供「打开文件位置」。
   */
  localPath?: string
  /** 是否结束（成功；失败见 error，用户取消见 canceled） */
  done?: boolean
  /** 用户手动取消（按「已取消」展示，不当作错误；不提供打开文件位置） */
  canceled?: boolean
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

/** 脚本分组：侧边栏里的分组节点（只承担归类 + 排序，不设颜色） */
export interface ScriptGroup {
  id: string
  name: string
  createdAt: number
}

// ---------------------------------------------------------------------------
// 笔记（Milkdown 编辑器 + 本地文件）
// ---------------------------------------------------------------------------

/**
 * 笔记文件树节点：侧边栏展示本地文件夹里的 Markdown 文件。
 * 目录节点有 children，文件节点没有。
 */
export interface NoteFileItem {
  /** 相对于已打开文件夹根的路径（根目录下文件 = 文件名；子目录文件 = dir/sub/file.md） */
  path: string
  /** 显示名（不含路径前缀） */
  name: string
  /** 是否目录 */
  isDir: boolean
  /** 子项（仅目录有） */
  children?: NoteFileItem[]
}

/** 笔记文件读取结果 */
export interface NoteFileContent {
  /** 文件路径（绝对路径） */
  path: string
  /** 文件内容（Markdown） */
  content: string
  /** 文件修改时间（ms） */
  mtime: number
}

/**
 * 笔记会话：重启后恢复上次打开的目录与文件标签。
 *
 * 笔记直接对应本地文件，打开状态本身不在磁盘上，所以得单独记一份。
 * 只记「目录列表 + 文件路径」，内容永远以磁盘为准，不做二次缓存。
 */
export interface NoteSession {
  /** 已打开的笔记目录绝对路径（顺序 = 侧边栏顺序；同一目录只出现一次，父子可同时打开） */
  folders: string[]
  /** 上次打开的笔记文件绝对路径（按标签顺序） */
  files: string[]
}

/** 旧版笔记数据（仅用于数据传输兼容，新笔记不再使用 electron-store 存储） */
export interface NoteEntry {
  id: string
  title: string
  content: string
  language: string
  groupId?: string
  createdAt: number
  updatedAt: number
}

/** 旧版笔记分组（仅用于数据传输兼容） */
export interface NoteGroup {
  id: string
  name: string
  createdAt: number
}

// ---------------------------------------------------------------------------
// 浏览器（AI 的浏览器工具与内嵌面板共用一套会话）
// ---------------------------------------------------------------------------

/**
 * 浏览器会话用哪个浏览器。
 * - `auto`：自带 Chromium（若已下载）→ Edge → Chrome，逐级回退
 * - `bundled`：Playwright 自带的 Chromium（需要先下载）
 * - `msedge` / `chrome`：系统的 Edge / Chrome（Windows 上 Edge 必定存在）
 *
 * ⚠️ Playwright 版本与自带 Chromium 的 build 号是绑死的：装 1.63 却只有
 * 别的 build 缓存时会直接报「Executable doesn't exist」，所以默认 auto 要先探测。
 */
export type BrowserChannel = 'auto' | 'bundled' | 'msedge' | 'chrome'

/**
 * 给 AI 用的浏览器工具来自哪里（`preferences.browserToolMode`）。
 *
 * - `off`：**一个都不给** —— Agent 拿不到任何 `browser_*` 工具，浏览器面板仍可手动使用；
 * - `in-app`（默认）：应用自带的浏览器工具 —— 浏览器无窗口运行，画面经 screencast
 *   镜像到界面里的浏览器面板（不弹本机窗口）；
 * - `system`：改用内置的 Playwright MCP —— 独立进程，会拉起**本机**的 Edge / Chrome 窗口。
 *
 * ⚠️ 自带与 MCP 两套工具**同名**（`browser_navigate` 等），同时注册会静默互相覆盖，
 * 所以这里是三态而不是「开关 + 开关」。
 */
export type BrowserToolMode = 'off' | 'in-app' | 'system'

/**
 * 浏览器视口预设：`desktop` = PC 屏，`mobile` = 手机屏。
 *
 * 具体尺寸 / deviceScaleFactor 见 `@shared/browser` 的 `BROWSER_VIEWPORT_PRESETS` ——
 * 它决定页面的 layout viewport，也就决定响应式断点走哪一套（这才是「手机版」的本质）。
 */
export type BrowserViewportMode = 'desktop' | 'mobile'

/** 浏览器会话状态（主进程推给渲染端，渲染端据此画地址栏与按钮态） */
export interface BrowserSessionState {
  sessionId: string
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  /** 页面视口尺寸（CSS px），渲染端按它把面板坐标映射回页面坐标 */
  viewport: { width: number; height: number }
  /** 当前视口预设（PC / 手机） */
  viewportMode: BrowserViewportMode
  /** 实际使用的浏览器（启动后确定，如 'msedge' / 'chromium'），未启动为 null */
  channel: string | null
}

/** 一帧 screencast 画面。`data` 是不带 `data:` 前缀的 base64 JPEG */
export interface BrowserFrame {
  sessionId: string
  data: string
  width: number
  height: number
}

/** 鼠标键（与 CDP 的取值一致） */
export type BrowserMouseButton = 'none' | 'left' | 'middle' | 'right' | 'back' | 'forward'

/**
 * 渲染端 → 主进程的合成输入。
 *
 * 坐标一律是**页面视口坐标系**（渲染端负责从面板像素映射过来），
 * 主进程只做「语义 → CDP 命令」的翻译，翻译逻辑在 services/browser/input.ts。
 * `modifiers` 是 CDP 的位掩码：Alt=1 / Ctrl=2 / Meta=4 / Shift=8。
 */
export type BrowserInputEvent =
  | {
      kind: 'mouse'
      type: 'mouseMoved' | 'mousePressed' | 'mouseReleased'
      x: number
      y: number
      button: BrowserMouseButton
      clickCount: number
      modifiers: number
    }
  | {
      kind: 'wheel'
      x: number
      y: number
      deltaX: number
      deltaY: number
      modifiers: number
    }
  | {
      kind: 'key'
      type: 'keyDown' | 'keyUp'
      /** 已按修饰键处理过的 key（如 Shift+a → 'A'） */
      key: string
      /** 物理键位（如 'KeyA'），CDP 需要它才能正确触发快捷键 */
      code: string
      /** keyDown 时的可打印文本；不可打印键省略 */
      text?: string
      windowsVirtualKeyCode: number
      modifiers: number
    }
  /** 输入法 / 粘贴这类不经过按键的文本，走 Input.insertText */
  | { kind: 'text'; text: string }

/** 已发现的浏览器可执行文件（主进程挑浏览器用，见 services/browser/resolver.ts） */
export interface BrowserCandidate {
  /** 与 BrowserChannel 对应，但排除了 auto */
  channel: 'bundled' | 'msedge' | 'chrome'
  label: string
  /** 可执行文件绝对路径；bundled 未下载时为 null */
  path: string | null
  /** 是否可用（文件真实存在） */
  available: boolean
}

/** 一条请求头：以「键值对数组」而非对象保存，保留空行以便在界面上继续编辑 */
export interface ApiHeaderPair {
  key: string
  value: string
}

/**
 * 请求体类型（接口调试页「请求体」分段的三选一 + none）：
 * - `none`：**不携带请求体**，发送时不带 body（Content-Type 也原样不动）；
 * - `raw`（**缺省**，兼容历史数据）：一段自由文本，高亮语言由 Content-Type 推导；
 * - `x-www-form-urlencoded`：键值对表单，发送时序列化成 `a=1&b=2`；
 * - `form-data`：`multipart/form-data`，字段可标成「文件」并选本地文件上传。
 */
export type ApiBodyType = 'none' | 'raw' | 'x-www-form-urlencoded' | 'form-data'

/**
 * 表单字段（`x-www-form-urlencoded` 与 `form-data` 共用同一行结构）。
 * 两种模式**各存一份列表**：来回切换时不会把另一种模式填的内容冲掉。
 */
export interface ApiFormField {
  key: string
  value: string
  /**
   * **仅 `form-data` 生效**：该字段是文件，`value` 是本地绝对路径，
   * 主进程发送时读这个文件作为 multipart 的文件部分（文件名取路径末段）。
   */
  isFile?: boolean
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
  /** 请求体类型；undefined 视为 'raw'（兼容历史数据） */
  bodyType?: ApiBodyType
  /** `x-www-form-urlencoded` 的键值对（`bodyType` 不是它时只是留着，不参与发送） */
  bodyUrlencoded?: ApiHeaderPair[]
  /** `form-data` 的字段（`bodyType` 不是它时只是留着，不参与发送） */
  bodyFormFields?: ApiFormField[]
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
  /** 请求体类型；undefined 视为 'raw'（见 ApiRequestEntry.bodyType） */
  bodyType?: ApiBodyType
  /** `x-www-form-urlencoded` 的键值对 */
  bodyUrlencoded?: ApiHeaderPair[]
  /** `form-data` 的字段（文件字段存的是当时的本地路径，载入后可能已失效） */
  bodyFormFields?: ApiFormField[]
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
  /** `raw` 模式的正文（bodyType 缺省 / 'raw' 时使用） */
  body?: string
  /** 请求体类型；缺省视为 'raw' */
  bodyType?: ApiBodyType
  /** `x-www-form-urlencoded` 的键值对（bodyType 为它时使用） */
  urlencoded?: ApiHeaderPair[]
  /** `form-data` 的字段（bodyType 为它时使用；isFile 字段由主进程读本地文件） */
  formFields?: ApiFormField[]
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

/**
 * `api:pickFile` 的结果：为 `form-data` 的文件字段选一个本地文件。
 * 取消时只有 `canceled: true`；所选文件读不到时给 `error`（不抛异常，与 executeHttp 的约定一致）。
 */
export interface ApiPickFileResult {
  canceled: boolean
  file?: {
    /** 本地绝对路径（就是要存进 ApiFormField.value 的东西） */
    path: string
    /** 文件名（界面展示用；发送时也用它当 multipart 的 filename） */
    name: string
    /** 字节数 */
    size: number
  }
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
  /**
   * 上下文预算（token）：历史转成请求前先估算 token，超过它就触发**上下文压缩**
   * （旧轮摘要成一段、保留近期原文，见 services/ai/context.ts）。
   * 缺省 80k；接大上下文模型时可以调大。
   *
   * 与 contextMessages 是两道独立的闸：前者按**条数**截断（先过），后者按 **token**
   * 决定要不要摘要（后过）。两道都过不了的极端情况（单轮就超预算）不压缩。
   */
  contextBudget?: number
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
 * AI **改动**的权限模式（可在对话输入框处实时切换，工作区 Agent 与终端 AI 助手共用一份）：
 * - full：全部访问，AI 可直接执行命令、读写文件
 * - confirm：变更前确认，AI 每次执行命令 / 写入 / 编辑 / 删除前都要用户确认，用户可取消
 *
 * 终端 AI 助手只有「执行命令」会被拦（它的工具就是终端操作）；工作区 Agent 还会拦
 * 写文件 / 编辑 / 删除 —— 见 agent-core/tools.ts 的 guardWrite。
 */
export type AiPermissionMode = 'full' | 'confirm'

/**
 * AI Agent 的两种形态（**一个会话固定是其中一种，创建后不可互切**）：
 * - mastra：应用自带的 Mastra agent（复用模型配置与内置工具，**消息由本应用管理**）
 * - acp：本机某个外部 ACP agent（如 codex-acp），**消息与会话都由该 agent 自己管理**，
 *   本应用只保存「绑定关系」（acpAgentId + acpSessionId）。
 *
 * 模型可以切换（mastra 换模型配置 / ACP 走 set_config_option），但 **ACP 绑定不能换**。
 */
export type AgentBackend = 'mastra' | 'acp'

/** ACP 后端的外部 agent 启动配置（stdio 通信） */
export interface AcpAgentConfig {
  id: string
  /** 显示名称，如 Codex CLI / Gemini CLI */
  name: string
  /** 可执行文件（绝对路径或 PATH 可解析名；Windows 下 npm 脚本需 .cmd 后缀） */
  command: string
  args: string[]
  /**
   * 启动 agent 时注入的环境变量。
   * GUI 应用的主进程不会继承 shell 里的变量（尤其 macOS 上 `.zshrc`/`.bashrc` 不生效），
   * 像 Claude Code 这类依赖 `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL` 的 agent 必须在这里显式传，否则连不上。
   */
  env?: Record<string, string>
  /**
   * 可切换的模型 id 列表 —— **在设置页里从 agent 拉取（`session/new` 的 configOptions）
   * 或手工填写并勾选**，是 AI Agent 会话模型下拉的**唯一来源**。
   *
   * 留空 = 不限制 / 未配置：会话页不列出该 agent 的模型，模型由 agent 自己的当前档位决定。
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

/**
 * ACP agent 侧的一个会话（`session/list` 的返回项）。
 *
 * 这是「导入模式」的数据源：应用不管理 ACP 会话内容，只把它的 id 绑到本地会话记录上。
 */
export interface AcpSessionInfo {
  /** agent 侧的会话 id */
  sessionId: string
  /** 该会话的工作目录（绝对路径） */
  cwd: string
  /** agent 给的标题（可能没有） */
  title?: string
  /** 最近活动时间（ISO 8601，可能没有） */
  updatedAt?: string
}

/** ACP agent 上报的模型选择项（session/new | session/load 的 configOptions 里 category=model 的那项） */
export interface AcpModelList {
  /** 该模型选择项的 configOption id（会话内切换时回传 set_config_option 用） */
  optionId: string
  /** agent 当前选中的模型 value */
  currentValue: string
  models: Array<{ value: string; name: string }>
}

/**
 * ACP 会话的运行时状态（agent 侧会话 id + 可切换的模型列表），
 * 由主进程在会话就绪（session/new | session/load）后广播给渲染端。
 */
export interface AcpConversationState {
  conversationId: string
  /** agent 侧的会话 id（新建会话时由 session/new 返回后回填本地会话记录） */
  acpSessionId: string
  /** agent 是否支持 session/load（不支持时导入的历史看不到，只能看实时输出） */
  canLoad: boolean
  /** agent 上报的模型选择项；null = 该 agent 不上报模型（模型由 agent 自己决定） */
  models: AcpModelList | null
}

export interface AiSettings {
  activeConfigId?: string
  /** AI 执行终端命令的权限模式；在对话输入框处实时切换 */
  permissionMode: AiPermissionMode
  systemPrompt?: string
  /**
   * 确认模式下等待用户点「允许 / 拒绝」的最长毫秒数，`0` = 不限时。
   * 不设 = 用 @shared/ai-timeouts 的缺省值（当前也是不限时）；设置页可改。
   */
  confirmTimeoutMs?: number
  /**
   * 模型请求「首个内容块」的超时毫秒数，`0` = 不限时。
   * 不设 = 用 @shared/ai-timeouts 的缺省值（5 分钟）；设置页可改。
   */
  modelTimeoutMs?: number
  /**
   * Agent 单轮对话允许的最大工具调用步数（AI SDK `streamText`/`Agent.stream` 的
   * `maxSteps`）。不设 = 缺省 500；工作区 Agent 与终端 AI 助手共用此上限。
   */
  maxSteps?: number
  /**
   * 模型请求失败后的自动重试次数。`0` = **不重试**；缺省 = 2。
   * 生效值见 `@shared/ai-timeouts` 的 `resolveMaxRetries`，界面在「设置 → AI → 超时」。
   *
   * 由主进程**自己驱动**（不再走 mastra 的 `modelSettings.maxRetries`）：每次重试都会发一条
   * `retry` 事件，界面据此显示「第 N 次重试」。只对可重试的网络类错误生效；失败的那一次
   * 尝试若已经执行过工具就不再重试（避免重复副作用）。
   *
   * ⚠️ 与界面上的「断流了，重试」按钮无关：那是网络中断后**由用户**重发这一轮。
   */
  maxRetries?: number
  /**
   * 已登记的 ACP agent 配置 —— **在 AI Agent 侧边栏的「导入」弹窗里维护**（检测 / 手动添加），
   * 不再有独立的设置页。ACP 会话创建时绑定其中之一，之后不可切换。
   */
  acpAgents?: AcpAgentConfig[]
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

/** 单题答案：选中项的 label 列表。
 *  `other` = 用户选了「其他」并自行输入的内容（非是/否题才有；此时 `selected` 可能为空）。 */
export interface FollowupAnswerItem {
  id: string
  question: string
  selected: string[]
  /** 用户通过「其他」自由填写的内容 */
  other?: string
}

/**
 * 用户对整张表单的回答，作为工具结果回给模型。
 */
export interface AskFollowupAnswer {
  answers: FollowupAnswerItem[]
}

/** 一轮对话的用量与耗时统计（只有助手消息、且一轮跑完后才有） */
export interface TurnUsage {
  /** 输入（提示）tokens */
  inputTokens: number
  /** 输出（生成）tokens */
  outputTokens: number
  /** 总 tokens */
  totalTokens: number
  /** 其中「思考」tokens（不少模型把这部分算进 output 里） */
  reasoningTokens?: number
  /** 命中缓存的输入 tokens */
  cachedInputTokens?: number
  /** 整轮耗时（毫秒）：从发起到结束 */
  durationMs: number
  /** 输出速度（tokens/秒）：outputTokens ÷ 生成窗口（首字 → 结束） */
  tps: number
}

/**
 * 整个会话的累计用量（各轮 `TurnUsage` 的合计）。
 *
 * 与 `TurnUsage` 的差别：**没有耗时 / TPS** —— 那两个是单轮指标，跨轮累计没有意义
 * （总耗时 ≠ 各轮耗时之和，各轮之间还有排队 / 等审批的间隙）。
 * 这里只累计 token 数，供会话头部展示「这个会话一共烧了多少 token」。
 */
export interface ConversationUsage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  /** 其中「思考」tokens（不少模型把这部分算进 output 里） */
  reasoningTokens: number
  /** 命中缓存的输入 tokens */
  cachedInputTokens: number
}

/**
 * 一次上下文压缩的统计（用于在会话顶部提示「上下文已压缩」）。
 *
 * 只是**通知**，不进入消息历史：压缩改的是「这一次请求怎么带上下文」，
 * 屏幕上的历史始终是原文（可翻、可复制、可编辑重发）。
 */
export interface ContextCompression {
  /** 压缩前的估算 token 数 */
  beforeTokens: number
  /** 压缩后的估算 token 数 */
  afterTokens: number
  /** 被摘要掉的旧轮数 */
  summarizedTurns: number
  /** 保留原文的近期轮数 */
  keptTurns: number
  /** 摘要请求失败、已回退成截断（旧轮是直接丢掉的，不是摘要） */
  truncated: boolean
}

/** AI 聊天消息（简化版 UIMessage，主进程与渲染进程一致） */
export interface AiChatMessage {
  id: string
  role: 'user' | 'assistant'
  parts: AiMessagePart[]
  createdAt: number
  /** 这一轮的用量统计（仅助手消息、一轮跑完后才有） */
  usage?: TurnUsage
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
  | {
      type: 'text'
      text: string
      /**
       * 该段是一次流式失败落下的错误文案（`⚠️` 前缀）。
       *
       * 模型级重试**每次尝试失败都会发一个 error 事件**，追加会堆成一长串重复文案，
       * 所以靠这个标记让「后到的错误替换前一个」，且后续正文增量不再合并进这段文本
       * （否则重试成功后正文会被接在错误文案后面）。
       */
      error?: true
    }
  | { type: 'reasoning'; text: string }
  | {
      type: 'tool-call'
      toolCallId: string
      toolName: string
      input: unknown
      /** ACP 工具的人类可读描述（路径 / 命令等），只作「工具名后面的明细」展示，绝不进工具名 */
      title?: string
      /** ACP 协议的工具种类（read / edit / execute …）：拿不到 name 时靠它翻出中文工具名 */
      acpKind?: string
      /**
       * **入参还在流式生成**时攒下的半截 JSON 文本（见 `AiStreamEvent` 的 `tool-call-delta`）。
       *
       * 只喂渲染：卡片据此显示「正在生成…」并让内容一帧帧变长（写文件这类入参数 KB 起的调用
       * 才不至于一直只转圈）。完整 `tool-call` 到达（收口）时**必须丢掉它**（见
       * `stores/agent-helpers.ts` 的 appendAssistantPart），渲染随之回落到参数 / diff；
       * 它也**不落盘**（`persistConversation` 里再拦一道）。
       */
      inputText?: string
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
  /**
   * 工具**入参的流式增量**（Mastra 的 `tool-call-delta` / `argsTextDelta`）。
   *
   * 与 `tool-call` 的关系同 `text-delta` 之于 text part：增量只喂渲染（工具卡上能看到
   * 要写入的内容在长），收敛以完整 `tool-call` 为准。**不落盘、不进消息历史**。
   *
   * ⚠️ 不是所有上游都发：不发时行为与从前完全一致（只有一条完整 `tool-call`），
   * 渲染端不能假设「调工具必然先来一串 delta」。
   */
  | {
      type: 'tool-call-delta'
      toolCallId: string
      /** 增量帧可能不带工具名（有的上游只在完整 tool-call 里给）：给了就补上 */
      toolName?: string
      /**
       * 入参文本的增量（JSON 片段，按 toolCallId 依次拼接）。
       * **可以为空串**：上游「入参开始流式生成」那一帧只有 id + 工具名、还没有内容，
       * 用它先把卡片建出来（标题立刻是「写入文件」而不是「工具调用」）。
       */
      inputTextDelta: string
    }
  | { type: 'tool-call'; toolCallId: string; toolName: string; input: unknown; title?: string; acpKind?: string }
  | {
      type: 'tool-result'
      toolCallId: string
      toolName: string
      output: unknown
      isError?: boolean
    }
  /** 一轮结束时的用量统计（input/output/total tokens、tps、耗时等） */
  | { type: 'usage'; usage: TurnUsage }
  /** 本轮请求发出前触发了上下文压缩（只是通知，不进消息历史） */
  | { type: 'context-compressed'; info: ContextCompression }
  | { type: 'finish'; finishReason: string }
  | { type: 'error'; message: string; retryable?: boolean }
  /**
   * 模型请求因可重试的网络错误失败，正在重试（第 `attempt` 次）。
   *
   * 是「通知」不是内容增量：**不落盘**、也不代表本轮结束 —— 渲染端据此清掉这一次尝试
   * 已渲染的部分输出，并显示一条**自替换**的「第 N 次重试」提示（屏幕上只留最新一次）。
   * `maxRetries` = 生效的重试上限（设置里 `0` = 不重试，此时不会有这条事件）。
   */
  | { type: 'retry'; attempt: number; maxRetries: number }

// ---------- AI Agent（工作区编程/运维助手） ----------

/** Agent 工作区：绑定的本地目录，工具只能在工作区内读写与执行命令 */
export interface AgentWorkspace {
  id: string
  /** 展示名（默认取目录名，可改） */
  name: string
  /** 绝对路径 */
  path: string
  createdAt: number
  updatedAt: number
}

/** Agent 聊天消息（与 AiChatMessage 同构，part 形状一致） */
export interface AgentChatMessage {
  id: string
  role: 'user' | 'assistant'
  parts: AgentMessagePart[]
  createdAt: number
  /** 这一轮的用量统计（仅助手消息、一轮跑完后才有） */
  usage?: TurnUsage
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
 * Agent 会话：一个工作区下可以有多个独立会话，**每个会话固定一种形态**。
 *
 * - `kind: 'mastra'`：应用自带的 Mastra agent，`messages` 随会话落盘（能随时切回来接着聊）；
 * - `kind: 'acp'`：绑定的外部 ACP agent（`acpAgentId`）**不可切换**，
 *   `acpSessionId` 是 agent 侧的会话 id（导入时绑定 / 新建后回填）。
 *   **消息由 agent 自己管理** —— 本地不保存任何消息，打开会话时用 `session/load` 让 agent 回放。
 */
export interface AgentConversation {
  id: string
  /** 所属工作区 id */
  workspaceId: string
  /**
   * 会话形态：内置 Mastra agent 或某个固定的外部 ACP agent（**定下来之后不可互切**）。
   *
   * 缺省表示**还没定**：新建的会话先不指定形态，由**首条消息时选中的模型**决定
   * （选了 ACP agent 的模型 → `acp`，选了内置模型 → `mastra`），发消息那一刻落盘，
   * 见 AgentSlice.sendAgentMessage。侧边栏的类型标识在未定时不显示。
   */
  kind?: AgentBackend
  /** 标题（默认由首条用户消息截断生成，可重命名；导入的 ACP 会话取 agent 给的标题） */
  title: string
  /** 该会话的完整消息历史；**只有 `kind: 'mastra'` 才有内容**，ACP 会话恒为空数组 */
  messages: AgentChatMessage[]
  /** 仅 `kind: 'mastra'`：使用的模型配置 id（`AiModelConfig.id`）；缺省回退到设置里的默认模型 */
  configId?: string
  /**
   * 具体模型 id：
   * - `mastra` 下是配置里的模型 id（缺省用配置的默认模型）；
   * - `acp` 下是 agent 上报的模型 value（缺省用 agent 的当前模型）。
   * 两种形态都**可以切换**（ACP 走 `session/set_config_option`）。
   */
  modelId?: string
  /** 仅 `kind: 'acp'`：绑定的 ACP agent 配置 id（`AcpAgentConfig.id`），**不可切换** */
  acpAgentId?: string
  /** 仅 `kind: 'acp'`：agent 侧的会话 id（`session/new` 或导入时绑定），**不可切换** */
  acpSessionId?: string
  createdAt: number
  updatedAt: number
}

export type AgentMessagePart =
  | {
      type: 'text'
      text: string
      /** 该段是一次流式失败落下的错误文案（`⚠️` 前缀），语义见 `AiMessagePart` 的同名字段 */
      error?: true
    }
  | { type: 'reasoning'; text: string }
  | {
      type: 'tool-call'
      toolCallId: string
      toolName: string
      input: unknown
      /** ACP 工具的人类可读描述（路径 / 命令等），只作「工具名后面的明细」展示，绝不进工具名 */
      title?: string
      /** ACP 协议的工具种类（read / edit / execute …）：拿不到 name 时靠它翻出中文工具名 */
      acpKind?: string
      /**
       * **入参还在流式生成**时攒下的半截 JSON 文本（见 `AgentStreamEvent` 的 `tool-call-delta`）。
       *
       * 只喂渲染：卡片据此显示「正在生成…」并让内容一帧帧变长（写文件这类入参数 KB 起的调用
       * 才不至于一直只转圈）。完整 `tool-call` 到达（收口）时**必须丢掉它**（见
       * `stores/agent-helpers.ts` 的 appendAgentPart），渲染随之回落到参数 / diff；
       * 它也**不落盘**（`persistConversation` 里再拦一道）。
       */
      inputText?: string
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
  /** 会话 id：ACP 后端据此定位 / 新建独立的 agent session（不同会话不共享上下文） */
  conversationId: string
  /** 会话形态；缺省回退到会话记录（缺记录时按 mastra） */
  kind?: AgentBackend
  /** 本轮要发给模型的历史。**mastra 用**；ACP 只取最后一条用户文本，其余由 agent 自己维护 */
  history: AgentChatMessage[]
  /** 仅 `mastra`：模型配置 id；缺省回退到设置里的默认模型 */
  configId?: string
  /** 具体模型 id：`mastra` 是配置里的模型；`acp` 是 agent 上报的模型 value */
  modelId?: string
  /** 仅 `acp`：绑定的 ACP agent 配置 id */
  acpAgentId?: string
  /** 仅 `acp`：agent 侧的会话 id；为空表示「这个会话还没在 agent 侧建过」，由主进程 session/new 补上 */
  acpSessionId?: string
}

/** Agent 流事件（形状与 AiStreamEvent 一致；reasoning-delta 为思考内容增量） */
export type AgentStreamEvent =
  /**
   * ACP 会话的历史回放：打开一个导入的 ACP 会话时，`session/load` 让 agent 把整段历史
   * 回放给客户端，主进程把它拼成消息列表**整段下发**（本地不落盘）。
   * `mastra` 路径不会发这个事件。
   */
  | { type: 'history'; messages: AgentChatMessage[] }
  | { type: 'text-delta'; delta: string }
  | { type: 'reasoning-delta'; delta: string }
  /**
   * 工具**入参的流式增量**（Mastra 的 `tool-call-delta` / `argsTextDelta`）。
   *
   * 与 `tool-call` 的关系同 `text-delta` 之于 text part：增量只喂渲染（工具卡上能看到
   * 要写入的内容在长），收敛以完整 `tool-call` 为准。**不落盘、不进消息历史**。
   *
   * ⚠️ 不是所有上游都发：不发时行为与从前完全一致（只有一条完整 `tool-call`），
   * 渲染端不能假设「调工具必然先来一串 delta」。
   */
  | {
      type: 'tool-call-delta'
      toolCallId: string
      /** 增量帧可能不带工具名（有的上游只在完整 tool-call 里给）：给了就补上 */
      toolName?: string
      /**
       * 入参文本的增量（JSON 片段，按 toolCallId 依次拼接）。
       * **可以为空串**：上游「入参开始流式生成」那一帧只有 id + 工具名、还没有内容，
       * 用它先把卡片建出来（标题立刻是「写入文件」而不是「工具调用」）。
       */
      inputTextDelta: string
    }
  | { type: 'tool-call'; toolCallId: string; toolName: string; input: unknown; title?: string; acpKind?: string }
  | {
      type: 'tool-result'
      toolCallId: string
      toolName: string
      output: unknown
      isError?: boolean
    }
  /** 一轮结束时的用量统计（input/output/total tokens、tps、耗时等） */
  | { type: 'usage'; usage: TurnUsage }
  /** 本轮请求发出前触发了上下文压缩（只是通知，不进消息历史） */
  | { type: 'context-compressed'; info: ContextCompression }
  | { type: 'finish'; finishReason: string }
  | { type: 'error'; message: string; retryable?: boolean }
  /**
   * 模型请求因可重试的网络错误失败，正在重试（第 `attempt` 次）。
   *
   * 是「通知」不是内容增量：**不落盘**、也不代表本轮结束 —— 渲染端据此清掉这一次尝试
   * 已渲染的部分输出，并显示一条**自替换**的「第 N 次重试」提示（屏幕上只留最新一次）。
   * `maxRetries` = 生效的重试上限（设置里 `0` = 不重试，此时不会有这条事件）。
   */
  | { type: 'retry'; attempt: number; maxRetries: number }

/** Agent 确认模式下**改动类工具**（执行命令 / 写入 / 编辑 / 删除）执行前的主进程请示 */
export interface AgentConfirmRequest {
  /** 确认请求 id，回复时原样带回 */
  id: string
  /** 所属 Agent 对话请求 id */
  requestId: string
  toolCallId: string
  toolName: string
  /** 待执行的动作：命令原文，或「写入文件 xxx（n 字符）」这类说明 */
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

// ===== Git（源代码管理）=====
/** 单个文件的两列状态码（X = 暂存区，Y = 工作区） */
export interface GitChange {
  /** 暂存区状态（porcelain 的 X 列） */
  index: string
  /** 工作区状态（porcelain 的 Y 列） */
  worktree: string
  /** 当前路径 */
  path: string
  /** 重命名 / 复制时的原始路径 */
  origPath?: string
}

export interface GitRemote {
  name: string
  url: string
}

export interface GitStatusResult {
  /** 是否 git 仓库（false 时其余字段除 root 外无意义） */
  isRepo: boolean
  /** 仓库根目录（非仓库时为空串） */
  root: string
  /** 当前分支名；分离头指针时为 null */
  branch: string | null
  /** 是否处于分离头指针（detached HEAD） */
  detached: boolean
  /** 跟踪的上游分支（如 origin/main），无则 null */
  upstream: string | null
  /** 领先上游的提交数 */
  ahead: number
  /** 落后上游的提交数 */
  behind: number
  /** 已配置的远端列表 */
  remotes: GitRemote[]
  /** 变更列表（git status --porcelain=v1） */
  changes: GitChange[]
  /** 改动过多被截断（列表已上限收敛）；为 true 时禁用批量操作 */
  truncated: boolean
}

export interface GitBranchesResult {
  /** 本地分支名 */
  branches: string[]
  /** 远端分支（带 origin/ 前缀，如 origin/main） */
  remotes: string[]
}

export interface GitCommit {
  /** 完整 hash */
  hash: string
  /** 短 hash */
  short: string
  /** 提交标题 */
  subject: string
  /** 作者 */
  author: string
  /** 日期（--date=short，YYYY-MM-DD） */
  date: string
}

/** git 写操作：按 action 选择字段 */
export type GitAction =
  | { action: 'stage'; paths: string[] }
  | { action: 'unstage'; paths: string[] }
  | { action: 'rollback'; path: string; mode: 'worktree' | 'all' }
  | { action: 'rollback-all'; paths: string[] }
  | { action: 'commit'; message: string }
  | { action: 'checkout'; ref: string }
  | { action: 'create-branch'; name: string; from?: string }
  | { action: 'set-remote'; name: string; url: string }
  | { action: 'push' }
  | { action: 'pull' }
  | { action: 'init' }

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

/**
 * 主机不支持监控的原因：
 * - windows / other：会话探测到的非 Linux 平台（采集命令依赖 Linux 的 /proc 与 df）
 * - unavailable：命令执行成功但连续多轮解析不出有效数据（权限受限 / 未知系统等）
 */
export type MonitorUnsupportedReason = 'windows' | 'other' | 'unavailable'

/** 「主机不支持监控」通知载荷（渲染端据此在状态栏显示明确的不支持状态） */
export interface MonitorUnsupportedPayload {
  sessionId: string
  reason: MonitorUnsupportedReason
}

// ---------- 远程桌面（RDP） ----------

/** RDP 本地桥信息（主进程 rdp:open 返回）：渲染端 WASM 客户端经它连真实 RDP 服务器 */
export interface RdpBridgeInfo {
  connId: string
  wsUrl: string
}

/**
 * RDP 连接凭据（主进程 rdp:credentials 返回）：从主机配置解密后交给渲染端。
 * WASM 客户端（NLA / CredSSP）必须在渲染进程完成票据计算，只能这样流转；
 * 只在发起连接时读取，不随主机列表下发（列表里只有 hasPassword 标记）。
 */
export interface RdpCredentials {
  username: string
  password: string
  domain: string
  /** 规范化后的 RDP 端口（与桥固定的目标端口一致） */
  port: number
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
