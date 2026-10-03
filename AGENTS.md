# Dogi — 项目说明与开发约束

面向 AI 编码助手与后来者的工作手册。**先读第一节（项目概览）与第二节（开发命令）；
动手改某个模块前，读第四节的对应机制与第五节对应条目。**

第六节是本项目的踩坑库，每条都按「触发信号 → 根因/约束 → 正确做法 → 验证方式」组织，
全部是实测结论（不是推测、不是网上抄的通用建议）。**条目里写着「别改成 X」的地方，
都是有具体事故背景的，改之前先想清楚为什么。**

---

## 一、项目概览

### 1.1 定位

**Dogi** 是一个 AI 驱动的桌面运维工作台：把「连机器 → 干活 → 记下来 → 调接口 → 让 AI 代办」
收在一个 Electron 应用里。左侧是活动栏功能区，右侧是 VS Code 式的分屏标签组，
内置终端 / SSH / 远程桌面（RDP）/ SFTP / 服务器监控 / 接口调试 / 笔记 / 脚本 / 插件宿主，
以及一个能读写文件、执行命令、调用技能的 AI Agent。

### 1.2 技术栈

| 层 | 选型 |
| --- | --- |
| 桌面容器 | Electron 44（`contextIsolation` + preload 白名单 IPC，无 nodeIntegration） |
| 渲染端 | React 19 + TypeScript 7 + Tailwind v4 + **antd 6**（唯一 UI 库） |
| 状态 | zustand（单一 store：`src/renderer/src/stores/app-store.ts`） |
| 终端 | `@xterm/xterm` v6（DOM 渲染）+ `node-pty`（本地）/ `ssh2`（远程）+ `zmodem.js`（rz/sz 传文件） |
| 远程桌面 | `ironrdp-wasm`（IronRDP 编译的 WASM 客户端，画到 canvas）+ 主进程本地桥（WebSocket ↔ TCP/TLS，RDCleanPath 协议） |
| 编辑器 | Monaco（本地资源，`scripts/copy-monaco.cjs` 拷贝到 `public/`） |
| AI | Vercel AI SDK v7（openai / anthropic / deepseek / google / openai 兼容）+ `@modelcontextprotocol/sdk`（MCP）+ `@agentclientprotocol/sdk`（外部 ACP agent） |
| 持久化 | `electron-store` + `safeStorage`（凭据加密，Windows 走 DPAPI） |
| 构建 | 自建三配置 Vite（见 3.1），无 electron-vite |
| 打包 | electron-builder（NSIS / dmg / AppImage+deb） |

### 1.3 当前功能

**活动栏功能区**（`src/renderer/src/app/activities.tsx`，顺序可拖拽、可隐藏）

| 功能区 | 侧边栏 | 主区域 |
| --- | --- | --- |
| **主机** | 主机列表（分组 / 拖拽 / 颜色）+ 下半区「脚本」分区（可折叠、可拖高） | 终端标签、SFTP 文件管理标签、远程桌面标签 |
| **AI Agent** | 工作区 → 会话两层树，会话行带状态图标（等回答 / 运行中 / 静止） | Agent 会话页（对话流 + 内嵌终端 + 工作区文件树/预览 + 快捷功能） |
| **笔记** | 笔记列表（分组 / 拖拽 / 搜索） | Monaco 编辑器标签，语言可选 |
| **接口请求** | 保存的请求列表（分组 / 拖拽 / 历史） | HTTP 调试页 / WebSocket 调试页 |
| **插件管理** | 已安装插件列表 | 插件视图（以标签页打开）；内置：Redis 客户端（🔴）、端口占用（🔌） |

**终端**

- 本地终端：`node-pty`，shell 由 `services/terminal/shells.ts` 探测（PowerShell / pwsh / CMD / Git Bash / WSL / bash / zsh / fish…），偏好里可指定默认 shell。
- SSH：`ssh2`，密码或私钥认证，握手阶段进度推送（`resolving → handshake → authenticating → opening-shell → retrying → ready`），失败自动重连。
- Mosh：主机可单独开启（新建 / 编辑主机表单的「使用 Mosh」开关，`SshProfile.useMosh`）—— SSH 只做引导，终端数据走本地 mosh-client 的 UDP；机制与前置条件见 4.12。
- 会话输出环形缓冲 **256KB/会话**（`MAX_OUTPUT_BUFFER`），供 AI 工具按偏移增量读取。
- `TERM=xterm-256color` 硬编码 —— 否则远端 ncurses 程序（htop / btop / lazygit）按 8 色渲染成黑白。
- 每会话独立的 AI 助手（内嵌在终端页底部，可折叠）。
- zmodem：`sz`/`rz` 走系统对话框选文件 / 存文件（`zmodem:*` 三个通道）。
- 拖拽上传（仅 SSH 会话）：把本地**文件 / 文件夹**拖到终端即经 SFTP 送到远端（`sftp:uploadPaths`，
  目录递归上传为同名子目录）。目标目录每次拖入弹确认条（默认远端家目录，会话内记住上次的选择）——
  终端当前工作目录拿不到（Shell 默认不发 OSC 7、解析提示符不可靠），所以不猜。rz/sz 传输中不接管。
- 终端配色方案、字号缩放、选中即复制、右键粘贴、命令预测（历史补全）等偏好。
- **命令历史**：预测用的历史是全局的 —— 用户按回车执行的命令（本地 / SSH 都算）经 `history:add`
  记进主进程 `userData/command-history.json`（去重置顶、上限 1000、跨会话共享、跨重启保留），
  渲染端在 store 里持有镜像（bootstrap 灌入，管理界面与预测共用）。记录开关是偏好 `commandHistory`
  （默认开；关闭只停记录，已有历史照常可用）；管理与清空入口在 设置 → 终端 的「命令历史」卡片。
  AI / 脚本写入的命令**不进**这里（那是主机日志 `terminal` 作用域的事，见 4.13）。
  服务层在 `services/terminal/history.ts`（落盘路径由 init 注入，不 import electron，探针可纯 Node 直跑）。
- 执行的命令与输出自动记进主机日志（`terminal` 作用域，来源带 [AI] / [脚本] 标记），每会话另有逐字节原始输出文件（见 4.13）。

**主机与运维**

- 主机分组 / 强调色 / 拖拽排序；**三类主机** `kind: 'ssh' | 'rdp' | 'local'` 统一建模 —— 新建 / 编辑主机对话框三分段选择，已建的也能改类型。
- **远程桌面（RDP）**：rdp 主机走普通「连接」动作开远程桌面标签（**不是**菜单直达 —— 旧「远程桌面 (RDP)」右键入口已移除，别恢复）；WASM 客户端 + 主进程本地桥，读主机配置自动连接 / 弹凭据对话框，机制见 4.17。
- **SFTP**：浏览、上传文件 / **上传文件夹（递归，目录内每个文件一笔独立传输）**、下载（含目录递归）、远端复制 / 移动、删除 / 新建目录、重命名；进度经 `sftp:progress` 广播到状态栏的传输托盘；用户取消不算错误（`TransferCancelledError`）。
- **传输托盘**（状态栏右下）：结束的任务**不自动移除**（用户要求：完成后留在面板里，由用户逐条 × 或「清除已完成」清理）；已完成的上传 / 下载条目带**「打开文件位置」图标**（`shell:revealPath`：目录直接打开，文件在所在目录中选中；复制 / 移动没有本地侧、已取消 / 失败不给图标）。
- **服务器监控**：经 SSH `exec` 周期采集 `/proc` + `df`（CPU / 内存 / 负载 / 网速 / 磁盘 / uptime），间隔可配（`monitorInterval`）。
- **脚本**：侧边栏分区管理，命令面板可「运行脚本」（有终端直接写入执行，无终端则弹框选主机连上去跑）。
- **主机日志**：SSH 连接（按来源标签分终端会话 / Mosh 引导 / SFTP / SSH 隧道 / 连接测试）、会话就绪 / 关闭 / 断线重试、隧道启停与转发失败、SFTP 连接、主机指纹记录与重置统一记成结构化条目；终端里执行的命令与输出也在内（`terminal` 作用域，机制见 4.13）。

**AI 两条产品线**（**同一台引擎**，由请求里的 `scope` 分派，见 4.22；流式事件与渲染组件也只写一份）

1. **终端 AI 助手**（`AiPanel`）：挂在终端页面，工具作用于**发起消息的那个**终端会话 ——
   `run_in_terminal` / `send_keys` / `read_terminal_output` / `list_terminal_sessions` / `read_tool_output`。
   超长输出落**产物文件**、给模型 id 让它续读（见 4.24）。
   **历史落盘**（独立目录，跨重启保留）、左侧可展开**会话列表**、**新开会话**（开草稿，首条消息才转正）、
   **逐条删除**（旧的「清空历史」已移除）。这些会话**不进 AI Agent 侧边栏**（靠存储边界保证，见 4.22）。
2. **工作区 Agent**（`AgentPage` / `AgentConversationView`）：绑定本地目录，工具为 `list_files` / `find_files` / `search_files` / `read_file` / `write_file` / `edit_file` / `delete_file` / `execute_command` / `read_skill` / `browser_*`（见下），另有工作区文件树与图片 / 视频 / SVG 预览，以及可折叠的**内嵌浏览器面板**（看 Agent 正在操作哪个页面）。

**客户端工具**（渲染进程执行的能力，见 4.23）：页面用 `registerClientTool` 注册，定义随下一次请求上报，
主进程把调用广播回渲染端执行，权限与确认按客户端的权限设置在**渲染端**判定。

**Agent 只有两种形态，一个会话固定是其中一种、创建后不可互切**（见 4.3 / 4.18）：

- **内置 Mastra agent**（`kind: 'mastra'`）：工具由应用提供，**消息随会话落盘**；
- **外部 ACP agent**（`kind: 'acp'`）：本机某个 ACP CLI（codex-acp / gemini / opencode…），
  **消息与会话都由它自己管理，本应用只存绑定关系**（`acpAgentId` + `acpSessionId`），
  打开会话时用 `session/load` 让 agent 回放历史。
- 原生 `ai-sdk` 后端（`ai` 包的 `streamText` 直连）**已整体移除**，旧会话读取时按 mastra 迁移。

两者共同支持：

- **模型按会话独立、可切换**（mastra 换模型配置 / ACP 走 `set_config_option`）；**ACP 绑定不可换**。
- 权限模式 `full` / `confirm`（确认模式下执行命令前弹确认卡）。
- `ask_followup_question`：AI 在回合中途向用户发**结构化选择题**，答完同一回合继续（见 4.5）。
- **MCP**：任意 stdio MCP server，工具自动合并给 AI。
- **技能（Skills）**：发现 `SKILL.md` 目录，渐进式披露 + `read_skill` 工具按需读（见 4.7）。
- 思考内容（reasoning）与工具调用渲染成**可折叠横条**，不是卡片（见 6.5 第 18 条）。
- 一轮结束且应用不在前台时发系统通知。

**浏览器（Playwright，机制见 4.11）**

> 旧的「自动化」功能区（脚本管理 / 录制 / 脚本运行）**已整体移除，别恢复**；
> Playwright 基础设施现在只服务 Agent 的浏览器能力。

- **内嵌浏览器**：浏览器**无窗口**跑（headless），画面走 CDP screencast 镜像进 Agent 会话页的
  内嵌面板；面板里的鼠标 / 键盘 / 滚轮再转发回页面。
- **浏览器来源**：偏好 `browserChannel`（`auto` / `bundled` / `msedge` / `chrome`），auto 按「自带 → Edge → Chrome」逐个尝试启动。
- **Agent 浏览器工具**：`browser_navigate` / `browser_snapshot` / `browser_click` / `browser_type` / `browser_press` / `browser_wait_for` / `browser_evaluate` / `browser_screenshot` / `browser_close`；定位用可访问性快照里的 `[ref=eN]`（`aria-ref` 选择器引擎），页面一变 ref 失效需重新快照。

**接口调试**

- HTTP：方法 / 头（键值对数组，保留空行）/ **请求体四种形态**（`none` / `raw` / `x-www-form-urlencoded` / `form-data`，见 4.19）、超时、代理、跳过 TLS 校验、手动取消、cURL 导入、请求历史、响应耗时与体积。
- WebSocket：长连接、附加握手头、子协议、`wss` 自签证书、文本 / 二进制帧（base64）、按 `connId` 隔离多标签。
- 与终端同款的多标签 / 分屏；一个请求 = 一个标签（新建即落盘）。

**应用外壳**

- VS Code 式**面板树分屏**（`app/layout/pane-layout.ts`）：向上下左右拆分、拖拽调比例、标签跨组移动、标签条溢出时激活标签自动滚入可视区。
- **命令面板**（`Ctrl+Shift+P`）：命令 / 脚本 / 主机 / 插件的统一入口；插件可注册命令。
- **应用内快捷键**可改（偏好 → 快捷键），带冲突检测。
- 自定义标题栏、状态栏（保存状态 / 监控条 / AI 开关 / 传输托盘 / 左下角全局菜单）、标签关闭确认
  （确认框画在标签面板内部、页面确认后 emit 关闭，机制见 6.5 第 32 条）。
- 主题：明暗 + 强调色方案 + 终端独立配色；**首帧不闪**（见 4.6）。
- 文件视图（Agent 工作区）：左侧文件树 + 右侧多标签编辑区，树上**右键 / 触屏长按**菜单支持
  打开 / 重命名 / 复制 / 剪切 / 粘贴 / 删除 / 新建文件与文件夹（见 4.21）。
- 托盘常驻、单实例锁、最小化到托盘。
- **数据导入 / 导出**：主机 / 笔记 / 接口请求打包成 zip（自实现，见 6.7）。

### Agent 工作区文件视图

- 左侧文件树（懒加载，忽略规则与 Agent 工具一致）+ 右侧多标签编辑区，Monaco 编辑、Ctrl+S 保存
- **右键 / 触屏长按**文件或目录：打开、重命名、复制、剪切、粘贴到此处、删除、新建文件 / 文件夹。
  复制撞名自动加「副本」后缀，移动撞名直接报错；删 / 移 / 重命名已打开的文件会先关掉它的标签（见 4.21）

### 1.4 目录地图

```
src/
  shared/                  # 三端共享的纯类型 / 纯逻辑（不得引 electron、不得引 DOM）
    types.ts               # 全部跨端类型（Preferences / SshProfile / AgentConversation / …）
    shortcuts.ts theme.ts workspace-config.ts workspace-media.ts sftp-path.ts plugin.ts ask-followup.ts
    browser.ts             # 浏览器会话 id 推导（主进程与渲染端必须算出同一个 id）
  main/
    index.ts               # 窗口 / 托盘 / 菜单 / 单实例锁 / 生命周期
    ipc/                   # 一个通道前缀一个文件（见 3.2），index.ts 统一注册
    services/
      storage.ts           # electron-store 持久化 + safeStorage 加解密（跨域，留在 services 根）
      terminal/            # sessions.ts（node-pty + ssh2 统一抽象）shells.ts monitor.ts
                           # recording.ts（终端命令 + 输出 → 主机日志，见 4.13）
      ai/                  # agent.ts（**两条线共用的引擎**，按 scope 分派）acp-agent.ts acp-detect.ts
                           # tool-registry.ts（工具注册表）builtin-tools.ts（启动时登记内置工具）
                           # terminal-tools.ts（终端组工具 + 提示词）client-tools.ts（客户端工具 broker）
                           # mcp.ts skills.ts resolve-model.ts ask-followup.ts context.ts
                           # workspace-config.ts workspace-fs.ts workspace-media.ts
                           # agent-core/（工作区工具 / 系统提示词 / 事件适配 / 路径与忽略规则）
      api/                 # http.ts ws.ts
      browser/             # session.ts（Playwright 会话 + screencast）resolver.ts input.ts
                           # handlers.ts（事件出口）agent.ts（Agent 工具集）
      sftp/ transfer/      # sftp.ts；transfer/（zip.ts + 导入导出编排）
      rdp/                 # bridge.ts（RDP 本地桥：WebSocket ↔ TCP/TLS，RDCleanPath，见 4.17）
      log/                 # logger.ts（主机日志：环形缓冲 + JSONL 落盘，见 4.13）
      plugins/host.ts      # 插件宿主（主进程侧）
      system/              # icon.ts notify.ts opener.ts
  preload/index.ts         # contextBridge 白名单（按命名空间分组）+ 首帧主题
  renderer/
    index.html             # CSP 在这里（见 4.6 / 4.9）
    src/
      app/                 # 应用装配：App.tsx、activities.tsx（功能区注册表）、layout/（外壳）
      features/<功能>/      # 每个功能区的 UI 与它专属的纯函数
      shared/              # components/（复用组件）+ lib/（复用纯函数）
      stores/              # 全局 zustand store（跨切面），实现体拆成几份：
                           # app-store.ts（create() 实现体 + IPC 事件监听 + re-export）
                           # types.ts（全部类型 / 常量 / slice 接口）、pane-helpers.ts、
                           # agent-helpers.ts（Agent/AI 会话的纯函数）、
                           # client-tools.ts（客户端工具注册表 + 权限门，**不在 store 里**）
scripts/                   # 探针 / 验证脚本（见 5.2），不参与构建，也不在 tsconfig 的 include 里
```

---

## 二、开发命令

```bash
npm install                # 依赖（见 6.1 第 2 条：npm 12 会静默跳过安装脚本）
npm run dev                # Vite dev server(5174) + main/preload watch + Electron 自动重启
npm run typecheck          # tsc：node 侧 + web 侧，两个都要过
npm run build              # typecheck + main + preload + renderer 全量构建到 out/
npm run start              # 运行已构建产物（electron .）
npm run pack / dist / dist:win / dist:mac / dist:linux
```

- **构建三配置**（3.1）：`vite.main.mts`（ESM → `out/main/index.js`）、
  `vite.preload.mts`（**CJS** → `out/preload/index.cjs`）、`vite.config.ts`（renderer → `out/renderer/`）。
- 渲染端单独重建：`npx vite build --outDir <临时目录>` 再 `cp -rf` 拷回 `out/renderer`
  （**不要**直接 `npx vite build`：`emptyOutDir` 会先删掉产物，见 6.2 第 8 条）。
- 类型检查是最快的回归门：改完任何一端先跑 `npm run typecheck`。

---

## 三、架构约定（代码放哪、怎么接）

### 3.1 构建编排是自建的，不要引入 electron-vite

- **约束**：用户明确不信任 electron-vite。三个 Vite 配置各自独立，dev 编排在 `scripts/dev.mjs`
  （起 dev server + 首构 main/preload + `--watch` 增量 + 重建后重启 Electron）。
- **为什么 preload 必须是 `.cjs`**：沙箱 preload 只支持 CJS，而 `package.json` 是 `type: module`，
  输出 `.js` 会被当成 ESM 直接加载失败。main 用 ESM（Electron 28+ 原生支持）。
- **external 判定**：本地模块（`.`/`/` 开头、`@shared`、**盘符绝对路径**）参与打包，其余 bare import 全 external。
  ⚠️ 盘符那条不能省 —— 相对导入被解析成 `D:/...` 后不以 `.`/`/` 开头（见 6.2 第 7 条）。
- alias 只有两个：`@shared/*` → `src/shared/*`（三端）、`@/*` → `src/renderer/src/*`（渲染端）。

### 3.2 主进程：ipc 按通道前缀拆，services 按功能域分目录

- `src/main/ipc/` 一个模块一个文件，**通道前缀 ≈ 文件名**：`terminal:*`、`ssh:*`（→hosts.ts）、
  `sftp:*`、`scripts:*`、`notes:*`、`api:*`/`ws:*`、`ai:*`、`agent:*`、`clientTools:*`、`followup:*`、`mcp:*`、
  `skills:*`、`plugins:*`/`plugin:*`、`shell:*`、`zmonitor`… `shared.ts` 放 `IpcContext` 与公共工具。
- 新增通道 → 在对应前缀的模块里 `ipcMain.handle`；**只有新增模块**才需要在 `ipc/index.ts` 加一行 `registerXxxIpc`。
- 需要广播或读窗口的模块接 `ctx: IpcContext`（`ctx.broadcast` / `ctx.win()`）；纯请求-响应型模块不接收参数。
  `registerAiIpc()` 现在**不接 ctx**（只剩模型配置与设置的 CRUD，见 4.22）；`registerClientToolsIpc(ctx)`
  只做两件事：把 broadcaster 装进 broker、接 `clientTools:result` 回填。
- `ipc/index.ts` 里 `registerFollowupIpc` **必须排在 `registerAgentIpc` 之后**（共用一个 broker 的收尾纪律在 agent 侧）。
- 会话事件的副作用归各自域：数据转发在 terminal.ts、采集生命周期在 monitor.ts、AI 请求的生命周期在 agent.ts
  （含 `sessionManager.on('closed')` → `disposeTerminalSession`）。同一个 `sessionManager` 事件被多方订阅是
  **刻意的**（EventEmitter 多监听器），别为「集中」合回一个文件。
- 新增服务 → 按功能域放进 `services/<域>/`；被所有域引用的持久化层留在 `services/storage.ts`。

### 3.3 渲染端三层：features / app / shared

| 目录 | 收录什么 | 判定标准 |
| --- | --- | --- |
| `features/<功能>/` | 业务 UI **与**它专属的纯函数 / 类型 | 只服务一个功能区，删掉这个功能就没人用 |
| `app/` | 应用装配与外壳：入口、功能区注册表、外层布局、主区域容器 | 不属于任何单一业务功能 |
| `shared/` | `components/`（复用 UI）+ `lib/`（复用纯函数） | 被 **≥2 个**功能区引用 |

- 捷径：这个模块能不能只用一个功能名回答「它是干什么的」？能 → `features/<名>/`；
  只能答「整个应用」→ `app/`；要列举两个以上功能 → `shared/`。
- `stores/app-store.ts`、`main.tsx`、`index.css`、`assets/` 留在 `src/renderer/src/` 根。
- 旧的 `components/`、`lib/`、`plugins/` 三个平铺目录**已不存在**，有残留说明又按旧习惯放了文件。

### 3.4 UI 一律 antd 6，不要再引入 shadcn / 自绘

- shadcn/ui 及其依赖（`@radix-ui/*`、`vaul`、`sonner`、`class-variance-authority`、`clsx`、`tailwind-merge` 等）已全部移除。
- `Select` 用 `options` + `onChange`（不是 `onValueChange`）；`Switch` 用 `onChange`（不是 `onCheckedChange`）；
  多行输入用 `Input.TextArea`；右键菜单用 `<Dropdown trigger={['contextMenu']}>`。
- **弹窗 / 确认一律用 antd**（`Modal` / `Modal.confirm` / `Popconfirm` / `Dropdown` / `message` / `notification`）：
  行内小确认用 Popconfirm，居中 / 危险操作用 Modal.confirm。**禁止原生 `window.confirm` / `alert`**（不跟随主题且阻塞渲染进程）。
- 保留 `index.css` 里的 shadcn 语义变量（`--background` / `--primary` / `--muted` / `--border` / `--sidebar*`…）：
  它们既被全项目的 Tailwind 类名使用，也是 `AntdProvider` 映射 antd token 的来源。
- 插件侧：宿主通过 `activate(api)` 注入 `api.antd` / `api.cn` / `api.icons` / `api.MonacoEditor` / `api.react`，
  **插件不得自行 import 依赖**。

### 3.5 状态真源只有一份

- 会话消息只存在 `agentConversations`（含 messages）；`agentRuns: Record<conversationId, AgentRunState>`
  只放 streaming / requestId / error。**别再往 agentRuns 里塞 messages。**
  ⚠️ 唯一例外是 **ACP 会话的本地镜像** `agentAcpMessages`（不落盘、归 agent 管，见 4.18）——
  它按 `kind` 区分，不是「第二份真源」。
- store 已拆成四份（`app-store.ts` / `types.ts` / `pane-helpers.ts` / `agent-helpers.ts`）：
  **消费方仍然只 import `@/stores/app-store`**（那里 re-export 全部公开符号）。
  ⚠️ `export { X } from './types'` **不会**把 X 带进本地作用域 —— 实现体里用到的值必须
  再从 `./types` 真正 import 一次（踩过：拆分时只留 re-export，一片 `Cannot find name`）。
- 标签 id 由身份推导（`terminal-<sessionId>` / `script-<id>` / `note-<id>` / `api-<id>` /
  `plugin-<viewId>` / agent 会话 / `logs`（全局单例）），「是否已打开」只比 id，不遍历业务字段。
- 面板组的树（`pane-layout.ts`）是纯函数模型，布局变更一律走它导出的纯函数，别在组件里手改树。

---

## 四、关键机制（改之前先懂）

### 4.1 终端数据链：缺一环就黑屏

```
Session.onData → sessionManager.emit('data') → ipc/terminal.ts broadcast → preload 订阅 → xterm.write
```

- 新增会话类型（telnet / 串口 / …）时复制 `SshSession` 的 handlers 模式 —— 它的构造函数**强制**传 handlers，
  所以不会漏；`LocalSession` 当初就是漏了转发导致终端黑屏。
- **重挂载要回放，PTY 不会自己重来**：`TerminalView` 持有 xterm 实例（挂载时 `new Terminal()`、卸载时
  `dispose()`），而渲染端只收**增量**流（`terminal:onData`）。标签一旦**换父节点**就重挂载、新实例缓冲为空 ——
  用户能碰到的入口是「把终端标签拖到分屏」（`splitTabToGroup`）或「拖到另一组」（`moveTabToGroup`）：
  `PaneView` 的 `PaneTree` 只保证 leaf↔split 切换时组子树不卸载，**跨组移动仍然换父节点**。
  修法是挂载时回放主进程环形缓冲（`terminal:recentOutput`，与 `MAX_OUTPUT_BUFFER` 同为 256KB）：
  **先订阅、再取缓冲**（取缓冲这段时间到达的输出先缓存、回放写完再冲出去；反过来接缝处会重复），
  回放走 `term.write` **绕过 zmodem**（传输会话不可能跨重挂载存活，把旧 ZMODEM 帧再喂给 Sentry
  只会伪造出一场传输）。取失败 / 会话已结束（返回 null）不是致命错误，直接进实时模式。
  代价（明确取舍）：重建的屏幕按新列宽重新折行，滚动位置与选区仍不保留。
  ⚠️ 别改成「把 xterm 实例提到跨组复用的缓存」——看着更彻底，但要把实例所有权从组件里挪出去，
  而 `dispose()` 现在有五六个入口（切标签 / 删会话 / 关组 / 卸载 / 组件重挂），漏一个就是泄漏；
  回放方案对**任何**未来新增的重挂载原因都生效，还顺带把「组件卸载期间主进程仍在产出」的输出找回来。
  验证：`scripts/verify-terminal-replay.mjs`。
- 验证：创建会话后调 `window.api.terminal.recentOutput(sessionId)` 应能看到 shell 提示符。

### 4.2 流式事件必须**自带归属**

- 主进程任何「立即产生事件的路径」都要延迟到 invoke 返回之后（`setTimeout(…, 0)`）。
- ⚠️ 但**光靠 setTimeout 不够**：定时器是宏任务，可渲染端「拿到 invoke 回包 → 建 requestId→会话 映射」
  之间还隔着微任务 + IPC 往返，谁先到不确定。Agent 侧实测事件整条被丢，表现为「转圈永不结束 + 报错不显示 + 通知不弹」。
- 根治：**让事件自带归属** —— `ipc/agent.ts` 在 handler 里登记 `requestId → conversationId`（一定早于定时器），
  广播 `{ requestId, conversationId, event }`，渲染端优先用主进程给的 conversationId 补登记。
  新增任何「按 requestId 路由」的流式功能都照这个来。

### 4.3 会话形态：**首条消息定型**，之后固定；模型按会话独立

- `AgentConversation` 有 `kind?: 'mastra' | 'acp'`（**形态标识 + 分派依据**）+ `modelId?: string`；
  mastra 多一个 `configId`（`AiModelConfig.id`），ACP 多两个绑定字段
  `acpAgentId`（`AcpAgentConfig.id`）+ `acpSessionId`（agent 侧的会话 id）。
- ⚠️ **`kind` 是可缺省的**：新建的会话（侧边栏「新建会话」/ 导入弹窗的「新建会话」/ 进工作区时自动建的那个）
  **刻意不写 kind**，形态由**首条消息时选中的模型**决定 —— 选了某个 ACP agent 的模型（未定形态下会先写进
  `acpAgentId`）就是 `acp`，否则按内部的 mastra 走（没选模型就回退到设置里的默认模型配置）。
  `sendAgentMessage` 里在发请求**之前**把 `kind` 一起写进会话并落盘。
  - 消费方要形态就调 **`conversationKind(conversation)`**（`stores/types.ts`）：已定的按已定，
    未定的按「已经选了什么」推断，都没选返回 `undefined`（会话还没定型，别当 mastra 用）。
  - ⚠️ **`!kind` 同时就是「草稿」判据（`isDraftConversation`）**：草稿 = 还没发出首条消息的会话，
    会话页 / 标签 / 模型选择都挂在它上面，但**不出现在侧边栏列表、不落盘** ——「新建会话」只是
    打开当前工作区的新建会话页，发出首条消息那一刻才转正（标题取那条消息、进列表、落盘）。
    同一工作区已有草稿时「新建会话」复用它（连点两次还是同一个空页）。
    别用 `messages.length === 0` 之类的条件代替（清空过消息的会话 / ACP 会话会被误判）。
  - 未定形态的会话**不落盘**：`setAgentConversationModel` / `setAcpConversationModel` 只改内存
    （落了盘会被 storage 的兜底当成 mastra），也不预置 ACP 会话 id。
- **形态定下来之后不可互切**，ACP 绑定（agent）也不可换，之后只能换模型。
  模型下拉按形态换内容：
  - **ACP：只列 `AcpAgentConfig.models`（设置 → ACP agent 里拉取并勾选的模型）**，
    走 `session/set_config_option` 切换、**不重建会话**；
  - mastra：列全部模型配置；
  - **未定形态：两边都列** —— 选哪个，这个会话就变成哪一类。
  `setAgentConversationModel` 只服务 mastra，ACP 走 `setAcpConversationModel`（签名带 `acpAgentId`，
  未定形态时用它定型）。
- 终端 AI 助手的 `configId` / `modelId` **存在会话上**（`terminalConversations`），不是存在一个按 `sessionId` 的
  `AiChatState` 里 —— 换模型跟着会话走，跨终端页面接着聊也还是那个模型（见 4.22）。
- 请求里带上 `kind` + `configId` + `modelId` + `acpAgentId` + `acpSessionId`，主进程**优先用请求里的，
  取不到才回退**（形态回退到会话记录，再回退到 `mastra`）；会话选的配置被删掉时也要回退，
  否则该会话直接报「未配置」。
- `aiSettings.activeConfigId` 降级为**新会话的初始值**，设置页那颗星叫「默认」。
  （`activeAcpId` 已随架构调整移除：ACP 不再有「默认 agent」，绑定在导入时确定。）
- ⚠️ `saveAgentConversation` 判断 **`kind` / `configId` / `modelId` / `acpAgentId` / `acpSessionId`**
  都用 **`'x' in input`** 而不是 `??`：落盘时每次显式带上它们，`undefined` 表示「这个字段该清掉」，
  必须能覆盖旧值 —— 否则从某个模型切回默认就永远切不回来。
- ⚠️ **加字段时整条链路一起对齐**：`modelId` 曾经在链路上全程缺席（`persistConversation` → preload →
  `ipc/agent.ts` → `storage.saveAgentConversation`），会话里换的模型永远写不进磁盘，重启后回退成
  配置默认模型（用户报告「每个会话设置的模型重启后恢复成默认」）。`acpSessionId` 同款风险：
  它是 `session/new` 时由 agent 返回的，靠 `agent:acp-state` 广播回填、**回填后必须立刻落盘**，
  否则重启后那条会话就变成「没有绑定」的孤儿记录。
- `setAgentConversationModel` / `setAcpConversationModel` **不动 `updatedAt`**
  （配置变更不该让会话跳到列表最前）。
- ACP 常驻连接按 `conversationId` 缓存：同一工作区两个会话必须各有独立 agent 上下文，共用会串味。
- 旧存档（0.0.6 及以前）的 `backend` / `configId` 由 `storage.ts` 的 `normalizeConversation()`
  **读取时迁移**：`backend: 'acp'` → `kind: 'acp'` 且 `configId` → `acpAgentId`，`'ai-sdk'` → mastra；
  旧 ACP 会话本地存过的消息**直接丢掉**（新架构下那份归 agent 管，留着只会是一份不再更新的僵尸历史）。

### 4.4 工作区 Agent 是「工作区 → 多个会话」两层

- 会话 CRUD 走 `agent:conversations:list/save/delete`；**save 只返回单个会话**，不回传全量（会话带完整历史，体量大）。
- 落盘时机是「发消息时 + 一轮结束（finish / error）时」，**不是每个 token**。
- 切工作区用 `selectAgentWorkspace`（自动定位最近更新的**真会话**；一条都没有才退回该工作区的
  草稿，连草稿都没有才现建一个）；「当前会话」一律读 `activeAgentConversationId`，
  **不要再用 workspaceId 索引消息**。
- ⚠️ **「新建会话」是草稿，不进列表**（见 4.3 的 `isDraftConversation`）：点按钮只打开这个
  工作区的新建会话页（内存里真实存在、可选中模型），**发出首条消息那一刻**才转正 ——
  标题取那条消息、形态按选中的模型定、进列表并落盘。侧边栏列表必须过滤草稿
  （`AgentPanel` 的 `byWorkspace`）；别把它当 bug「修」回去，也别在别的列表里忘了过滤。
- 删除会话 / 工作区前先 `abortAgent(id)`，否则主进程的 agent 进程变孤儿。
- ⚠️ 切换功能区**不会**自动打开会话标签（对齐笔记）：只有点侧边栏会话行和新建会话才开标签。
- 会话视图是 **props 驱动**的 `AgentConversationView({ conversationId })`，`AgentPage` 只是薄接线层 ——
  `activeAgentConversationId` 是全局单例指针，多标签并存时只能指向一个，不改成 props 驱动就会两个标签渲染同一会话。

### 4.5 需要用户输入的工具走「挂起 + 广播 + 回填」

- 机制与命令执行确认卡完全相同：`tool.execute` 里挂起 → IPC 广播 → 渲染端渲染卡片 → 用户作答 →
  IPC 回填 resolve → `streamText` **当前回合继续**。
- broker 是全局单例（`ask-followup.ts` 的 `askFollowupBroker`），Agent 页与终端 AI 助手共用一组通道。
- **收尾必须做**（少一步就卡死）：`agent.ts` 的 `finally` 与 `abort` 都要 `askFollowupBroker.cancel(requestId)`
  **与 `clientToolBroker.cancel(requestId)`**（两个 broker 都是挂起式，见 4.23 第 34 条），把挂起的 Promise settle 掉。
- 终端会话请求里带 `sessionId`（工作区带 `workspaceId`），提问卡据此知道自己该送给哪个面板。
- 终端 AI 助手在折叠态收到提问会自动撑开面板（`hasFollowupForSession` 的 effect）。
- ⚠️ 提交后 `resolveFollowup` 立刻删 `followupRequests`，但工具结果（`output`）晚一拍才到 ——
  中间若直接退回普通横条，表单会闪一下。用组件内 `submitted` 本地标记顶住。

### 4.6 主题在首帧前应用，不要用启动画面遮

- 渲染端 `bootstrap()` 异步拿到 preferences 后才应用配色，中间那一帧就是闪变；
  试过「等主题就绪再显示主窗口」，既没解决（首帧仍在）又硬加几百毫秒启动延迟。**要消除，不要遮挡。**
- 正确做法：**preload 在页面脚本之前执行**，这是唯一能赶在首帧前的时机。
  - 主进程 `ipcMain.on('prefs:themeSync')` 用 `event.returnValue` **同步**返回 `{ theme, colorTheme, customColor }`。
  - `preload/index.ts` 的 `applyInitialTheme()` 在模块顶层立即调用。
  - ⚠️ **`document.documentElement` 在 preload 里是 `null`**（跑在 document_start，`<html>` 还没被解析）。
    写成 `if (!root) return` 会让整套逻辑**静默失效**（现象是「改了没用、照样闪」，而主进程那句日志照样打印）。
    必须用 `MutationObserver` 盯着 `document`，`<html>` 一出现立刻补上（回调是微任务，仍在首帧之前）。
  - 纯逻辑放 `src/shared/theme.ts`（preload 够不着渲染端的 `shared/lib/theme.ts`）。
    它**不能引 DOM 类型**（`@shared` 同时被 node 侧 tsconfig 消费、lib 不含 DOM），
    所以 `applyColorTheme` 第三参用自定义 `ThemeElement` 接口，preload 侧另有一份最小声明 `src/preload/dom.d.ts`。
- 验证要看**两段日志**（只看主进程那句会误判）：主进程 `[theme] 首帧主题已交给 preload： …`
  出现在「插件加载」之前；preload `[theme] preload 已补应用首帧主题： … loading`（**结尾 `loading` 是关键判据**）。
- CSP 是 `script-src 'self' blob:`，**不能往 index.html 塞内联脚本**干这件事。

### 4.7 技能：自建 SKILL.md 层，不要指望 SDK 原生能力

- SDK 现状（实测结论，别重复调研）：`ai` v7 的 `SkillsV4` / `@ai-sdk/anthropic` 的 `AnthropicSkills`
  都是**厂商托管 + 上传式**（跑在沙箱容器里，要开 code execution 并用 container 引用）；
  本项目大量用 `openai-compatible`，那条路上**没有任何原生技能支持**。
- 自建实现：一个技能 = 一个目录 + 目录里的 `SKILL.md`（frontmatter `name` / `description`）。
- 发现顺序即优先级：`<工作区>/.dogi/skills` > `~/.dogi/skills` > **`~/.agents/skills`**（跨智能体共享，
  vercel-labs 的 skills CLI 及 amp / codex / cursor / claude-code / opencode / trae 等 18 个 agent 都读它）
  > `~/.claude/skills` > 设置里的额外目录；同名先到先得。
- 给模型用时**只放名称 + 描述**（渐进式披露省 token），正文交给 `read_skill` 工具按需读。
  ⚠️ 不能指望 `read_file` —— 技能的 `resolveInside` 边界是工作区，而用户级 / Claude 技能都在工作区之外。
  没有技能时**不暴露该工具**，提示词里也不出现技能段落。
- ACP 后端不适用（外部 agent 自己管技能）；终端 AI 助手**故意不注入**（它常挂 SSH 远端，本地 SKILL.md 够不着）。
- 踩坑见 6.6 第 25 条（`Dirent.isDirectory()` 对 junction 恒 false；`isDir(join(root,'SKILL.md'))` 永假）。

### 4.8 工作区配置跟着项目目录走

- `<工作区>/.dogi/workspace.json`（当前是快捷功能）。`agentWorkspaces` 在 electron-store 里，那是**这台机器**的数据；
  工作区级配置要跟着目录走就得落在项目里。
- 这个目录名**必须留在** Agent 核心的 `DEFAULT_IGNORE_DIRS` 里，否则文件树与 `list_files` / `search_files`
  会把它当项目代码翻出来（它是环境数据，不是代码）。
- `agent:workspaces:save` 顺手 `ensureWorkspaceConfigDir`：建目录 + `.gitignore`（内容 `*`）+ 默认 `workspace.json`，
  **已存在的一律不动**；工作区目录本身不存在时什么都不创建。
- 读取时 JSON 损坏 → 返回空配置 + `error` 字段，渲染端弹一次 warning，**绝不覆盖原文件**（用户手改的还能救）。
- 快捷功能三类：`link`（外部链接，协议白名单与 `openExternalSafe` 一致）/ `command`（写进 Agent 页内嵌终端）/
  `path`（打开文件管理器，相对路径按工作区根解析）。
- 入口是**顶栏右侧的一个下拉**（Zap 按钮），与文件视图 / 终端 / 打开同一排。
  ⚠️ 用户明确要求**不要单独开一栏**，没配置时也不留常驻空白。

### 4.9 工作区文件预览走自定义协议，别用 IPC 传 base64

- 媒体**不能**走 IPC 读成字符串再塞 data URL：视频动辄上百 MB，base64 再胀 1/3；
  data URL **没有 Range 支持**；且 CSP 里 `<video>` 会落到 `default-src 'self'` 被拦（`<img>` 能用 data:，
  所以「图片能看、视频是黑的」这种半死不活的现象很正常）。
- 协议 `dogi-ws://<工作区 id>/<逐段编码的相对路径>`：
  - `registerSchemesAsPrivileged` **必须在 app ready 之前**（`privileges: { standard, secure, supportFetchAPI, stream }`，
    `stream: true` 正是音视频 Range 的前提），`protocol.handle` 在 `whenReady` 里挂（要早于 createWindow）。
  - 处理器自己 stat + createReadStream + **手写 Range/206**，并**显式给 `content-type`**
    （自定义协议下 Chromium 不会按扩展名猜）。`bytes=start-end` 与后缀形式 `bytes=-N` 都要认。
  - 安全边界：`url.hostname` 取工作区 id（必须已登记，否则 404）→ `resolveInside`（越界 403）。只暴露工作区，不暴露整台机器。
  - CSP 必须同步：`img-src 'self' data: dogi-ws:` + `media-src dogi-ws:`。
- **SVG 是特例**：既能预览又能编辑，标题栏给「预览 / 编辑」切换，默认预览。
  预览一律 `<img src="dogi-ws://…">` —— **绝不把 SVG 源码注入 DOM**（SVG 可带 `<script>`，那是 XSS）。
- 文本走 Monaco（2MB / 二进制限制不变）；明确不可预览的二进制（zip / exe / pdf / 字体…）在 `BINARY_EXTS` 里
  直接提示「不支持预览」，**不要**先读成文本再报错。

### 4.10 插件只有一种加载方式：blob import

- 插件渲染端 = `plugin.json` 里 `renderer: "xxx.js"`（插件目录内的 ESM 源码）。
  链路：`pluginHost.getRendererCode()` 读源码 → 渲染端 blob URL 动态 `import` → 调用 `activate(api)` 注册视图。
- 插件**不写 HTML、不写 preload**，界面直接用宿主注入的 `api.antd` / `api.icons` / `api.MonacoEditor` / `api.cn` 写。
  CSP 里的 `script-src 'self' blob:` 就是为它留的。
- 旧的 `<webview>` 方式（插件自建 HTML + preload + 独立 vite 构建）已整体移除：
  `plugin:webviewInfo` 通道、`build:plugins` / `create:plugin` 脚本、`webviewTag: true` 都没了。
  `rg -i webview src scripts plugins` 应零命中。
- 参考实现：`plugins/redis-client/`（`plugin.json` + `main.js` + `renderer.js`）。
- 内置插件 `plugins/port-killer/`（端口占用）：跨平台按端口找占用进程 + 结束进程。
  Windows 走 `netstat -ano` + `tasklist`，Linux 走 `ss` → `netstat` → `lsof` 逐级回退，macOS 只信 `lsof`。
  结束进程统一用 Node 原生 `process.kill`（Windows 等价 `taskkill /F`、POSIX 是 `kill -9`）——
  选它是因为错误码稳定：**EPERM/EACCES = 权限不足**（返回 `taskkill /F /PID N` / `sudo kill -9 N`
  给用户去管理员终端执行），**ESRCH = 进程已退出**，完全不依赖 taskkill / kill 的本地化文案。
  ⚠️ Windows `netstat -ano` 的 UDP 行**没有状态列**（TCP 5 列 / UDP 4 列），PID 都取最后一个字段；
  PID 0 是系统保留、Windows ≤ 4 与 POSIX ≤ 1 是系统关键进程，一律拒绝结束。
  主结果只收「监听 / 绑定」行；端口只被 TIME_WAIT 等瞬态连接占着时，仍返回并附 note。

### 4.11 浏览器：headless Playwright + CDP screencast

> 旧的「自动化」功能区（脚本管理 / Monaco 编辑器 / 官方 codegen 录制 / `runner.ts` 逐行执行）
> **已整体移除，别恢复**。Playwright 基础设施现在只服务 Agent：`browser_*` 工具 +
> 会话页内嵌浏览器面板（`features/agent/BrowserPane.tsx`）。

**为什么是「无窗口浏览器 + 帧流」而不是 WebContentsView / `<webview>`**：Playwright 只能控制
它**自己启动**的浏览器进程，而 Electron 的 webContents 不是它启动的。所以浏览器 headless 跑，
画面用 `Page.startScreencast` 出帧、直接写进面板的 `<img>`（不走 React state，60fps 的 setState 会拖垮面板），
面板里的鼠标 / 键盘 / 滚轮再经 `Input.dispatch*` 转发回页面。

- ⚠️ **每一帧都必须 ack**（`Page.screencastFrameAck`），**包括被节流丢掉的那些** ——
  不 ack Chromium 就停推，现象是「画面卡在第一帧再也不动」。
- ⚠️ 自带 Chromium 要用 `channel: 'chromium'`，**不能**只写 `headless: true`：Playwright 1.63 下
  后者默认走 `chromium-headless-shell`（另一个 build），它不保证提供 screencast，画面会是黑的。
- ⚠️ `chromium.executablePath({ channel })` **忽略 channel 参数**（实测永远返回自带 Chromium 路径），
  拿它判断「这台机器装没装 Edge」会得到错误答案。系统浏览器自己探安装路径（`resolver.ts`），
  auto 模式按「自带 → Edge → Chrome」**逐个尝试启动**，第一个成功的即采用。
- Playwright 在 Electron 主进程里是 **in-process** 的（`playwright-core` 的 Node 绑定不 spawn driver
  子进程），所以**打包后目标机器上不需要装 Node**。代价是 `playwright` / `playwright-core` 必须在
  `asarUnpack` 里（要能落地执行，不能压在 asar 内）。

**视口不跟随面板尺寸**（设计）：面板宽度是用户拖出来的，按它当视口会让同一个页面在不同窗口
大小下走不同的响应式断点（窗口窄了页面就成「手机版」），不可复现也不能跟用户自己在浏览器里看到的
对齐。视口固定成两套预设（`@shared/browser` 的 `BROWSER_VIEWPORT_PRESETS`）——

- **PC = 1280×800 dpr 1**（默认；Agent 工具也用它）
- **手机 = 390×844 dpr 2**（iPhone 14 的逻辑尺寸与 DPR；页面 `devicePixelRatio` 真的变 2）

切换走 IPC `browser:viewport`，主进程同时改 `page.setViewportSize` 和一条 CDP
`Emulation.setDeviceMetricsOverride(deviceScaleFactor: dpr)`。后者必须在 `setViewportSize` **之后**
发（Playwright 会按 context 创建时的 dpr 再下发一遍，覆盖你）。

⚠️ **CDP screencast 帧恒等于视口的 CSS 尺寸**，与 deviceScaleFactor **无关**（实测 4 种组合：
context dsf=1 / dsf=2，cap 647×1400 / 不限，全出 390×844）—— `maxWidth`/`maxHeight` 只缩不放，
所以帧的数据量只由视口预设决定（PC 1.02MP / 手机 0.33MP，**别再按 dpr 去算「物理像素」**）。
手机帧在 731px 面板里按 object-contain 缩小显示，会有轻微糊（390px 源拉到 554 物理 px）——
这是 Chromium 的固定行为，不是 bug；要更清晰就改预设。

⚠️ **坐标映射必须用「画面矩形」，不能用 img 的元素矩形**：图片是 `size-full` 铺满面板、
画面内部 `object-contain` 居中，四周留黑边 —— 两个 rect 不相等。拿元素 rect 映射会让
点击**整体偏移**，偏移量随离画面中心的距离**线性增长**（中心为 0）。实测 730×622 的面板
装 1280×800 的画面，上下各 83px 黑边：点画面底部打到 y=800（偏 100px），点顶部打到
y=368（偏 **268px**）。
正确做法：`browser-input.ts` 的 `containedRect(elRect, content)` 算等比缩进后的画面矩形，
再交给 `toPageCoords`；落在黑边里的点返回 `null`（不转发）。鼠标与滚轮**都要**用同一个 rect。
（视口 = 面板尺寸的时代这个 bug 看不出来，换了固定预设才暴露 —— 所以任何「视口与面板
不再同宽高比」的改动都要重验点击精度。）

**会话 id 是主进程与渲染端之间的唯一契约**：Agent 用 `agent-browser:<conversationId>`
（一个会话 = 一份浏览器）。推导函数在 `@shared/browser` —— **别在两端各写一份字符串**，
漂了之后的表现是「帧收不到 / 面板一直转圈」，很难查。

**登录态要活得过会话重启**（用户报告过「登录一个账号，重开就没了」）：会话用
`launchPersistentContext(userData/browser-profiles/<会话id>)`，profile 按**会话 id** 一份
（一个 Agent 会话一份浏览器、一份登录态，互不串台）。保留 / 清理的边界 ——
关标签、`browser_close` 工具、应用退出都**保留** profile；只有删 Agent 会话 / 删工作区
（`ipc/agent.ts` → `browserSessions.purge`）才落盘清理。`profilesRoot` 由 `registerBrowserIpc`
注入（session.ts 保持与 Electron 解耦，探针在纯 Node 下跑真源码），没注入就回退临时上下文。
⚠️ 别改回 `browser.newContext()` —— 那是无痕窗口，登录态必丢。
（Chromium 对**不带有效期的会话 cookie** 本就不落盘，真浏览器同理，不算回归。）
验证：`scripts/verify-browser-persistent-profile.mjs`。

- **事件出口只有一处**：`services/browser/handlers.ts`。会话有两条创建路径（面板的 `browser:open`、
  Agent 工具第一次调用时的懒启动），两条都要把帧推到同一组 `browser:*` 通道；broadcaster 由
  `registerBrowserIpc(ctx)` 注入一次（那时才拿得到 `IpcContext`）。所有事件**自带 sessionId**（见 4.2）。
- ⚠️ **面板必须在「会话首次可用」时补报一次尺寸**：`ResizeObserver` 只在面板**自身**尺寸变化时触发，
  而浏览器常常是别人先启动的（Agent 用默认视口起的懒启动）—— 不补报，页面就按旧视口
  比例被压扁、两侧留白。

**Agent 工具定位用 ref，别让模型拼 CSS 选择器**：`locator.ariaSnapshot({ mode: 'ai' })` 产出带
`[ref=eN]` 的可访问性快照（**公开 API**），回解析用 `page.locator('aria-ref=eN')`（公开选择器引擎）。
ref 只在当前页面状态下有效，页面一变（导航 / 重渲染）就得重新快照。

**验证**（都要跑，见 5.2）：`scripts/verify-agent-browser.mjs`（Agent 内嵌面板与 id 契约）、
`scripts/verify-agent-browser-tools.mjs`（Agent 工具行为，直接跑 `services/browser/agent.ts` 的真源码）、
`scripts/verify-browser-persistent-profile.mjs`（持久化 profile：登录态跨会话重启存活 / purge 清理 / 无根目录回退）、
`scripts/browser-input.test.ts`（坐标映射纯函数，可直接 `node --experimental-strip-types` 跑）。

### 4.12 Mosh 会话：SSH 只做引导，终端数据走本地 mosh-client

主机表单勾选「使用 Mosh」（`SshProfile.useMosh`）后，`createFromProfile` 改走 `sessionManager.createMosh`
（`sessions.ts` 的 `MoshSession`），会话带 `SessionInfo.mosh = true` 供连接卡片区分文案（「启动 Mosh」/「Mosh（UDP）」）。

**引导链路**：ssh2 连接（复用 `sshConnectConfig`，与 SshSession 同一套参数）→ `exec('mosh-server new -s -c 256 -l LANG=C.UTF-8')`
→ 从 stdout 解析 `MOSH CONNECT <port> <key>`（`MOSH_CONNECT_RE`；20s 引导超时；mosh-server 打印后自行脱离，
exec 通道关闭不算失败）→ 本地 PTY 里拉 `mosh-client <host> <port>`（原生客户端经 `MOSH_KEY` 环境变量传密钥；
WSL 回退用 `wsl.exe -e env MOSH_KEY=... mosh-client ...` —— Windows 环境变量不会自动带进发行版）。
之后与 SSH 无关：断网 / 切网由 mosh 自己的 UDP 协议恢复，因此**没有** SshSession「断开重开会话」那套逻辑，
只有引导阶段的失败重试（`maxConnectAttempts = 3`，退避 600ms × 次数）。

- ⚠️ **SSH 引导连接特意保持不关**：`MoshSession.exec()` 复用它（mosh 协议没有 exec 通道），
  `ServerMonitor` 的周期采集就靠这条连接。UDP 漫游后它必然失效 —— 监控连续多次失败后自行停止，
  终端照常用。这是明确取舍，别为了「引导完就关」把监控弄死。
- **本地客户端探测**在 `services/terminal/mosh.ts`：PATH（where / which）→ MSYS2 / Cygwin / Homebrew /
  发行版常见路径 → Windows 无原生客户端时回退 WSL（`wsl.exe -e sh -lc 'command -v mosh-client'`，只认默认发行版）。
  命中结果缓存，「没找到」不长期缓存（装好不必重启，下次触发重扫）。渲染端查询走 `terminal:moshStatus`。
- **没有本地 mosh-client 时 `createMosh` 同步抛错**（消息带平台化安装指引），由调用方弹 message ——
  不建立远端连接、不留必然失败的标签页。渲染端两个入口已对齐（`app-store.ts` 的 reconnect 不再静默回退本地终端、
  命令面板 `connectHost` catch 后弹错误），新增连接入口别再想当然地 fallback。
- 远端没装 mosh-server 是引导失败最常见原因：`remoteMoshHint()` 识别 stderr 的 "not found" 附安装命令；
  防火墙需放行出站 **UDP 60000-61000**。
- ⚠️ **zmodem 过不了 mosh**：mosh 不是字节流透传，mosh-server 要维护终端状态再发差分
  （mobile-shell/mosh#1135），`sz` / `rz` 的裸二进制会被当控制序列处理。zmodem 通道只对 SSH / 本地会话有效。
- Windows 无原生 mosh 客户端（mosh.org 明确不提供；纯 JS 实现不存在），只能 MSYS2 / Cygwin / WSL。
  代码给 MSYS2 / Cygwin 版补了同目录 PATH（运行时 DLL 依赖），但 ConPTY 下表现与 WSL 回退的端到端连接
  **尚未实测**（开发机没装 mosh）—— 首次实测后更新本条。

### 4.13 主机日志：记录点在各业务服务，logger 只当汇聚层

「连不上 / 隧道断了 / 指纹变了」的第一现场。数据源是 `services/log/logger.ts` 的 `hostLogger` 单例：
内存环形缓冲（1000 条，`logs:list` 全量读）+ JSONL 落盘 `userData/logs/host.log`（启动回填尾部、
坏行跳过；超 2MB 滚动一代为 `host.log.1`）。落盘经 promise 链串行（滚动与追加不交错），
失败静默降级为仅内存 —— 日志绝不能拖垮业务。

- **记录点分散在各业务服务里**（刻意不做集中采集）：`ssh/connect.ts` 每跳 `[标签] 正在连接 / 已连接（Xms）/
  失败`（标签来自 `ConnectPurpose`：终端会话 / Mosh 引导 / SFTP / SSH 隧道 / 连接测试）+ TOFU
  `首次连接 …已记录主机指纹`；`terminal/sessions.ts` 会话就绪 / 关闭 / 断开（`logClosed` 幂等）/
  握手失败自动重试；`ssh/tunnels.ts` 启动中（带路由）/ 已启动 / 启动失败 / 已停止（`reason`，
  意外中断用 `level: 'error'`）/ 入站与 SOCKS5 转发失败；`sftp/sftp.ts` 三条失败路径 / 已连接 /
  已关闭 / 连接已断开；`ipc/hosts.ts` 指纹重置。新增事件时在**产生事件的业务服务里**调
  `hostLogger.<level>(scope, message)`，别在 IPC 层补。
- 作用域 `ssh` / `tunnel` / `sftp` / `terminal`，级别 `info` / `warn` / `error`，条目带自增 `seq`（类型在 `@shared/types`）。
- **终端命令 + 输出**由 `terminal/recording.ts` 的 `terminalRecorder` 记录进 `terminal` 作用域：`SessionManager`
  在写入真正送达后 `feedInput`、收到输出时 `feedOutput`、会话结束 `close`。命令重建是**尽力而为**——PTY 是
  裸字节流、没有 shell 集成：方向键 / Tab 补全 / 光标移动等无法跟进的转义序列会把当前行作废（宁缺毋错），
  换行仅在 bracketed paste 区间内视为行分隔；来源按写入方标记（键入 / `[AI] ` / `[脚本] `）。
- 输出以 800ms 节流 `hostLogger.update(seq, { detail })` 回填**同一条目**：同 seq 广播 = 覆盖更新 ——
  渲染端 store 按 seq 替换（`onEntry` 里别无条件 append），host.log 同 seq 多行后写为准（启动回填按 seq
  去重取末行）。清洗后为空（纯界面重绘）或与上次回填相同的内容**不重复 update**，防 host.log 被撑爆。
- 每会话另有逐字节原始记录文件 `userData/logs/sessions/<时间戳>-<标题>-<id8>.log`（首个输出块惰性创建、
  20MB 封顶；条目 detail 截 4000 字符并在超长时指回它，文件名进「会话结束：已记录 N 条命令」条目）。
  **条目宁缺、文件保底**：输出没有命令边界标记，块按到达时刻归属「进行中的命令」——作废行回车不抢占
  尚未收到任何输出的槽位；极速连发时输出可能整段落在相邻条目上，以原始文件为准。`logs:clear` 连
  `sessions/` 一起删。
- ⚠️ **`hostLogger.init()` 必须 await 完再 `registerIpc`**（`main/index.ts`）：`filePath` 在 init 里才赋值，
  且要先把历史回填进内存、把 `seq` 校准为文件最大值 —— 顺序反了，注册期事件既不落盘、还会插到历史前面。
- ⚠️ **`registerLogsIpc` 是 `registerIpc` 里的第一个**（`ipc/index.ts`）：`registerTunnelsIpc` 会同步触发
  隧道自启，注册期就有日志产生；订阅（`hostLogger.on('entry')` → 广播 `logs:entry`）必须早于任何会写日志
  的模块。注册期窗口还没创建、广播被静默丢弃没关系 —— 记录已在 logger 内存里，渲染端 bootstrap 的
  `logs:list` 兜住。
- 渲染端镜像封顶 `HOST_LOG_LIMIT = 1000`（与主进程同值）：bootstrap 灌全量 + `logs:entry` 实时追加；
  清空（`logs:clear`）同时清内存与文件，`seq` 继续递增不复用（列表 key 不撞车）。
- 面板（`features/logs/HostLogsPanel.tsx`）是**全局单例标签**（`id: 'logs'`）：工具栏含刷新 / 打开日志目录 /
  清空（Popconfirm），作用域过滤（Segmented）+ 关键字搜索。四个入口：命令面板 / 状态栏左下角菜单 /
  主机侧边栏标题栏图标 / 隧道页工具栏。
- 验证：`scripts/verify-host-logs.mjs`（见 5.2）—— 测试服务器故意拒绝 SFTP 子系统，专门走
  「失败也进日志」的路径。

### 4.14 平台探测：会话就绪后异步探一次，只记在会话上

「这台机器是 Windows 还是 Linux」由 `terminal/sessions.ts` 的 `SshSession.probePlatform()` 在
shell 就绪后异步执行（每次重连重新探测；Mosh 不探测 —— 其本身 Linux-only）：

- **探测顺序**：`cmd /c ver` → `/microsoft windows/i` ⇒ `windows`；否则 `uname -s` → `/linux/i` ⇒ `linux`、
  `/(darwin|bsd|sunos)/i` ⇒ `other`；两条都失败 / 超时（单条 4s，`execTimed`）⇒ 保持 `undefined`
  （旧行为：监控靠「无效结果」兜底，见 4.16）。
- **结果只写 `SessionInfo.platform`（会话级）**，不写进主机配置 —— 同一主机多会话各探各的；
  识别成功落一条 `hostLogger`（「已识别主机平台：Windows（user@host）」）。
- **下游消费者**：监控门控（4.16）、AI 的 `boundHint` 与 `list_terminal_sessions` 输出（`ai/terminal-tools.ts`）。
  Windows 的默认 shell 可能是 cmd 也可能是 PowerShell，所以 AI 提示按「平台」措辞而不是按标题猜。

### 4.15 每主机终端编码：只在 SshSession 边界转码，下游契约恒为 UTF-8

中文 Windows（GBK 代码页）的输出会乱码，而 SSH 传输的是裸字节。方案是**主机级开关 + 边界转码**：

- `SshProfile.terminalCharset: 'utf-8'（缺省）| 'gbk'`（主机对话框「终端编码」字段，仅 `kind === 'ssh'` 显示）。
  **不做自动探测** —— 手工切换是显式操作；探测错了是随机乱码，用户会以为是 bug。
- **转码只发生在 `SshSession`**（`terminal/sessions.ts`），渲染端与记录器契约一律 UTF-8：
  - 输出：stdout / stderr 各一份**有状态** `iconv.getDecoder`（多字节字符跨 chunk 不破），统一走 `emitOutput`：
    utf-8 原字节透传 `onData(buf)`；gbk 解码后重编码为 UTF-8 下发 `onData(utf8Buf, rawBuf)`。
  - `raw` 给 `SessionManager.handleData` 喂 `terminalRecorder`（`raw ?? data`）—— 原始会话日志保持
    **字节级保真**（4.13 的逐字节文件）。
  - 输入：`write()` 里字符串按会话字符集 `iconv.encode`；`Uint8Array` 直通（zmodem 二进制）。
  - `exec()`（监控 / 探测走它）：先整段累积 buffer、close 时一次性 decode —— 分块 decode 会把跨 chunk 的
    多字节字符切成两个替换符。
- **已知限制**（刻意不修，代码有注释）：非 UTF-8 会话里 zmodem 等二进制协议帧会被解码破坏 ——
  Windows 本就没有 sz/rz，UTF-8 会话不受影响。
- 依赖 `iconv-lite`（仅主进程）。

### 4.16 监控不支持态：非 Linux 是**明确终态**，不是静默停

监控采集依赖 Linux 的 `/proc` 与 `df`，Windows / BSD / macOS 永远采不到数据。旧行为是「采不到就不推」，
用户看到的是「监控条没了」而不是「为什么不支持」—— 现在做成显式状态：

- **判定**（`terminal/monitor.ts`）：平台已识别且 ≠ `linux` ⇒ 立即上报 `unsupported(platform)` 并自停；
  平台未知但连续 3 轮结果无效（`MAX_INVALID`）⇒ `unsupported('unavailable')`（覆盖探测失败的 Unix 系）；
  采集命令连续失败 15 次（`MAX_EXEC_FAILURES`）才停 —— 连接抖动要能自愈，不能一失败就判死。
- **链路**：`SessionMonitor('unsupported')` → `MonitorService`（转发 + 移除管理表）→ `ipc/monitor.ts`
  广播 `monitor:unsupported` → preload `monitor.onUnsupported` → store `monitorUnsupported[sessionId]` →
  状态栏 `MonitorBadge` 退化为「不支持监控」静态标识（带 Tooltip；仅当无新鲜指标时显示）。
- **清理时机**（store）：收到新鲜 `monitor:data`、`terminal:closed`、会话重连迁移 —— 三处都会清标记。
- 本地终端且本机非 Linux：`MonitorService.start` 直接静默跳过（不给徽标噪音）。
- 验证：`scripts/verify-windows-host.mjs`（Windows 会话 0 条 `monitor:data` + 恰好一次 `unsupported`）。

### 4.17 RDP 子系统：独立主机类型 + 主进程本地桥 + 渲染端 WASM 客户端

Win 服务器图形化操作走内嵌 RDP（不调 mstsc）。**远程桌面是主机的一等类型**
（`kind: 'rdp'`，与 `ssh` / `local` 并列，新建 / 编辑主机对话框三分段可选、可改）——
主机右键菜单的「远程桌面 (RDP)」直达入口**已移除，别再恢复**：rdp 主机走普通「连接」动作开标签。

- **主机配置**：`host` / `port`（默认 3389，即 RDP 端口）/ `username` / `domain`（`SshProfile.domain`，
  域环境填域名）/ `password`（safeStorage 加密，列表只给 `hasPassword`）。终端 / SFTP / 隧道都不服务
  rdp 主机（菜单不出现对应项；`terminal:create` 主进程侧直接拒绝）。新建对话框切到「远程桌面」时
  端口与用户名同步预填 3389 / `administrator`（与 ssh 的 22 / `root` 对切；用户改过的值不动）。
- **渲染端** `features/rdp/RdpPage.tsx`：`ironrdp-wasm`（IronRDP 编译成 WASM）画到 canvas，负责键盘 / 鼠标
  转发（scancode 表见文件内 `KEY_SCANCODES`，扩展键 0xE0xx）、缩放、Ctrl+Alt+Del。开标签先经
  `rdp:credentials` 读主机配置：有密码直接自动连接；没密码弹凭据对话框，勾选「保存到主机配置」会把
  用户名 / 域 / 密码写回主机（加密存储）；「修改凭据」/「重新连接」都复用同一个对话框。
- **主进程** `services/rdp/bridge.ts`：每座桥一个 `WebSocketServer`（127.0.0.1 随机端口 + 24 字节随机 token
  路径），把 WebSocket 流量接到目标 `host:port` 的 TCP/TLS 上。协议是 **RDCleanPath**（WASM 客户端的第一条
  二进制消息是 DER 请求）：桥替它完成 TCP 连接、X.224 交换、TLS 握手（`rejectUnauthorized: false` 是协议
  设计 —— 证书链随应答回填，由 WASM 客户端自己校验），随后双向透传（NLA / CredSSP 在透传的 RDP 层内，
  与 TLS 无关）。握手失败统一回错误 PDU（1/502），**真实原因在主机日志（别只看错误码）** —— 对端
  证书缺 `digitalSignature` 用途位时 BoringSSL 会掐断默认握手（`KEY_USAGE_BIT_INCORRECT`），
  桥自动降级 TLS 1.2 静态 RSA 套件重试一次（机制与套件命名坑见 6.4 第 17 条）。
- **安全基线**：桥只连 open 时固定的 `host:port`（请求里的 destination 必须一致，拒绝任意转发）；
  渲染端拿到的只是本地 wsUrl。`rdp:open(connId, profileId)` 的 host / port **全部取自主机配置**
  （非法端口兜底 3389；`rdp:credentials` 的端口口径与桥一致）。
- **标签**：`PanelTabType` 新增 `'rdp'`，标签 id = connId = `rdp-<profileId>`（一主机一标签一座桥，
  `rdp:open` 幂等；store 的 `connectHost` 对 rdp 主机走这条分支）。关标签 → `rdp:close` + 会话 dispose。
- **wasm 资产**：`scripts/copy-rdp.cjs`（predev / prebuild 钩子）把 `ironrdp-wasm` 的 wasm 复制进
  `renderer/public/rdp/`；**生产渲染端是 `file://`，fetch 拿不到 URL**（见 6.3 第 13 条），运行时改走
  `rdp:wasm` IPC 读字节喂给 init。CSP 相应放行 `'wasm-unsafe-eval'` 与 `connect-src ws://127.0.0.1:*`。
- **本轮不做**（刻意）：剪贴板 / 音频 / 磁盘重定向、跳板机链路。
- **验证**：`scripts/verify-rdp-bridge.mjs`（桥协议端到端）+ `scripts/verify-rdp-host-ui.mjs`（三分段对话框
  → 保存 → 编辑回填 → 连接 → 凭据回写全链路）。表单侧坑见 6.5 第 31 条。

### 4.18 ACP 会话：发现 → 导入 → 回放，本地不存消息

ACP 是「别人的 agent 在别人的进程里管自己的会话」。本应用只做三件事：
**登记 agent、按 id 拉它的会话列表、把选中的会话绑成一条本地记录**。
消息一行都不落盘（见 4.3 的形态说明）。

- **登记 agent 只有一处入口**：**设置 → ACP agent**（`features/settings/AcpAgentSettings.tsx`），
  完整管理（检测 PATH / 手动添加 / 删除）+ **拉取并勾选模型**。侧边栏的**导入弹窗**
  （`features/agent/AcpImportDialog.tsx`）只做「选已登记的 agent → 拉取会话 → 导入」，
  footer 的「ACP 设置」按钮直达设置页 —— 别再把登记入口加回弹窗（用户明确要求收敛）。
- **模型来源 = 设置里勾选的模型**：`AcpAgentConfig.models` 由设置页「拉取」
  （`acpAgentService.listModels`，临时建连读 `session/new` 的 configOptions）后勾选，或手工填。
  会话页的模型下拉**只列这一份**（不读 agent 现场上报的那一份：里面常混着用不了的档位）；
  一个都没勾时给一条「先去设置里拉取」的禁用提示。ACP 走 `session/set_config_option` 切换、**不重建会话**。
- **发现（`session/list`）**：`acpAgentService.listSessions(cfg, cwd)` 建**临时连接**
  （initialize → 翻页拉列表 → 杀进程），按工作区目录过滤。agent 没广告
  `sessionCapabilities.list` 时**报明确错误**（不是返回空列表 —— 那会让人以为「没有会话」）。
- **导入**：只写一条本地记录（`kind: 'acp'` + `acpAgentId` + `acpSessionId`），标题取 agent 给的；
  同 agent + 同 sessionId 已存在就跳过，不会生成重复记录。
- **新建**：走侧边栏「新建会话」（草稿）→ 模型下拉里选**该 agent 的模型**（未定形态会先写进
  `acpAgentId`）→ 发出首条消息时按 4.3 定型并 `session/new`，返回的 id 由 `agent:acp-state`
  广播回填后落盘。⚠️ **不要**为了「新建会话」在临时连接里就 `session/new`：
  非持久化 agent 一杀进程那个会话就没了。
- **回放（`session/load`）**：打开会话（会话标签 `visible`）时让 agent 把历史作为 `session/update`
  重放，主进程的 `HistoryAssembler`（`services/ai/acp-history.ts`，纯逻辑、可单独验证）
  按 `ContentChunk.messageId` 把 chunk 拼成消息列表，作为**一条 `history` 事件整段下发**
  （渲染端直接替换 `agentAcpMessages`）。
  - ⚠️ **工具结果的归属只能靠 `toolCallId`**：`ToolCall` / `ToolCallUpdate` 协议里**没有 messageId**，
    所以 `pushTool` 必须把结果路由回**调用所在的那条消息**，不能塞给「当前消息」——
    回放里「调用 → 完成更新」之间常夹着下一条消息的正文，塞错就会变成渲染端的**孤儿工具行**
    （正文后面莫名多出两条工具、整条消息被折叠，见 6.6 第 34 条）。
  - 回放出来的 parts 顺序**忠实于 agent**：末尾可能是工具调用（正文在前）。
    渲染端的折叠规则因此必须保证「正文绝不被折进折叠条」（`findTailStart`）。
  - ⚠️ **必须整段下发、不要逐条流式**：`session/load` 的响应本就在回放结束后才返回，逐条追加
    遇到「标签反复挂载 / StrictMode 双跑」就会把历史上屏两遍。主进程对同一会话的重复 `load`
    请求也做了去重（`loadRequests`）。
  - ⚠️ **回放不是一轮对话**：`finish` 事件落地前要先看「当时是否在回放」（store 里的 `acpLoading`），
    否则每次打开 ACP 会话都会弹一条「Agent 已完成」系统通知。
- **降级**：agent 没声明 `loadSession` 时，导入的 sessionId **在本连接里无法激活**
  （`session/prompt` 只认本连接建过 / 载入过的会话）。
  - 打开会话要历史 → **直接报错**（`allowNewOnUnsupportedLoad: false`）；
  - 提问 → 退回 `session/new` 建新会话并**重绑**（广播新 id + 弹一条 warning 说明历史看不到）。
    ⚠️ 别把这条降级挪到「打开会话」的路径上：那会让「看一眼历史」把绑定悄悄换掉。
- **模型切换**：`session/set_config_option`（optionId 取自 `session/new | session/load` 响应的
  `configOptions` 里 `category=model` 那一项），**不重建会话** —— 重建会丢 agent 侧上下文。
- **删除**：默认只删本地绑定（agent 侧会话留着，下次还能导入回来）；删除确认框里可勾选
  「同时删除 agent 侧会话」（走 `session/delete`，agent 没声明该能力就只提示、本地照删）。
- **消息的本地镜像** `agentAcpMessages: Record<conversationId, AgentChatMessage[]>` 只在内存里：
  重启后为空、靠重新 `session/load` 恢复。因此 ACP 会话**不提供**「编辑重发 / 从这里重新开始」
  （本地删改只会让画面与 agent 侧上下文不一致，重开又回放回来）—— UI 侧按 `kind` 禁用了入口。

### 4.19 接口调试的请求体四形态：none / raw / x-www-form-urlencoded / form-data

- 类型在 `@shared/types` 的 `ApiBodyType`；界面上是**横向分段**（antd `Segmented`，≈ 横向 radio，
  与主机类型 / 隧道类型同款，**不带描述文案**）。请求条目上是 `bodyType`
  （**缺省 = raw**，兼容历史数据；`none` 是显式选择，不是缺省），
  两种表单**各存一张表**（`bodyUrlencoded` / `bodyFormFields`）—— 来回切模式不会把另一种填好的内容冲掉。
- `none` = **不携带请求体**：主进程 `prepareBody` 直接返回空（body 与 Content-Type 都不碰），
  渲染端切换时也**不动**请求头里的 Content-Type —— 没有正文就没有「对不上」的问题，
  用户自己填的头原样保留。GET / HEAD 本来就不带 body（老行为，别顺手「修」）。
- **Content-Type 谁说了算**：切模式时渲染端把请求头那一行一起换掉（`setContentType`：没填、
  或填的还是另一类表单才覆盖；用户自己写的比如带 charset 的 urlencoded 不动）；
  切回 raw 时表单类换成 `application/json`。发送时主进程再兜一层：
  urlencoded **只在没有** Content-Type 时补标准的那个；form-data **一律删掉**请求头里那份 ——
  它没有 boundary，留着服务端按它解析会把整个 body 当垃圾（boundary 只能由运行时生成）。
- **文件字段**：`ApiFormField.isFile` + `value` = **本地绝对路径**，主进程 `prepareBody` 读文件塞进
  `FormData`（MIME 按扩展名给，认不出的用 application/octet-stream；filename 取路径末段）。
  form-data 表格的列序是**字段名 → 类型（文本 / 文件）→ 值**：先决定这行是什么，再看/填值；
  选「文件」时值那一格变成只读文件名 + 「选择文件」按钮。
  选文件走 `api:pickFile`（主进程弹对话框 + stat 出名字与大小）—— **渲染端只拿路径**，
  不把文件内容搬进内存再走 IPC。文件没选 / 读不到 → `status=0 + error` 且**根本不发包**。
  ⚠️ 原生对话框无法自动化：探针用 `DOGI_API_PICK_FILE` 旁路（同 sftp:uploadDir 的约定），正常运行不设。
- **GET / HEAD 允许携带请求体**：四种形态都可带。Node 全局 `fetch` 的 Request 构造会拒绝
  GET/HEAD 带 body（抛 “Request with GET/HEAD method cannot have body”），所以这条支路由
  `undici.request`（更底层，不强制该限制）发出，逻辑在 `src/main/services/api/http.ts` 的 `executeHttp`。
  ⚠️ 别为了「统一」把它塞回 `fetch`——那样 GET/HEAD 带 body 又会整条失败（status=0 + 该报错）。
- cURL 导入：`-F`（含 `@文件`）映射成 form-data 字段；不再拼成 `a=b&c=d` 文本配一个没有 boundary 的
  multipart 头（那样服务端根本解析不了）。`-d` 仍是 raw 文本。
- 加字段/加形态时**整条链路一起对齐**（落盘、历史、草稿种子、transfer 的 `apiOut` 白名单），
  少一处就是「保存后形态变回 raw」或「导出后请求体空掉」。
- 验证：`scripts/verify-api-body-types.mjs`（主进程真源码 + 进程内 HTTP 服务器，逐字节比对文件内容）、
  `scripts/verify-api-body-ui.mjs`（真界面点选 / 填表 / 选本地文件 / 发送 / 落盘回读）。

### 4.20 上下文压缩 + 会话累计 token：压缩只改「这一次请求」，不改历史

移植自 fishwork（`packages/agent/src/context.ts`）。**两道独立的闸**，顺序固定：
先按**条数**截断（`AiModelConfig.contextMessages`，缺省 20），再按 **token** 预算压缩
（`AiModelConfig.contextBudget`，缺省 80k，设置页可填）。两道都过不了的极端情况（单轮就超预算）不压缩。

- **按轮摘要而不是按 token 滑窗**：滑窗从中间切断 tool-call / tool-result 会破坏协议
  （tool 消息必须紧跟它的 assistant），按轮切天然合法；代价是粒度粗，但摘要也是模型做的。
- ⚠️ **压缩结果不落盘、不改会话记录**：它只决定「这一次 `agent.stream()` 带哪些消息」，
  屏幕上的历史始终是原文（可翻 / 可复制 / 可编辑重发）。所以**会话累计 token 是现算的**
  （`@shared/agent-usage` 的 `sumUsage`），不在会话上另存累计字段 —— 另存就多出一个可能与消息对不上的副本。
- **摘要失败 → 回退成截断**（`truncated: true`）：保证请求还能发出去，不会因为一次摘要失败把整轮搞挂；
  界面如实写「摘要失败，旧轮已截断丢弃」，不假装细节还在。
- 事件 `context-compressed` 只是**通知**，不进消息 parts。⚠️ 必须 `setTimeout(…, 0)` 延后再发：
  此刻 requestId 还没登记进 `chatConversations` / 渲染端的 `aiRequestSessions`，直接广播会被整条丢掉（同 4.2）。
- 消息列**顶部**只粘一条提示条（`ContextNoticeBar`）：**上下文已压缩**（自动 / 手动压缩都写它）。
  ACP 会话不参与（历史由 agent 自己管，`messages` 恒空）。
  ⚠️ **会话累计 token 不在这里**，它在输入框的上下文圆环（`ContextRing`）详情里的「会话累计」段 ——
  与 fishwork 一致。累计每轮都在变，粘顶部会一直晃，而且是圆环里同一份数据的第二个副本
  （迁移时正是这个重复，别再搬回顶部）。
- 验证：`scripts/verify-context-compression.mjs`（`.tooltest` 包装跑真源码，覆盖不超预算零拷贝、
  切轮边界、摘要失败回退、非法预算；摘要成功路径要真调模型，属集成验证）。

### 4.21 文件视图（Agent 工作区）：树、菜单、以及「先关标签再动盘」

左侧文件树 + 右侧多标签编辑区（`features/agent/AgentFilesPanel.tsx`）。树懒加载（点开一层读一层），
忽略规则与 Agent 工具一致（`.gitignore` + `DEFAULT_IGNORE_DIRS`，见 4.8）。

**右键菜单 / 触屏长按是同一份 menu**：行上包 antd `<Dropdown trigger={['contextMenu']}>`，
再用 `useLongPressMenu`（同文件）补触屏 —— 500ms 长按、位移超 10px 取消、长按成功后**吞掉随之而来的
那次 click**（否则会顺带展开目录 / 打开文件）。鼠标全程不参与长按逻辑（`pointerType === 'mouse'` 直接return）。

**写操作四条通道**（`agent:fs:delete / rename / create / copy`，实现都在 `services/ai/workspace-fs.ts`，
与 `list/read/write` 共用 `resolveInside` 边界；删除语义与 Agent 的 `delete_file` 工具一致，改一处同步另一处）：

| 语义 | 约定 |
| --- | --- |
| 删除 | 目录 `rm -r`；根目录一律拒绝（删它等于抹掉整个工作区） |
| 重命名 | 只改名字不换目录；名字不许带 `/` `\`、不许是 `.` / `..` |
| 新建 | 父目录自动补；已存在**拒绝**，不覆盖 |
| 复制 | 原名空着就照用；撞名才加后缀 `name 副本.ext` → `name 副本 2.ext`（后缀挂**原名**上，点开头的文件如 `.gitignore` 不算扩展名） |
| 移动 | `mode: 'move'`；撞名**直接报错**（静默改名会让用户以为「移过去了」）；目录不许移进自己子目录；跨设备 rename 报 EXDEV 时退化成 copy+rm |

⚠️ **删 / 移 / 重命名一个已打开的文件，必须先关掉它的标签**（`withTabsClosed`，未保存改动复用关标签那套确认）。
不先关的话：标签还指着旧路径、Monaco 的 model 还按旧 URI 建，之后一次保存就**写到不复存在的路径上**。
反过来把标签路径改到新位置要连 model 一起迁移（撤销栈 / 行尾 / 光标全得搬），所以选「关掉」。

剪贴板是**渲染进程内存态、一次一项**（树上没有多选），刻意不碰系统剪贴板（会污染用户自己复制的内容）；
剪切粘贴成功后立即清空（留着会让人以为还能再粘一次）。

### 4.22 两条 AI 线合并成一台引擎：终端助手走 `scope:'terminal'`

**一台引擎、两种作用域。** 工作区 Agent 与终端 AI 助手共用 `services/ai/agent.ts` 的 `AgentService`，
由 `agent:chat` 请求里的 `scope`（`'workspace' | 'terminal'`）分派；旧的 `services/ai/ai.ts`
（每终端一个 `AiAssistant` 实例）与 `ai:chat` / `ai:abort` / `ai:confirm` / `ai:chat-event` 四条通道
**已整体删除**，别再加回来。

| 维度 | `scope: 'workspace'` | `scope: 'terminal'` |
| --- | --- | --- |
| 工具 | `list_files` / `read_file` / `write_file` / `edit_file` / `search_files` / `find_files` / `execute_command` / `delete_file` / `browser_*` / `read_skill` | `run_in_terminal` / `send_keys` / `read_terminal_output` / `list_terminal_sessions` / `ask_followup_question` |
| 共有工具 | `read_tool_output`（`scope:'both'`）：读超长工具输出落下的产物文件（见 4.24） | 同左 |
| 系统提示词 | `agent-core` 的工作区提示词 | `terminal-tools.ts` 的 `buildTerminalSystemPrompt`（含平台提示） |
| 归属 | `requestMeta` 按 `conversationId` 记 `workspace` | 记 `targetSessionId`（**来自发起消息的那个终端页面**） |
| 会话存储 | `conversations/` 目录 | `terminal-conversations/` 目录（第二个 `ConversationStore` 实例） |

- **工具绑定按请求算，不记在会话上**：`ctx.targetSessionId` 由请求携带，所以历史会话换一个终端
  接着聊时，工具自然作用在新终端上（会话记录里不存 terminalId）。
- ⚠️ **终端会话绝不进 `agentConversations`**：靠**存储边界**保证 —— `ConversationStore('terminal-conversations')`
  是独立实例、独立目录、独立的一组 `storage.*TerminalConversation*` 方法。
  **别**改回「同一个池 + 消费方过滤」，那等于把过滤义务摊给每一个列表（侧边栏、搜索、导出、统计…）。
- **草稿判据与 Agent 不同**：Agent 草稿 = `!kind`（4.3），终端草稿 = `terminalDrafts[sessionId]` 里
  存在（内存态，不落盘）。两者都在**发出首条消息那一刻**转正：标题取那条消息、进列表、落盘。
- **清空历史已移除**：改成左侧会话列表里的逐条删除（Popconfirm → `agent:terminal-convs:delete`），
  会话池是跨终端页面共享的，一刀清掉会连带删掉别的页面正在用的会话。
- **模型按会话独立**：终端会话同样有 `configId` / `modelId`，下拉在卡片头部。
- **确认卡共用一张表**：工作区来源带 `workspaceName`，终端来源带 `sessionId` / `sessionTitle`
  （`AgentConfirmRequest = AiConfirmRequest`），一条 `agent:confirm` 通道，`pendingConfirms` 一张表。
- **验证**：`scripts/verify-terminal-chat.mjs`（隔离实例 + 进程内 mock LLM：作用域工具集、终端会话
  独立存储、草稿转正、逐条删除、重启后仍在）。

### 4.23 工具注册表 + 客户端工具（A 方案：定义随请求、权限在渲染端）

工具不再是「谁需要就自己 `build()` 一份」，而是**主进程一份静态注册表** + 每次请求动态组装。

**注册表**（`services/ai/tool-registry.ts`）：`AiToolDef` = `{ name, description（字符串或按 ctx 现算的函数）,
inputSchema, scope: 'workspace'|'terminal'|'both', available?, execute(input, call, ctx) }`。
`builtin-tools.ts` 的 `ensureBuiltinToolsRegistered()` 在启动时一次性登记
终端组 + 工作区组 + `read_skill` + `ask_followup_question` + 浏览器组（浏览器组要渠道，
所以传的是 `() => BrowserChannel` 的延迟读取）。

`buildToolset({ ctx, extra?, clientTools? })` 的顺序与让位规则：

1. 内置定义，按 `scope` + `available` 过滤 —— `available` 收 `{ctx, mcpToolNames}`，
   用途是「没技能就不暴露 `read_skill`」「MCP 带了 `browser_*` 就整组让位」（两套同名会静默互相覆盖）；
2. **随请求携带的客户端工具**：与内置同名时**让位并 warn**（内置优先）；
3. `extra`（MCP 工具）最后展开，同名覆盖一切（历史行为，别动）。

⚠️ **别在注册层加权限闸**：改动类工具的闸在自己的 `execute` 里（`guardWrite` 要在「确认也会失败」
的预检之后才弹卡，包在外面只会白白打扰用户）；客户端工具**根本没有主进程闸**（见下）。

**客户端工具**（渲染进程执行的能力：在文件视图里打开文件、切标签、插件注入的界面能力…）：

- **定义随请求走**：`registerClientTool(def, handler)` 是纯渲染端注册（`stores/client-tools.ts`，
  内存态），发送时由 `sendTerminalMessage` / `sendAgentMessage` 统一带上
  `clientTools: listClientToolDefs()`。**没有**「预注册 + 主进程持有」的通道，也别加回来 ——
  带哪组定义是**哪个页面在发消息**决定的，主进程预先持有就等于把作用域判断搬到主进程。
- **执行 = 挂起 + 广播 + 回填**：`clientToolBroker.invoke()` 挂起 → 广播 `clientTools:invoke`
  （带 `callId` / `requestId` / `conversationId` / `scope`，见 4.2）→ 渲染端 `handleClientToolInvoke`
  执行 → `clientTools:result` 回填 resolve，**当前请求的模型循环随即继续**
  （不是客户端另起一次请求 —— 那要重建整条历史且丢中间态）。
- **权限与确认全在渲染端**：`full` 直接执行；`confirm` 弹 antd `Modal.confirm`，
  **拒绝时作为正常工具结果回填**（"用户拒绝了这次调用…"），模型看得见原因并改道 —— 不是 tool error。
- ⚠️ **任何分支都必须回填一次**，否则主进程那个 Promise 永不 settle、整轮卡死
  （abort / 流结束的 `cancel(requestId)` 只是兜底，正常路径别依赖它）。
- 收尾纪律与 ask-followup 同款：`AgentService` 的 `finally` / `abort` 都要 `clientToolBroker.cancel(requestId)`。
- 探针要造客户端工具时用 `window.__clientTools`（与 `window.__store` 同一个 CDP 调试约定，
  只在渲染端暴露，不进 preload 白名单）。
- **验证**：`scripts/verify-tool-registry.mjs`（注册纪律 / 作用域 / `available` / MCP 覆盖 /
  动态描述 / 随请求组装与同名让位 / broker 广播-回填-取消）。

### 4.24 超长工具输出落「产物」：写命令时订阅实时流，超限给 id 让模型续读

工具输出超过内联上限时不能只截断——被砍掉的中段模型再也拿不回来，命令跑了两万行日志时
等于「只看到头和尾，中间发生了什么全靠猜」。做法是 `services/ai/output-artifact.ts`：
**超限时把完整输出落到 `userData/tool-output/<id>.txt`，工具结果里给模型 id / 总量 / 下一次该带什么参数**，
模型用 `read_tool_output` 按 `(id, offset, length)` 一段段续读。

| 常量 | 值 | 含义 |
| --- | --- | --- |
| `ARTIFACT_INLINE_MAX` | 12000 | 超过就落盘（终端工具） |
| `ARTIFACT_HEAD_CHARS` | 3000 | 内联里保留的**开头** |
| `ARTIFACT_MAX_CHARS` | 4MB | 单个产物的上限，超出后 descriptor 标 `truncated` |
| `ARTIFACT_READ_MAX` | 20000 | `read_tool_output` 单次最多返回多少字符 |

- **内联文本 = 开头 + 说明 + 滚动结尾**。说明里必须写清三件事，缺一个模型就接不下去：
  总量、省略了多少、**下一次调用的完整参数**（`{"id":"…","offset":3000,"length":8000}` 原文嵌在句子里）。
- ⚠️ **head / mid 是滚动预览，与文件写入互不影响**：哪怕第一块就超过内联上限、已经 spill，
  开头照样要从这一块的前 `headChars` 个字符里填（早期实现给 `head` 加了 `&& !this.stream` 的条件，
  于是「一条超长命令」的内联里只剩结尾，模型连命令是什么都看不到）。
  `mid` 必须是**滚动**的（`pushTail` 按预算截尾），否则内联的「结尾」是 spill 那一刻的内容，不是真正的末尾。
- ⚠️ **必须订阅实时 `data` 流，不能「先记长度、事后取增量」**。环形缓冲 256KB 是**有损**的，
  一条刷屏命令跑完再取增量只会拿到 `''`（模型收到「完全没有输出」）。所以 `captureDuring()`
  在**写命令之前**就挂上 `sessionManager.on('data')`，写完等 `waitMs` 再摘监听。
  ⚠️ 因此 `TerminalSession.outputLength()` / `outputFrom()` 已从接口与三个会话类里**删除**，
  只在注释里留了「为什么删」——别为了让新代码好写把它们加回来，那正是这个 bug 的源头。
  同理 `execute_command`（`agent-core/tools.ts`）也从 `child.stdout.on('data')` 边收边写，
  它原来是 `slice` 截断，丢了就永久丢了。
- **ANSI 要跨块有状态剥离**：转义序列会被 chunk 边界劈开，`AnsiStripper` 永远从**最后一个 ESC**
  往后扣住（`MAX_HOLD = 512` 封顶）交给下一块，逐块独立正则会把半截的 `\x1b[` 当普通字符吃掉。
- ⚠️ **id 是安全边界**：文件名由 `newArtifactId()` 生成，`artifactPath()` 用
  `/^[a-z0-9-]{6,80}$/` 校验后才拼路径（顺带挡掉 Windows 保留名），**任何地方都不要把路径或 `dir` 交给模型**。
  跟 `workspace-fs.ts` 的 `resolveInside` 是同一类防护——模型能传参数，就能传 `../../`。
- **清理**：删会话 / 删工作区时 `purgeArtifacts(conversationId)`（id 里嵌了会话 slug，按 `${slug}-` 前缀删），
  写在这三处 `ipc/agent.ts`：`conversations:delete` / 工作区删除循环 / `terminal-convs:delete`。
- **验证**：`scripts/verify-output-artifact.mjs`（纯 Node，44 条）+ `scripts/verify-terminal-chat.mjs`
  第 3b 节（真界面端到端）。

### 4.25 会话多了会卡：列表与消息流都不许「订阅整个 conversations」

**症状**：会话列表起初不卡、消息一多就卡；主区域消息流滚动同样随消息数变卡。
**根因不是数据量本身，而是「每个 token 换掉整张表 → 订阅方整棵子树重渲染」**：
流式输出每个 delta 都会 `appendToLast`（换 `messages` 数组）→ `patchConversation`
（换会话对象 + 换**整个** `agentConversations` 数组）。凡是 `useAppStore((s) => s.agentConversations)`
或返回其中**某个对象**的 selector，都会被每个 token 带着重渲染。

**三条已落地的修法**（都是「订阅投影 + 结构共享」，别退回直接订阅）：

| 位置 | 修法 |
| --- | --- |
| 侧边栏会话列表（`features/agent/AgentPanel.tsx`） | 订阅 `selectConversationListMeta(s.agentConversations)`（`features/agent/conversation-list-meta.ts`）：只投影列表可见字段（id / 归属 / 形态 / 标题 / 排序键 / ACP 绑定），可见字段没变就**交出上一次的数组与条目对象**；行再 `memo` 化成 `ConversationRow`，只接原始值 + 固定引用回调。状态图标（等提问 / 等确认 / 运行中）由父组件**一次遍历**算成 `Map` 传给行，别在行里 `Object.values(x).some()`。 |
| 面板标签条（`app/layout/PanelView.tsx`） | Agent 标签的自动标题**只取 `title` 字符串**，别返回会话对象 —— 标签是常驻挂载的（见 6.5 第 26 条），返回对象等于每个 token 重渲染每个 Agent 标签条。 |
| 消息目录（`features/agent/MessageOutline.tsx`） | ① `items` 只依赖「用户提问」投影（`selectUserMessages`，按**引用**比对复用 —— 流式期间用户消息对象不动，只有 assistant 在长），不再每个 token 重算「过滤全部消息 + 抽每条提问的纯文本」；② scroll-spy **缓存消息元素 + 二分查找**（DOM 顺序 = 时间顺序、`rect.top` 单调，二分成立），每帧 O(log n) 次布局读取；③ 重算的 effect 依赖 **`items.length` 而不是 `messages`** —— assistant 正文增长时所有提问的位置纹丝不动，没必要每帧重算（滚动中的位置变化由 scroll 监听覆盖，另外补了 `window.resize`）。 |

⚠️ **别用 `useShallow` 顶替结构共享**：条目对象每帧都是新的，浅比较照样失败；
也别在组件里 `useMemo(..., [s.agentConversations])` —— 依赖项本身就是每帧换的数组。

⚠️ **`use-stick-to-bottom` 别给每个折叠横条都建实例**（`CollapsibleRow` 原先无条件建）：
一个实例 = 一个 ResizeObserver + 一套 scroll / wheel 监听器（每次滚动都读 `scrollHeight`），
一条会话里几十个工具 / 思考横条就是几十份，而**只有真需要吸底的那一行**（流式中的思考面板 /
正在生成的工具行，`stickToBottom` 为真）需要它。现在拆成 `StickyBody`（带 hook）与不吸底的
纯 DOM 两个分支按 `stickToBottom` 二选一渲染 —— hook 仍在 `StickyBody` **内部无条件**挂载
（`contentRef` 是 callback ref，条件挂载会把观察起点拖到开关翻转那一帧，见原注释）。

- **仍然存在的结构成本（刻意没做）**：消息流**没有虚拟化**，所有消息常驻 DOM
  （`AgentPage.tsx` 里明写「非虚拟列表下每条消息都在 DOM 里」）。滚动长会话的剩余开销就在这里；
  真要治只能上窗口化（react-window / @tanstack/react-virtual），会牵动 Ctrl+F、
  滚动锚定、消息目录跳转与吸底跟随，属独立一轮改造。
- **验证**：`scripts/verify-agent-list-projection.ts`（纯 Node：500 次流式增量后投影引用不变、
  改名 / 转正 / 增删才换引用）+ `scripts/verify-agent-outline-scroll-cost.mjs`（真界面**计数**
  `getBoundingClientRect` / `querySelector`：提问 50 → 300（6 倍）时每帧布局读取比值 1.34，
  修复前那段线性扫在 1200 个消息元素上是每帧 621 次）。

### 4.26 自动更新：GitHub Releases + 静默检查（正式通道）

`services/updater.ts`（`electron-updater` 封装，单例）+ `ipc/updater.ts`（转发）
+ preload `updater` 命名空间 + 渲染端 `app/UpdateNotifier.tsx`（唯一提示出口）
与设置页左下角的版本号（点它 = 检查更新 / 已下好时点它 = 安装）。

- **产品约定**：启动后延迟 8s **静默检查**（`scheduleSilentCheck`）→ 发现新版**后台自动下载**
  （`autoDownload = true`）→ 下完由 `UpdateNotifier` 弹**一次**通知问要不要重启安装。
  `allowPrerelease = false`（**不推 beta**）、`allowDowngrade = false`、`autoInstallOnAppQuit = false`
  （装 = 重启，必须用户点头）。
- ⚠️ **必须 `app.isPackaged` 守卫**：开发态没有 `app-update.yml`，`checkForUpdates()` 只会抛
  「Skip checkForUpdates because application is not packed」。非打包态 `supported: false`，
  界面据此把入口说明成「开发版本不支持检查更新」。
- ⚠️ **`electron-updater` 是 CJS，本项目主进程产物是 ESM**：一律
  `import updaterPkg from 'electron-updater'` 再解构，**别写具名导入**（依赖 cjs-module-lexer 的
  静态分析，不保证解析得出 `exports.autoUpdater`）。
- ⚠️ **`autoUpdater` 是全局单例，事件只能订阅一份** —— 状态机与广播出口都在 `services/updater.ts`，
  `ipc/updater.ts` 只转发，别在别处再 `autoUpdater.on`。
- **失败只记日志、不弹窗**：断网 / GitHub 限流 / 没发布过都是常态，记进主机日志的**新作用域 `app`**
  （`HostLogScope` 加了 `'app'`，面板过滤项同步加了「应用」）。
- **装更新前先冲刷渲染端**：`updater:install` 走 `requestRendererFlush` 再 `quitAndInstall`，
  顺序反了会丢最后一次会话产出（与 `main/index.ts` 的 `before-quit` 同一套纪律）。
- **发版**：`package.json` 里 `repository` + `build.publish: [{ provider: 'github', owner, repo }]`；
  `electron-builder --publish always`（或带 `GH_TOKEN`）会把安装包与 `latest.yml` 挂到 Release。
  ⚠️ 顶层 `files` 白名单仍是唯一 matcher（见 6.2 第 9 条），**别在任何平台段加 `files`**。
- **验证**：开发态下探针断言 `updater:status` 通且 `supported: false`、点版本号给明确提示
  （不报错）；打包后真机验证要看 GitHub Release 是否产出 `latest.yml`。

---

## 五、验证工具链

### 5.1 隔离实例 + CDP（无 GUI 环境下的标准做法）

用户本机常驻着打包版 Dogi（单实例锁 + Windows 路径大小写不敏感会让 `electron .` 直接 `app.quit()`）。
**不要杀他的进程**，起一个隔离实例：

```bash
MSYS_NO_PATHCONV=1 node_modules/electron/dist/electron.exe . \
  --remote-debugging-port=9333 \
  --user-data-dir="C:/Users/<user>/AppData/Local/Temp/dogi-cdp" \
  --no-sandbox --in-process-gpu --disable-gpu-sandbox   # 必须 run_in_background 启动
```

- 只加 `--disable-gpu` 不够（GPU 起不来会 FATAL），要 `--in-process-gpu` + `--disable-gpu-sandbox`。
- ⚠️ **隔离实例的首次 `loadFile` 不会提交首帧**（实测：`window.__store` 已就绪、`document.body.innerText`
  是空的、`#root` 一个子节点都没有、控制台**没有任何报错**；窗口也是可见的）。
  只等 `window.__store` 就下断言会全部落空。探针里连上之后固定做两件事：
  `await cdp.bringToFront()` + `await cdp.send('Page.reload', { ignoreCache: true })`，
  再轮询界面元素出现（见 `verify-agent-acp-import.mjs` 的 `waitReady`）。
  用户的常驻实例与 `npm run dev` 都不受影响，这是探针环境的特性。
- ⚠️ **CDP 探针里写正则一定要 `\\s`**（模板字面量会把 `\s` 吃成 `s`，见 6.5 第 20 条）——
  `verify-agent-acp-import.mjs` 里按按钮文案匹配（antd 会给两个汉字的按钮插空格）就是踩这个。
- 取调试目标**别用 curl**（本机走代理会回 `upstream connect failed`），用 Node 自带 `fetch`。
- 连 CDP 用 `scripts/lib/cdp.mjs`（Node 22 自带 WebSocket，零依赖）：
  `connect()` → `eval()` / `reload()` / `bringToFront()` / `screenshot()` / `report(checks)`。
- **发按键前必须 `bringToFront()`**（`Page.bringToFront` + `Emulation.setFocusEmulationEnabled`），
  否则 reload 之后 keydown 根本不派发。
- ⚠️ **终端上的滚轮必须用 CDP 真事件**（`Input.dispatchMouseEvent` + `type: 'mouseWheel'`，坐标取元素中心）：
  往 `.xterm-viewport` 上 `dispatchEvent(new WheelEvent(...))` **滚不动** —— xterm v6 的 wheel 监听挂在
  `.xterm-scrollable-element` 里的屏幕元素上，而从 viewport 派发的事件是**向下**传播、到不了监听点。
  实测踩过：回放明明生效（真滚轮能一路滚到会话第一行），合成滚轮却永远停在当前屏幕顶，
  看起来像「修复没起作用」，白查一轮。**断言「历史还在」之前，先确认真事件能滚。**
- **造数据直接 `window.__store.setState(...)`**，别点一串 UI 绕到目标页面；
  切功能区用 `ui: { ...s.ui, activeActivity: 'agent' }`，写完 `sleep(900)` 给 React 一帧。
- **改渲染端后**：`npx vite build --outDir <临时目录>` + `cp -rf` 回 `out/renderer` + `Page.reload`，
  不必重启 Electron。
- **截图要自己 Read 一遍再下结论**：断言只能证明结构，配色 / 对齐 / 图标位置得靠眼睛。
  强制主题：`Emulation.setEmulatedMedia({ features: [{ name: 'prefers-color-scheme', value: 'light' }] })`。

### 5.2 现有验证脚本

| 脚本 | 覆盖 |
| --- | --- |
| `scripts/verify-agent-browser.mjs` | Agent 内嵌浏览器面板：工作区/会话准备 → 点工具栏浏览器按钮 → 面板出现且拿到帧（**验证会话 id 契约**）→ 收起面板不关会话 |
| `scripts/verify-agent-browser-tools.mjs` | Agent 浏览器工具行为：**直接跑 `services/browser/agent.ts` 真源码**（本地假站点），覆盖 navigate → ref 点击 → evaluate 验状态 → 中文输入 → press → wait_for → 截图落盘 → close → 关闭后能重建 |
| `scripts/verify-browser-persistent-profile.mjs` | 浏览器会话持久化 profile：**直接跑 `services/browser/session.ts` 真源码**（本地假站点发持久 cookie）—— 登录态（cookie + localStorage）跨会话重启存活、关会话不删 profile 目录、`purge` 连目录一起清、未注入 profilesRoot 回退临时上下文且不落盘 |
| `scripts/verify-builtin-playwright-mcp.mjs` | 内置 Playwright MCP（`browserToolMode: system` 用的那个）stdio 冒烟：真实子进程跑 CLI —— initialize → tools/list → **真实 browser_navigate**（headless Edge 打开页面）→ browser_snapshot 看到内容。防的是 overrides 强制 mcp 用顶层 playwright 1.63 稳定版后，某次升级 mcp 引入了 1.64+ 才有的 API |
| `scripts/verify-tool-registry.mjs` | 工具注册表与客户端工具（`tool-registry.ts` + `client-tools.ts` 真源码，不起 Electron）—— 同名重复注册抛错、`names()`、`scope` 过滤、`available` 谓词（MCP 带 browser_* 时让位）、MCP 覆盖内置、描述函数按 ctx 现算、**随请求携带的客户端工具进工具集且与内置同名时让位**、confirm 模式下主进程**不**请示（权限在渲染端）、broker 的广播载荷 / 回填 / 执行失败 / `cancel(requestId)` / 通道未就绪 |
| `scripts/verify-terminal-chat.mjs` | 终端助手并入统一引擎的全链路（隔离实例 + CDP + **进程内 mock LLM**：OpenAI 兼容 SSE，按脚本逐次应答并记录每次请求的工具清单）—— `scope:'terminal'` 工具集含 `run_in_terminal` 且不含工作区工具、客户端工具随请求上报并在**同一请求内**回填续跑、full 不弹确认框 / confirm 由**渲染端**弹框且拒绝对模型是正常结果、`run_in_terminal` 真写进 PTY、终端会话落 `terminal-conversations/` 且不进 agent 列表、草稿转正 / 左侧列表 / 逐条删除 / **面板里没有「清空历史」**、重启后仍在、客户端工具注册表重启后为空、**超长输出落产物**（第 3b 节，见 4.24：`run_in_terminal` 跑 3000 行 → 结果给出产物 id 与精确的下一次读取参数、开头结尾保留在中段之外、再发一轮 `read_tool_output({id, offset, length})` 把中段读回来且读取头给出下一个 offset）。需先 `npm run build`。⚠️ 第 3b 节的命令是**终端 PowerShell 的原生命令**，别再套 `powershell -Command "…"`：双引号里 `$_` 被外层先展开、单引号里的 `"` 又在组装原生参数行时被剥掉，两层壳各吃掉一层引号（两种写法都产不出内容，报错信息长得像工具坏了）；断言产物 id 也要注意 `inlineText` 是 **JSON 字符串**（引号长成 `\"`，正则两边都得容错） |
| `scripts/verify-output-artifact.mjs` | 工具输出的「产物」机制（`services/ai/output-artifact.ts` 真源码，`.artifacttest` 包装跑，**不需要 Electron**，见 4.24）—— 短输出**不建文件**、超限落盘且文本里带 id / 总量 / 续读指引、内联的滚动结尾**确实是真正的末尾**（用 `MIDDLE_UNIQUE_MARK` 哨兵区分头尾中）、**第一块就超内联上限时开头照样填**、按 offset 分段读能逐字拼回全文、`AnsiStripper` 跨块不吞半截转义序列（CSI / OSC 都被劈开过）、非法 id（含 `../`、绝对路径、Windows 保留名）一律拒绝、4MB 上限标 `truncated`、`purgeArtifacts` 只删本会话、**回归：>256KB 输出不再变成空串** |
| `scripts/verify-agent-posix-command.mjs` | Agent `execute_command` 的 Windows POSIX 执行环境（`agent-core/tools.ts` 真源码，**按 `buildWorkspaceToolDefs()` + 假 ctx** 调用，见 4.23 的静态定义 API）：注入 Git Bash 后 `ls` / 管道 + 通配 / `grep -n` / for 循环 / `$HOME` 按 POSIX 语义工作；不注入时回退 PowerShell 且仍可执行；工具描述如实声明环境。⚠️ 复制清单里有 `output-artifact.ts`（`execute_command` 现在用它落盘，见 4.24）—— 删掉那一行会 `ERR_MODULE_NOT_FOUND`；需 `DOGI_TEST_BASH=<bash.exe>` 指定 Git Bash，**不指定时 POSIX 用例会失败**（回退 PowerShell 跑 `ls` 只能得到报错，属环境问题不是回归） |
| `scripts/verify-agent-status.mjs` | 会话列表三态图标 + 系统通知三条路径（前台挡下 / 开关关闭 / 最小化后真发出 —— **会真的弹一条通知**） |
| `scripts/verify-agent-edit-match.ts` | edit_file 匹配引擎（`agent-core/edit-match.ts`，`node --experimental-strip-types` 直接跑）—— 精确替换、找不到 / 多处 / oldString===newString 的报错、replaceAll、9 级模糊匹配链逐个触发（行 trim / 块锚点 Levenshtein / 空白归一 / 缩进弹性 / 转义归一 / 边界 trim / 上下文感知）、转义还原撑大匹配被拒、CRLF 辅助函数（换行符归一是 Windows 下编辑 CRLF 文件的前提） |
| `scripts/verify-agent-file-tools.mjs` | Agent 文件工具行为（`tools.ts` 真源码 + 真临时工作区，包装机制同 posix-command）—— read_file 大文件分段读取（旧实现 >20 万字符连 offset/limit 都抛错的回归）、单行截断、续读 offset 提示、相似文件建议、目录 / 二进制指引；**先读后改**（edit / 覆盖写前必须本会话 read_file 过，外部改动后要求重读，写入也记快照）；edit_file 多处命中不猜 / replaceAll / **CRLF 文件用 LF 的 oldString 编辑且保留 CRLF** / 缩进不一致仍命中；确认模式 guardWrite 拒绝与放行。⚠️ 复制清单里同样有 `output-artifact.ts`（见上一行） |
| `scripts/verify-agent-file-preview.mjs` | `dogi-ws://` 图片解码、SVG 预览↔编辑、`<video>` 的 206 Range、压缩包提示、`../` 越界 |
| `scripts/verify-agent-list-projection.ts` | 会话列表投影的结构共享（`features/agent/conversation-list-meta.ts` 真源码，`node --experimental-strip-types`，**不需要 Electron**）—— 500 次流式增量后投影数组与条目对象**引用不变**（= 不重渲染）、会话内容确实在变（防「修成不更新」）、改名 / `updatedAt` 变化 / 草稿转正 / ACP 绑定回填 / 删除 / 顺序变化才换引用 |
| `scripts/verify-agent-outline-scroll-cost.mjs` | 消息流滚动的每帧开销（隔离实例 + CDP，先 `npm run build`）：页内**打桩计数** `getBoundingClientRect` / `querySelector`，造 50 / 300 轮提问各滚 30 帧 —— 每帧布局读取必须是**对数级**（实测比值 1.34，线性会是 6）、`querySelector` 不再逐条（每帧 1 次而不是几百次）。修复前那段线性扫在 1200 个消息元素上是**每帧 621 次** |
| `scripts/verify-agent-error-parts.mjs` | 错误文案 part 的追加语义（`stores/agent-helpers.ts` 真源码，只桩掉 `app-store` / `types` 两条 import）—— 同一轮连着多个 `error` 事件（模型级重试每次尝试失败都发一个）**只留最后一条**、错误文案之后的正文增量另起一段、正文不会被接在 `⚠️ …` 后面；Agent 会话与终端 AI 助手两条路径都验 |
| `scripts/verify-quick-actions.mjs` | `.dogi/workspace.json` 自动建目录、脏数据降级、下拉入口与顶栏同排、执行命令开终端、弹窗开关 |
| `scripts/verify-host-logs.mjs` | 主机日志全链路：隔离实例 + 进程内 ssh2 测试服务器 —— SSH 四类来源标签与实时推送（`logs:entry`）、TOFU 指纹、隧道强断（error 级）/ 改名重启 / 停止、SFTP 失败路径、JSONL 落盘与清空归零、面板单例标签 / 过滤 / 搜索 |
| `scripts/verify-windows-host.mjs` | Windows 主机支持全链路：三台进程内 ssh2 假服务器（Windows / GBK / Linux）—— `cmd /c ver` 平台探测、Windows 会话 0 条 `monitor:data` + `monitor:unsupported(windows)` + 徽标「不支持监控」、GBK 输出 xterm 渲染与输入字节=GBK 编码比对、Linux UTF-8 透传 + `monitor:data` 回归 |
| `scripts/verify-rdp-bridge.mjs` | RDP 本地桥：假 RDP 服务器（X.224 确认 + STARTTLS 升级 + 回显）—— RDCleanPath 应答同构（3390 / X.224 / 证书链 / server_addr）、WS↔TLS 透传字节一致、脏数据与 destination 不匹配回错误 PDU 且不触碰目标、错误 token 连不上、open 幂等 / 目标 host:port 取自主机配置 / 非法端口兜底 3389 / ssh 类型主机被拒 / `rdp:credentials` 与桥端口同口径 / close 后端口关闭 / `rdp:wasm` 魔数 / **坏 keyUsage 证书降级**（第二台假服务器：默认握手被拒后自动重试 TLS 1.2 静态 RSA 成功、对端恰两次连接、主机日志告警与成功留痕） |
| `scripts/verify-rdp-host-ui.mjs` | 远程桌面主机类型界面链路（隔离实例 + CDP）：新建对话框三分段（默认 SSH → 切「远程桌面」出 rdp 字段、端口 3389 与用户名 administrator 同步预填）→ 保存落库（kind=rdp / 域 / 加密密码）→ 主机菜单无「远程桌面 (RDP)」直达、rdp 无 SFTP / 隧道项 → 编辑对话框类型可切换与回填 → 「连接」开 `rdp-<id>` 标签且不建终端会话 → 读配置开桥自动连接（无真实服务器 → 进入断开态）→ 无密码主机弹凭据对话框、勾选保存把凭据写回配置、rdp 弹窗 footer 按钮贴右缘（防 flex 布局回归）。⚠️ 目标端口无真实 RDP 服务，断言的是流程不是画面 |
| `scripts/verify-sftp-transfers.mjs` | SFTP 上传文件夹 + 传输托盘：进程内假 SFTP 服务器（ssh2 服务端事件式 API，见下方 ⚠️）——「上传 → 上传文件夹…」逐层 MKDIR + 每文件 WRITE（内容比对）、3 笔独立传输落 store（含 `localPath`）、完成条目 6.5s 后仍在（不自动移除）、上传 / 下载带「打开文件位置」/ 已取消不带、`revealPath` 错误路径 `ok:false`、清除已完成清空且入口消失。⚠️ 会真实弹出一次系统文件管理器 |
| `scripts/verify-port-killer.mjs` | 端口占用插件全链路：插件播种/视图注册 → 探针 spawn 的 node 子进程真占随机端口 → 查询命中（PID / 进程名 / 监听中）→ 行内复制命令（`killCommand` 平台格式）→ **Popconfirm 真杀**（子进程退出 + 端口连接被拒 + 自动复查为空）→ 保护/校验分支（kill PID 1 / 非法 / 不存在、search 70000）→ **UDP 占用**（netstat UDP 行没有状态列）→ 重新查询 |
| `scripts/verify-terminal-logging.mjs` | 终端命令 + 输出记录：命令装配（普通 / 退格 / Ctrl+C / 不可还原行不记 / bracketed paste）、`[脚本]` 来源标记、输出增量回填同一条目、原始会话文件（含未记录命令的裸输出）、关闭条目、JSONL 同 seq 多行、面板终端过滤、清空连 `sessions/` 归零。⚠️ bracketed paste 用例必须放最后：部分 PowerShell（如本机 5.1）未启用 `?2004h`，合成标记会吞掉后续回显 |
| `scripts/verify-terminal-prediction.mjs` | 终端命令预测：CDP 真键盘注入（先点终端给 xterm 焦点）——未输入无下拉、「键入 git → 'git status' 行渲染宽度带空格」、「前缀以空格结尾 → 仍带空格」、`→` 接受 → 下拉收起 + PTY 回显补全后的 `git log`、备用屏幕（tmux / vim）里按 `d` 不弹（见 6.5 第 25 条）。⚠️ 防的是 flex 子项边界空格被裁的坑（见 6.5 第 24 条）：断言必须量渲染宽度，`textContent` 测不出来 |
| `scripts/verify-terminal-replay.mjs` | 终端标签换父节点后回放环形缓冲（机制见 4.1）：本地终端灌 60 行 → 拆分**前**能滚到会话第一行（对照组）→ `splitTabToGroup` 分屏后仍能滚到第一行、当前屏幕仍是最新输出 → 拆分后再打哨兵只见一次（**接缝不重复**，证明「先订阅、再取缓冲」的顺序对）且新输出照常到达 → `moveTabToGroup` 跨组并入同样能滚回第一行。⚠️ 滚轮必须用 CDP `Input.dispatchMouseEvent`（见 5.1 的真事件那条），用合成 `WheelEvent` 会误判成回归 |
| `scripts/verify-command-history.ts` | 终端命令历史的服务层（`services/terminal/history.ts` 真源码，`node --experimental-strip-types`，不需要 Electron）—— 空启动、add 落盘、去重置顶（重复执行刷新时间）、trim / 空串拒绝、超长截断、上限 1000 丢最旧、「重启」再 init 读回一致、单条删除（不存在静默）、清空归零、损坏 / 非数组 / 坏条目文件逐条校验降级。⚠️ 落盘是异步链，断言文件内容前必须 `flush()` |
| `scripts/verify-command-history-ui.mjs` | 命令历史的界面链路（隔离实例 + CDP，先 `npm run build`）：真实键盘在终端执行命令 → 回车记入全局 store → **第二个终端标签**的预测下拉出现跨标签历史 → 设置 → 终端管理卡片（条数 / 搜索过滤 / 最新在前 / 行内删除 / Popconfirm 清空）→ 再真实记录一条 → 杀进程重启 → bootstrap 灌回且已删除条目不再出现。⚠️ Modal 底部的版本号 `v0.0.12` 也是 `font-mono`，行断言要选 `span.font-mono[title]`（管理行才有 title）；antd 两字按钮按去空白 textContent 匹配 |
| `tmp/verify-terminal-drop-upload.mjs` | 终端拖拽上传（SFTP）：进程内假 sshd（pty + shell + SFTP 子系统，REALPATH 固定回家目录）+ 隔离实例，`Input.dispatchDragEvent` 注入**真实原生拖拽**（`data.files` 传绝对路径 → `webUtils.getPathForFile` 拿得到）——拖入文件 + 子目录 → 确认条默认 = 家目录 → 改目录上传 → 远端逐层 MKDIR + 每文件 WRITE 内容逐字节一致、终端「已上传 N 项到 …」、传输托盘 2 笔 done → 再次拖入默认目录被记住 → 本地会话拖入被拒且不建连不传文件。⚠️ CDP 对终端 DOM 刚挂载后的**首次** drop 可能整串被忽略（非代码问题），探针带最多 3 次真实重试 |
| `tmp/verify-tab-close-confirm.mjs` | 标签关闭确认（页面内确认 + emit 关闭，机制见 6.5 第 32 条）：隔离实例 + CDP，`createLocalSession` 开真实本地终端 + `openNoteTab` 开真实笔记（Milkdown 编辑器 `execCommand('insertText')` 输入变脏）—— 通用防手滑确认出现在**可见标签面板内**（`[role=dialog]` 且 `offsetParent` 非空、根节点挂在 `relative` 容器、遮罩非全窗宽）→ 取消不动 / 关闭生效 → 勾「以后都不再提示」落盘 `confirmCloseTab` → 偏好关闭后直接关 → `requestCloseGroup` 逐个确认（自动激活下一个标签）、取消即中止整批 → 笔记**开关开**弹「未保存三选一」（不保存 = 丢弃且文件不动）、**开关关**不问直接丢弃关闭。⚠️ **`cdp.eval` 是 `awaitPromise:true`：`requestClosePanelTab` / `requestCloseGroup` / `createLocalSession` 这类返回 Promise 的动作必须 `void` 掉再 eval，否则 eval 会等到用户点按钮才返回（探针第一次跑就是这样死锁超时的）**；⚠️ antd 给两个汉字按钮插空格，「取消 / 关闭」要按去空白后的 `textContent` 匹配（同 6.5 第 20 条） |
| `scripts/verify-git-changes.ts` | 源代码管理「更改」列表的数据层：**直接跑 `services/git.ts` 真源码**（`node --experimental-strip-types`，不需要打包 / 不起 Electron）—— 临时仓库里验证未跟踪目录被 `-uall` 摊平成目录下的每个文件、列表里没有「以 `/` 结尾的折叠目录」条目、未跟踪文件用 `--no-index` 拿到「整份新增」的 diff、已跟踪文件的 diff 不受影响、未跟踪的**嵌套仓库**输出成带尾斜杠的目录条目（`nested/`，取 diff 返回空）、回退能**递归**删掉整个目录、`listGitDir` 能列出目录条目里的文件（跳过 `.git`，只读展示）且**预览上限 20 项** |
| `scripts/verify-git-tree.ts` | 源代码管理列表的折树纯函数（`features/agent/git-tree.ts`，`node --experimental-strip-types` 直接跑）—— 多级 / 中文目录名取**路径末段**且非空、不含问号，根目录文件显示文件名，同一目录的多个文件合并成一个节点，完整路径留在 `path`（tooltip 用），重命名按新路径折树且 `origPath` 仍可读，git 的**目录条目**（`nested/`，尾斜杠）取到末段名而不是空串、目录节点带上其下**全部变更路径**（整目录暂存 / 回退用） |
| `scripts/verify-acp-fs.ts` | ACP 客户端文件访问（`services/ai/acp-fs.ts`，`node --experimental-strip-types`）—— 工作区内读写（相对 / 绝对路径、父目录自动创建、覆盖写）、`line` / `limit` 按行截取、越界一律拒绝（`../`、工作区外绝对路径、工作区根、前缀相同的兄弟目录、`sub/../../`） |
| `scripts/verify-acp-history.ts` | ACP 历史回放装配（`services/ai/acp-history.ts` + `src/shared/acp-tools.ts`，复制到 `.acphistorytest/` 后 `node --experimental-strip-types` 跑真源码）—— 按 `messageId` 分段、**工具结果回到调用所在的那条消息**（回放里夹着下一条消息正文的场景，见 6.6 第 34 条）、无 messageId 的启发式（**多轮糊成一条是刻意降级**，见 `pushTool` 的注释）、进行中的 `tool_call_update` 不落结果卡、孤儿结果不丢、思考块成 reasoning、空消息丢弃 |
| `scripts/verify-agent-conversation-model.mjs` | Agent 会话「形态 / 模型选择」的持久化：**真启动两次应用**（同一 `--user-data-dir`）—— 保存带 `modelId` 读得回、不带 `modelId` 再存时保留旧值（`in` 语义）、显式 `undefined` 才清空、重启后 `kind` / `modelId` / `configId` 仍在；**ACP 会话**的 `acpAgentId` / `acpSessionId` 落盘、不带 `kind` 再存时绑定保留、**消息恒为空**（哪怕传了消息） |
| `scripts/verify-agent-acp-import.mjs` | AI Agent 侧边栏 + ACP 会话「登记 → 新建/导入 → 回放」的界面链路（隔离实例 + CDP，见 4.3 / 4.18）：工作区行尾只有一个「更多操作」下拉（导入 / 新建会话 / 重命名 / 删除）→ **「新建会话」是草稿**：`kind` 为 undefined、**不进侧边栏列表**、页面上写明「发出第一条消息才建会话」、同一工作区连点两次是同一个空页 → 选内置模型只写草稿 → 发首条消息转正（标题取那条消息、`mastra`、进列表）→ **导入弹窗只做 选 agent / 拉取会话 / 导入**（无检测 / 手动添加 / 新建会话按钮），无 agent 时提示、footer「ACP 设置」打开设置弹窗并定位到 ACP agent 分组、「拉取会话」对起不来的 agent 有反馈 → 用**真实路径**建 ACP 草稿（新建会话 + `setAcpConversationModel` 预置 agent）→ 模型下拉只列**设置里勾选的**模型、**宽度被限死** → `history` 事件渲染成消息流、**正文不被折进折叠条**（注入 `[思考, 工具, 正文, 工具, 工具]`：正文在折叠体**外面**、纯工具轮次无复制按钮，见 6.6 第 34 条）、ACP 没有「编辑重发」入口 → ACP 草稿发首条消息转正（`acp` + 绑定带上、消息不落盘、进列表）、无草稿残留 → **标签右键菜单**：一级只有「关闭标签」，其余关闭方式收进「关闭」二级。⚠️ 断言列表行数要用 `[data-conversation-id]`（store 条数含草稿）；模型下拉要取**可见标签**里那个（每个标签各渲染一份，隐藏的那份选项按它自己的会话算，会是「暂无数据」）；**悬停展开 antd 子菜单**：真鼠标移动推不出 React 的 `onMouseEnter`，要对标题元素派发**带 `relatedTarget` 的 mouseover**；子菜单弹出层类名是 `.ant-dropdown-menu-submenu-popup`（不是老的 submenu-popup）；合成 contextmenu 没有 clientX/Y，右键要用 `Input.dispatchMouseEvent` 真事件（菜单弹在 (0,0) 会让后续坐标全错）；见 5.1 的「隔离实例首帧不提交」坑（探针里要先 `bringToFront` + `reload`） |
| `scripts/verify-skills.mjs` | 技能发现（含 junction 安装）、无 frontmatter 退化、额外根目录、设置页渲染与开关落盘 |
| `scripts/verify-context-compression.mjs` | 上下文压缩与会话累计（见 4.20）：`.tooltest` 包装直接跑 `services/ai/context.ts` 与 `@shared/agent-usage` **真源码** —— `estimateTokens` 口径、未超预算**零拷贝**、空历史、单轮超预算不压缩、摘要失败回退截断（含 `truncated` 标记与占位说明）、保留比例决定留几轮、非法预算回退默认值；累计 token 累加 / `totalTokens` 不反推 / 缺字段不产生 NaN。⚠️ 摘要失败用例靠**指向本机没人监听的端口**（`127.0.0.1:1`）触发，不碰外网 |
| `scripts/check-missing-color-utils.mjs` | 扫描产物 CSS，找出「语义色令牌漏映射导致整族工具类没生成」 |
| `scripts/shot-titlebar.mjs` | 强制 hover 截图 + 计算样式，查标题栏配色 |
| `scripts/browser-input.test.ts` | 浏览器面板的坐标映射纯函数（`object-contain` 留白 / 画面矩形 / 黑边丢点 / 滚轮）。**能直接跑**：`node --experimental-strip-types scripts/browser-input.test.ts`（被测文件只有 type-only import，不需要 `.tooltest` 包装） |
| `scripts/verify-api-body-types.mjs` | 接口请求的请求体四形态（见 4.19）：**直接跑 `services/api/http.ts` 与渲染端 `api-client.ts` 真源码** + 进程内真 HTTP 服务器 —— `none` 不带 body 且 Content-Type 原样不动、urlencoded 序列化（中文 / 空格 / & / 空键跳过）与「没填 Content-Type 才自动补」、显式 charset 不动、form-data 的 boundary / 文件名 / 文件 MIME / **文件字节逐字节一致**（文本 + 含 0x00 的二进制）、请求头里那份没 boundary 的 Content-Type 被丢掉、文件没选或路径不存在 → status 0 且**不发包**、raw 原样透传（回归）、GET/HEAD 不带 body、不就地改调用方 headers；渲染端纯函数（标准 Content-Type 表含 none/raw 为 null、表单空槽位整理、`setContentType` 覆盖/新增、路径取文件名、cURL `-F` 含 `@文件` 与 `-d` 回归） |
| `scripts/verify-api-body-ui.mjs` | 接口请求请求体四形态的**界面链路**（隔离实例 + CDP，先 `npm run build`）：草稿默认 raw → 切 x-www-form-urlencoded（表格出现、请求头自动补 Content-Type）→ 填表发送 → 服务器收到标准序列化正文 → 切 form-data（「类型」列**在值这一列前面**，DOM 顺序断言）→ 一行改「文件」并**真的选本地文件**（`DOGI_API_PICK_FILE` 旁路，见下）→ 发送后 multipart 文本字段与**文件字节一致**、响应 200 → Ctrl+S 落盘（`bodyType` / 两张表单 / 文件路径 / 历史都带上）→ 换成真实标签后重新载入仍是 form-data 且字段回填 → 切回 raw 时 Content-Type 换成 application/json → 切 `none` 时编辑器与表单都让位、发送后服务器**零字节 body** 且 Content-Type 保持不变。截图落 `tmp/api-body-*.png`。⚠️ 横向分段（Segmented）要读 / 点里面 radio 的 input，不能点 label（同 verify-rdp-host-ui） |

⚠️ 这些脚本**都在自己的临时 `--user-data-dir` 里跑**，跑完会 `fs.rm` 掉它 ——
不清的话上一次留下的会话会累积，store 里的「当前会话」未必是本次建的那个，断言会漂到别的会话上。

⚠️ **假 SFTP 服务器（`verify-sftp-transfers.mjs`）必须用 ssh2 服务端的事件式 API**：
`session.on('sftp')` 的 `accept()` 返回的是**已就绪的 SFTP 协议实例**（不是裸 Channel）——
它自己完成 INIT/VERSION 握手、按请求类型发事件（`OPENDIR` / `READDIR` / `OPEN` / `WRITE` / `CLOSE` /
`STAT` / `LSTAT` / `MKDIR` / `REALPATH` / …），**没有监听者的类型会被自动回 `OP_UNSUPPORTED`**
（现象就是「`sftp:list` 失败：Operation unsupported」），它也**从不发 `'data'` 事件**（自己解析字节流是死路）。
响应一律用实例方法：`status(reqID, code)` / `handle(reqID, Buffer)` / `attrs(reqID, { mode, size, atime, mtime })` /
`name(reqID, { filename, longname, attrs })`；READDIR 读完要发 `status(reqID, 1)`（EOF）；
`OPEN` 的 pflags 里 `0x02` 是 WRITE（只有写句柄在 CLOSE 时落盘）；句柄自建 4 字节 uint32 编号。
主进程侧对应的旁路契约：原生目录选择框无法自动化，`sftp:uploadDir` 读 `DOGI_SFTP_UPLOAD_DIR`
环境变量（**仅探针设置**，正常运行不设就走真对话框；新增「弹原生对话框」的能力照此留旁路）。

⚠️ **假 RDP 服务器（`verify-rdp-bridge.mjs`）的 STARTTLS 升级**：先按 TPKT 长度读齐 X.224 连接请求、
回确认，然后 `socket.pause()` 再把裸 socket 交给 `tls.createServer(...)` 实例 `emit('connection', socket)`
完成服务端 TLS 握手（tls.Server 的 STARTTLS 标准做法）。证书用脚本内嵌的一次性自签固件（仅 127.0.0.1
回环）即可 —— 桥端本就是 `rejectUnauthorized: false`（RDCleanPath 设计：证书链回传给 WASM 客户端判定），
探针只断言「链完整 / 字段对」。坏 keyUsage 的第二台假服务器（29390）沿用同一 STARTTLS 骨架，只换证书固件（keyUsage 仅 `keyEncipherment`）与服务端套件（只留 RSA 密钥交换）—— 专门复现 BoringSSL 的 `KEY_USAGE_BIT_INCORRECT` 与桥的降级重试（见 6.4 第 17 条）。

⚠️ **本地回环 WebSocket 拨号偶发失败**：Windows 负载中极少数情况下，对刚建好的桥的首条 WS 连接会直接
`onerror`（重跑即过，与桥实现无关 —— 已实测复现一次、重跑两次全绿）。探针的 `wsOpen` 为此带 2 次退避重试；
负路径（`expectWsFail`）传 `0` 不重试，保持「单次拨不通 = 连不上」的断言语义。再遇到同类失败先怀疑它，
别急着改桥代码。

⚠️ `verify-port-killer.mjs` 里「被占用的端口」都是**探针自己 spawn 的 node 子进程**（TCP 监听 / UDP 绑定）：
结束时杀的是这个子进程，能拿准退出码、且伤不到任何真实服务 —— **永远不要拿宿主或系统进程当靶子**。
「权限不足 → 弹管理员命令弹窗」分支需要真实高权限进程才能触发（如 SYSTEM 进程），自动化里不制造，
只覆盖命令生成（`killCommand`）与受保护 PID（kill PID 1）分支。

⚠️ 跑浏览器相关脚本时，**DOM 里可能同时存在多个 `alt="浏览器画面"` 的 `<img>`**（历史遗留的隐藏面板）。
按 `querySelectorAll` 取第一个会命中隐藏的那个（rect 为 0），断言全落空 ——
取 img 时要挑 rect 非零的那个。

⚠️ 定位 Agent 顶栏按钮**别按图标类名找**：活动栏的「接口请求」用的也是 `lucide-globe`，
所以那个按钮带 `aria-label="浏览器"`，脚本按它精确定位。

⚠️ `scripts/agent-browser-tools.test.ts` **不能直接 `node` 跑**（无扩展名的相对 import +
`@shared/*` 别名，`--experimental-strip-types` 认不了），要跑包装脚本
`scripts/verify-agent-browser-tools.mjs` —— 它把真源码复制到 `.tooltest/` 只改写 import 说明符，
跑完删掉。见 skill「node-run-ts-without-build」。

⚠️ 「等某条日志出现」要防命中旧记录：同名文案（如隧道「已启动」）重启后会第二次产生，`find` 会立刻
命中旧条 —— 先轮询运行态（`window.__store` 里的 `tunnelRuntime` 等）回到目标值，再等日志。

⚠️ 历史脚本（`verify-agent-msglist` / `verify-agent-scroll-edit` / `verify-agent-aipanel` /
`verify-acp-e2e` / `verify-acp-confirm` / `probe-reasoning` 等）**已不在本仓库**，
本文档里引用它们的地方是保留当时的方法论，不是「去跑它」。

**其他探针**（不起 Electron，直接 `node scripts/xxx.mjs`）：

| 探针 | 回答的问题 |
| --- | --- |
| `scripts/probe-mastra-error-chunks.mjs` | 模型请求失败时 mastra `fullStream` 到底吐几个 `error` chunk —— 用于验证「错误文案为什么堆了多段」的归因（**升级 mastra 后必重跑**，见 6.6 第 30 条） |

**浏览器相关的探针**（不起 Electron，直接 `node scripts/xxx.mjs`；**升级 Playwright 时重跑这几个**）：

| 探针 | 回答的问题 |
| --- | --- |
| `scripts/probe-playwright-screencast.mjs` | screencast 抓帧 + CDP 合成鼠标 / 键盘是否可用 |
| `scripts/probe-playwright-recorder.mjs` | `recorderMode: 'api'` 是否不弹 Inspector、事件流是否给出官方选择器代码 |
| `scripts/probe-aria-ref.mjs` | `ariaSnapshot({ mode: 'ai' })` 是否产出 `[ref=eN]`、`aria-ref=eN` 能否回解析并点击 |

### 5.3 Tailwind 类名必须去产物 CSS 里核对

- **任意透明度值实测不会被生成**：`bg-foreground/[0.04]` 这类写法静默失效 —— 界面上毫无变化，构建也不报错。
- **语义色令牌少一个映射，整族工具类静默消失**：`@theme inline` 里没有 `--color-X: var(--X)` 时，
  `text-X` / `bg-X` 整族都不会生成（实例：`--color-destructive-foreground` 缺失 → 关闭按钮 hover「红底 + 灰字」）。
  用 `node scripts/check-missing-color-utils.mjs` 全量扫描（构建后跑）。
- 类名在 CSS 里是**转义过的**（`.grid-rows-\[0fr\]`），grep 时 pattern 要跟着转义；
  `hover:` 变体类只有 `.hover\:text-x:hover`、没有裸 `.text-x`。

---

## 六、踩坑与硬约束

### 6.1 环境与原生依赖

**1. node-pty 是本地编译的原生模块**

- 需要 MSVC 工具链；本机具备编译条件，直接用官方 `node-pty`（若目标机缺编译环境，可回退 `@lydell/node-pty` 预编译包，只改 import 与依赖）。
- ⚠️ **Windows ConPTY 下 `pty.spawn()` 返回的 `pid` 恒为 0**，这不是错误 ——
  不要用 pid 判断进程存活，以 `onExit` 事件为准。

**2. npm 12 的 install-scripts 安全策略会静默跳过安装脚本**

- 现象：装完 `node_modules/electron/dist/electron.exe` 不存在、esbuild 报二进制缺失，npm 只给一行 `install-scripts blocked` 警告。
- 批准记录写在 `package.json` 的 `allowScripts` 字段。修：
  `npm install-scripts approve electron esbuild node-pty ssh2` 再 `npm rebuild`。
- 新装原生依赖后**务必检查产物是否存在**：`ls node_modules/electron/dist/electron.exe`、`ls node_modules/node-pty/build`。

**3. Electron 二进制下载要镜像**

- `TypeError: fetch failed` → `ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/" node node_modules/electron/install.js`，或写进 `.npmrc`。

**4. Git Bash 下 Windows 命令参数会被转义成路径**

- `taskkill /F /IM electron.exe` 会报「无效参数/选项 - 'F:/'」→ 写双斜杠 `taskkill //F //IM electron.exe`，或 `MSYS_NO_PATHCONV=1`。
- ⚠️ 反过来：**在 PowerShell 里必须用单斜杠**，双斜杠会静默失败，导致旧实例残留占用调试端口。

### 6.2 构建与 TypeScript

**5. Vite 8 不再通过 exports 暴露 `bin/vite.js`**

- `require.resolve('vite/bin/vite.js')` 抛 `ERR_PACKAGE_PATH_NOT_EXPORTED` →
  用 `fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url))` 直接拼路径（见 `scripts/dev.mjs`）。

**6. TypeScript 7 移除了 `baseUrl`**

- `error TS5102: Option 'baseUrl' has been removed` → paths 直接写相对 tsconfig 的路径（`"./src/shared/*"`），三个 tsconfig 均已如此。

**7. Agent 核心在主进程源码树里，不是 npm workspace 包**

- `src/main/services/ai/agent-core/`（工具集 / 系统提示词 / 事件适配 / 路径与忽略规则）原为 `@dogi/ai-agent`，
  因只有一个消费方已收回。仓库里**没有 workspace 包**，`vite.main.mts` 只有 `@shared` 一个 alias。
- `@shared` 之外一律相对路径（`./agent-core`）引用，**别再把这段逻辑拆出去**。
- ⚠️ `external` 判定必须放行**盘符绝对路径**（`/^[A-Za-z]:[\\/]/`）：相对导入被解析成 `D:/...` 后
  不以 `.`/`/` 开头，不放行就会被留成裸 import，运行时直接 `ERR_MODULE_NOT_FOUND`。
- ⚠️ 它仍与 Electron 解耦（只依赖 `ai` / `zod` / node 内置），所以能单独打包跑真代码做单测。

**8. 不要直接 `npx vite build`**

- 渲染端的 `emptyOutDir` 会**先删掉 `index.html` + `assets/` 再报错**，产物直接没了（safe-delete 保护）。
- 正确姿势：`npx vite build --outDir <临时目录>` 再 `cp -rf` 拷回去（复制不算删除）。

**9. electron-builder：平台级 `files` 会让顶层白名单整体失效（整个 `src/` 进安装包）**

- **触发信号**：安装包异常大 / 解包 asar 发现根目录有 `src`、`tmp`、`vite.*.mts`、`tsconfig*.json` 等非运行时内容
  （0.0.5 修复前实测：asar 372MB、安装包 185MB，其中 `src/` 占 100MB —— `src/renderer/public` 的
  monaco/vditor/rdp 与 `out/renderer` 下的拷贝完全重复）。
- **根因**（app-builder-lib 25.1.8 源码级实测）：`doMergeConfigs` 的 `normalizeFiles` 把字符串数组
  `files` 归一化成 `[{ filter: [...] }]` 对象形态 → 对象形态在 `getFileMatchers` 里生成**独立 matcher**，
  而平台级 `files`（win/mac/linux 段）的规则走 `defaultMatcher` 并被排到 **matchers[0]**；
  `getMainFileMatchers` 见 matchers[0] **只含负向规则**，按「用户只写排除项」的假设自动补 `**/*`
  全量基座 → 整个应用目录（除内置排除）都进包。顶层白名单是另一个 matcher，两者取并集，形同虚设。
  只要**任何一个平台段写了 `files`** 就触发；字符串形态 + 无平台级 files 时白名单才生效。
- **正确做法**：所有规则放**顶层 `files` 一个列表里**（单一 matcher，纯白名单语义），**任何平台段都不要再写
  `files`**。node-pty prebuilds 的平台差异合并时统一排除 `win32-arm64`（28MB，没人需要）即可；
  darwin（200KB）全平台带着、win32-x64（2.5MB）mac/linux 多带着，都无伤大雅 —— 别为省它们把规则拆回平台段。
  `out/{main,preload}-tmp` 是 vite 构建残留，同样在顶层 files 里排除。
- **验证**：`npx electron-builder --dir` 后解包 asar，根目录应**只有** `node_modules` / `out` /
  `package.json` / `plugins` 四项；0.0.5 修复后实测 win-unpacked 734MB→493MB、asar 372MB→131MB、
  安装包 185MB→**132MB**。若以后要恢复平台级 `files`，先解包确认 `src` 没有回来。

### 6.3 依赖 API 版本差异（升级时必看）

**9. AI SDK v7 / `@ai-sdk/openai` v4**

- `createOpenAI()` **已无 `compatibility` 选项**（v2/v3 有），兼容接口直接传 `baseURL`。
- ⚠️ **`provider(modelId)` 默认走 Responses API（`/v1/responses`）**，不是 chat/completions ——
  第三方兼容网关（Ollama / vLLM / one-api）普遍没实现而报 404。要 Chat Completions 必须显式 `provider.chat(modelId)`；
  本项目通过 `AiModelConfig.apiStyle` 切换，`openai-compatible` 默认 `chat-completions`。
- fullStream 字段：`text-delta` 是 `part.text`（v4 是 `textDelta`）、工具是 `input`/`output`（v4 是 `args`/`result`）。
  适配层是 `agent-core/mastra-stream.ts` 的事件适配（两条线共用同一份，见 4.22）。
- ⚠️ **思考内容的增量在 `part.text`**（不是 `textDelta`，也不是 `delta` —— 只有 `UIMessageChunk` 才用 `delta`）。
  `reasoning-start` / `reasoning-end` 只是起止标记、不带内容；**不存在 `type: 'reasoning'` 这种 fullStream part**，
  写错不会报错，思考内容会被静默丢弃。
- MCP 客户端已不在 `ai` 主包（`experimental_createMCPClient` 已移除），用官方 `@modelcontextprotocol/sdk`
  自行管理（`services/ai/mcp.ts`），工具用 `dynamicTool` + `jsonSchema` 包装。
- `streamText` 默认单步，自动工具循环需要 `stopWhen: stepCountIs(N)`。

**10. xterm 6 只有 DOM 渲染器；验证终端内容优先走 `recentOutput`**

- **实测纠正（6.0.0）**：core bundle 里只有 `DomRenderer` / `xterm-rows`，**没有任何 WebGL 代码路径**
  （唯一的 canvas 是装饰总览尺）；`.xterm-rows` 的 textContent 能读到文本 —— 旧记录「始终为空」已不成立
  （`scripts/verify-windows-host.mjs` 用 GBK / UTF-8 中文实测）。
- ⚠️ 但直读 DOM 仍有时机陷阱：`term.write` 异步解析、文本下一帧才落进 DOM，**刚写完就断言会读到空**（必须轮询）。
- **验证终端内容首选主进程 `recentOutput`**（IPC `terminal:recentOutput`）：不受渲染时机影响；DOM 读取只当补充，
  两处口径都要对（`verify-windows-host.mjs` 同时断言两者）。

**11. antd 6 的 Select 与 antd 5 差别很大**

- **`type: 'divider'` 在 Select options 里已不支持**（antd 5.10 的写法），会被当普通 option 渲染成空白行。
  需要分组用 `{ label: '组名', options: [...] }`。⚠️ **Dropdown 的 menu items 里 divider 仍受支持**，两者别混。
- **只支持一层分组**：`@rc-component/select` 的 `flattenOptions` 递归时子层一律按 option 处理，
  嵌套分组的内层会变成 `value: undefined` 的选项 —— 真实条目一个都不渲染，点它 `onChange` 拿到 `undefined`。
  从属关系写进 label（`配置名 · 模型id`）或拆成多个顶层分组；`onChange` 也要防御 `undefined`。
- **内部结构变了**：边框画在**根节点 `.ant-select`** 上（自带 `1px solid transparent`），内层是 `.ant-select-content`
  （`border-width: 0`）。**antd 5 的 `.ant-select-selector` 已经不存在** —— 照旧写法改它不报错也不生效。
- **`variant="borderless"` 的 Select「按下才多出的边框」其实是 `outline` 不是 `border`**：
  内层 `input` 命中 `:focus-visible`（鼠标点击同样命中）时 antd 给根节点补 `outline: 1px solid <activeBorderColor>`。
  消掉用 `.bare-select.ant-select { outline: none !important }`（项目已有这个工具类）。
- antd 的 cssinjs 是**非 `@layer` 样式**，优先级高于 Tailwind 的 `@layer utilities` ——
  覆盖 antd 内部样式必须写进 `index.css` 并带 `!important`，用 Tailwind 类名压不住。

**12. Playwright 1.63（浏览器，机制见 4.11）**

- ⚠️ **`headless: true` 默认走 `chromium-headless-shell`**（与完整 Chromium 是两个 build），
  它不保证提供 screencast，画面会是黑的 → 自带 Chromium 必须写 `channel: 'chromium'`。
- ⚠️ **`chromium.executablePath({ channel })` 忽略 channel 参数**（实测永远返回自带 Chromium 的路径），
  拿它判断系统浏览器装没装会得到错误答案 → 系统浏览器自己探安装路径。
- **自带 Chromium 未下载时 `launchAttempts` 会把它从候选里剔除**：Playwright 会抛
  「Executable doesn't exist」而不是自动跳过，留着只会多一次失败往返。
  本机 `~/AppData/Local/ms-playwright` 里缓存的版本号与 1.63 期望的（chromium-1243）**可能不匹配**，
  此时 auto 模式会回退到系统 Edge / Chrome —— 这是正常的，不是 bug。
- `locator.ariaSnapshot({ mode: 'ai' })` 与 `page.locator('aria-ref=eN')` 是**公开 API**，可以放心用。
- 安装时用 `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`（项目不依赖自带 Chromium，优先用系统浏览器）。
- ⚠️ **`@playwright/mcp` 官方钉的是 playwright alpha 版**（0.0.82 → `1.64.0-alpha-*`，历史上各版本全都跟
  alpha 走），与顶层 `playwright` 1.63 不同版 → npm 会装**两份 playwright 全家**（19MB）。项目用
  `overrides` 把它强制解析到顶层 1.63 稳定版。**实测 0.0.82 在 1.63.0 上完全可用**（alpha 钉版不是硬依赖；
  验证：`scripts/verify-builtin-playwright-mcp.mjs`，MCP stdio 握手 + 真实导航 + 快照）。
  ⚠️ npm 的 arborist 有坑：改/加 overrides 后嵌套副本**不会自动重装**（`npm ls` 显示 `invalid` 却照旧），
  要把 `node_modules/@playwright/mcp`、顶层 `playwright`/`playwright-core` 连同 package-lock 里对应
  `node_modules/...` 条目一起删掉再 `npm install` 才会重构。升级 mcp 版本后必须重跑冒烟探针。

**13. wasm-bindgen 的 init 在生产渲染端（file://）拿不到 URL 形式的 wasm**

- wasm-bindgen 胶水对 string / URL / Response 入参走 **`fetch()`**：dev（http://localhost）没问题，
  生产渲染端是 `loadFile`（`file://`），Chromium 的 fetch **不支持 file: 协议** —— 直接
  `init({ module_or_path: '/rdp/xxx.wasm' })` 会失败。`BufferSource`（字节）入参则直接实例化、不经过 fetch。
- 本项目的路子（`RdpPage.loadIronRdp`）：dev 走 `fetch('/rdp/rdp_client_bg.wasm')`（Vite 的 public），
  生产走 **`rdp:wasm` IPC 主进程 readFile 字节**再交给 `init`。配套两个 CSP 项：`script-src` 加
  `'wasm-unsafe-eval'`（否则 WASM 编译被 CSP 拦）、`connect-src` 放行 `ws://127.0.0.1:*`（RDP 本地桥）。
- wasm 资产由 `scripts/copy-rdp.cjs` 随 predev / prebuild 钩子复制进 `renderer/public/rdp/`。

### 6.4 主进程与生命周期

**12. `did-finish-load` 里 `setZoomFactor` 会让隐藏窗口永不显示**

- 现象：构建后（`electron .` 加载 `out/renderer`）进程在任务管理器里活着但窗口不出现；dev（`VITE_DEV_SERVER_URL`）一切正常。
- 根因：窗口是 `show: false` + `ready-to-show` 才 `show()`；`file://` + 隐藏窗口下，zoom 变更触发的重布局让首帧永不产出
  → `ready-to-show` 不触发。dev 走 `loadURL(http)`，有 HMR 等后续活动补触发首帧，掩盖了问题。
- 正确做法：zoom 复位只放在 ① 窗口创建后（loadFile 之前）；② `ready-to-show` 里 `show()` 之后；
  ③ `did-finish-load` 里**仅当 `mainWindow.isVisible()`** 时（reload 场景）。见 `main/index.ts`。
- 排查技巧：这种「进程在、无窗口」的问题主进程 stderr 往往完全干净 —— 给 main 加 `console.error` 打事件时序最快。

**13. spawn 外部 GUI 程序时 `windowsHide: true` 会隐藏窗口**

- `windowsHide: true` 会设 `STARTF_USESHOWWINDOW | SW_HIDE`，explorer.exe 等 GUI 程序**继承该标志**，
  spawn 成功但窗口被隐藏（无任何报错）。
- 正确做法：只用 `{ detached: true, stdio: 'ignore' }` + `unref()`。见 `services/system/opener.ts` 的 `launch`。

**14. zustand create 工厂内引用自身变量会 TDZ 崩溃**

- 在 `create()((set, get) => { … useAppStore … })` 里读 store 变量 → `ReferenceError`，整棵 React 树卸载。
- 需要在模块作用域暴露 store（如调试 `window.__store`）时，写在 `create(...)` 赋值语句**之后**。

**15. pty 输出早于渲染端订阅的丢失风险**

- 渲染端在 React mount 后才订阅 `terminal:data`，shell 启动横幅若早于订阅会丢（PowerShell 启动慢，实测未观察到；SSH 快速 banner 有此风险）。
- 如需彻底修复：挂载后先调 `terminal:recentOutput` 回放缓冲，再订阅实时事件。

**16. 其他主进程约束**

- **单实例锁**：**所有形态都生效**，任何时候只允许打开一个 Dogi —— 已有实例在跑时新进程直接退出，并把已有实例调到前台。锁由 Electron 按 userData 目录互斥。
  ⚠️ dev 与打包版的 userData **是同一个**（`%APPDATA%\dogi` —— package.json 没有顶层 `productName`，Electron 拿 `name` 当目录名），所以常驻打包版在跑时直接 `electron .` 会被锁挡下 `app.quit()`。**不要按环境放行锁**，需要并存就起 `--user-data-dir=<临时目录>` 的隔离实例（见 5.1）。
- **托盘**：关闭窗口默认隐藏到托盘（`preferences.minimizeToTray`），`before-quit` 才置 `isQuiting` 让窗口真关。
  退出时 `will-quit` 要 `tray.destroy()`，否则托盘图标残留。
- **菜单**：自定义菜单刻意**去掉 zoom 角色**，否则 Ctrl +/-/0 会缩放整个页面并抢在渲染端之前触发；
  Reload / Force Reload **不注册加速键**（Ctrl+R 必须透传给终端：vim 的 redo、readline 反向搜索都靠它）；
  F5 在 `before-input-event` 里拦掉（会毁掉终端会话）。
- **凭据只在主进程解密**：`storage.getSshProfile` 返回明文，渲染端永远拿不到；列表接口只给 `hasPassword` 这类脱敏标记。⚠️ RDP 是刻意的例外：NLA / CredSSP 票据必须在渲染进程算，仅连接时经 `rdp:credentials` 单次下发（见 4.17）。

**17. BoringSSL 会拒绝「缺 digitalSignature 用途位」的服务器证书 —— OpenSSL / SChannel 不查这一位**

- **触发信号**：RDP 连接报「接入握手失败：received an RDCleanPath error: general error (code 1); HTTP 502
  bad gateway」时别只信错误码 —— 换个客户端（mstsc / 纯 Node）连同一台服务器往往正常。
- **根因**：Electron 主进程里的 Node 用 **BoringSSL**（`process.versions.openssl` 报 `0.0.0`），客户端会校验
  服务器证书 keyUsage 与协商套件的一致性：证书没有 `digitalSignature` 位时，一切靠证书签名的套件（全部
  TLS 1.3、全部 ECDHE）都被 `KEY_USAGE_BIT_INCORRECT` 掐断；云镜像工具生成的自签证书经常只带
  `keyEncipherment`。OpenSSL / SChannel / rustls 都不做这个检查 —— 「只有我们的桥连不上」的经典现场。
  （RDCleanPath 把一切握手失败统一归成错误 PDU 1/502，真实原因只在主机日志。）
- **正确做法**：识别该错误后自动降级 **TLS 1.2 + 静态 RSA 密钥交换套件**重试一次（证书此时用于加密而非
  签名，语义合法），成功与失败都写主机日志。⚠️ 套件清单必须写 **OpenSSL 风格名**（`AES256-GCM-SHA384`…）
  —— BoringSSL 不认 IANA 全名（`TLS_RSA_WITH_*` 解析成空列表 → `NO_CIPHERS_AVAILABLE`）；也别因
  `tls.getCiphers()` 里看不到 `TLS_RSA_*` 就以为静态 RSA 不可用（实测可协商）。
- **验证**：`scripts/verify-rdp-bridge.mjs` 坏 keyUsage 假服务器场景（默认握手被拒 → 降级成功 → 对端恰两次
  连接 → 日志有告警与成功留痕）。

### 6.5 渲染端 UI 细节

**17. 脚本没有独立功能区；侧边栏纵向分区统一用 StackedSections**

- 脚本只服务主机，`SCRIPTS_ACTIVITY_ID` 已删除，改为「主机」侧边栏的下半区分区。跳转用
  `useAppStore((s) => s.openScriptsSection)`（一次展开「功能区 + 侧边栏 + 分区」三层）。
- 任何「上下分区、各自可折叠」的布局都用 `shared/components/StackedSections.tsx`；
  分区 id 以「功能区.分区名」注册到 `app/section-ids.ts`。
- **空间规则（别改成裸 flex）**：折叠的分区只占标题栏（`shrink-0`），展开的分区 `flex: <grow> 1 0` + `min-height`。
  `SectionContent` 收起时用 `display:none` 而**不卸载**，否则面板里的搜索词、分组展开态会被重置。
- **可拖拽高度**：分区声明 `resizableAbove={上方分区 id}` 后顶部多一条横向拖拽条
  （绝对定位压在边界线上、不占布局高度），拖过的高度写入 `ui.sectionHeights`，此后用 `flex: 0 0 <H>px`。
  拖拽条只在「上下两个分区都展开」时存在；拖动时 `max = 容器高度 - 上方分区的 inline minHeight`（从 DOM 读，别让调用方再传一遍）。

**18. 对话流里的「思考 / 工具」是横条，不是卡片**

- 参考实现是 `D:\Workspace\web\owner\ainav\sdk`（`src/widget/`，`ap-*` 类名）：那边思考与工具调用都是
  **一条扁平行** `[图标] [标签] [内容] [›]`，无边框无底色，hover 才有淡底，展开体只有一条左边框竖线。
  本项目的 `CollapsibleRow` / `ReasoningPanel` / `ToolCallRow` 是它的 Tailwind 移植版，**不要再写成带边框底色的卡片**。
- **折叠动画 `0fr → 1fr` 有前置条件**：展开体（grid item）必须 `min-h-0` 且 `overflow` 不为 `visible` ——
  `fr` 轨道的 `auto` 最小尺寸就是 grid item 的 min-content，item 不是滚动容器时会把 0fr 轨道直接顶开。
  收起态 `overflow-hidden`、展开态 `max-h-64 overflow-y-auto`，两个分支**互斥**
  （`cn` 是 tailwind-merge 语义，`overflow-hidden` 会吃掉后面的 `overflow-y-*`，同时写会静默失效）。
- 折叠容器的**纵向 padding 必须放在 grid item 内部**：写在容器上时收起后会留一条缝。
- **横条按内容宽度收（`w-fit max-w-full`），不占满整宽**（用户明确要求，别改回 `w-full`）；
  工具横条里的**滚动条只能有一条** —— `pre` 不要自己设 `max-height`/`overflow`，统一由展开体承担。
- **思考横条的单行实时预览必须纵向滚，不能横向滚**：现在是
  `block h-[1.4em] leading-[1.4] whitespace-pre-wrap break-words overflow-hidden`，
  流式时 `lineRef.scrollTop = scrollHeight`。⚠️ 别改回 `whitespace-nowrap` + `scrollLeft` ——
  那样换行符被折叠成空格，整段思考挤成一条横线。预览要用 `text.trimEnd()`（模型常在段间吐 `\n\n`，
  视口只有一行高，不去掉尾部空白就显示成空行）。高度用 `em` 而不是写死 px，跟字号联动。
- **字号**：横条 `text-sm`(14px)、正文 `text-[15px]`、代码块 `text-[13px]`。
  **不要用 10px/11px 当正文字号**（用户反馈过「字体太小」）。
- 新增「可折叠的一行」一律套 `CollapsibleRow`；状态与配色用 `ToolCallRow` 的 `toolRunStatus()` + `TOOL_LABELS`
  （Agent 页与终端 AI 助手共用，别各写一份）。

**19. 对话流滚动是共用 hook，且发消息 = 直接滚到底**

- **当前行为（用户明确要求）**：发出去就直接发，消息追加后滚到最底部。
  **不要**再做成终端 `clear` 那种「把刚发的消息钉在视口顶部、旧内容顶出去」——
  清屏观感依赖「下方内容够不够高」，长回复 / 短回复表现不一致。
- 共用实现是 `features/agent/useMessageListScroll.ts`（`AgentPage` 与 `AiPanel` 共用，别再抄第三份）：
  入参 `{ conversationId, messages, streaming, extra }`，返回 `{ scrollRef, onScroll, showJump, jumpToBottom }`。
  - `onScroll` 里 `programmaticTopRef` 的落点比对**必须留着**，否则代码自己滚的那一下会被当成「用户往上翻」。
    `setScrollTop` 要把 `prevScrollTopRef` 同步成**读回来的（被钳过的）实际值**。
  - 容器上用 `overflow-anchor: none` 关掉 Chromium 的滚动锚定（流式内容增长 / markdown 重排时会错误修正滚动位置，
    造成偶发跳顶）。
  - **用户正在列表里选中文本时必须停止贴底**（`hasListSelection` 后直接 return）。
    否则流式每来一个 token，`scrollTop` 就往上涨一点，已经选好的那段被顶上去 ——
    现象是「UI 看着没滚（滚动条一直在底部），选中区域却飞快往上跑」。用 `Range.intersectsNode(el)`
    而不是 `contains(anchorNode)`（从列表一直拖到输入框的跨区选择也算）。
    ⚠️ 这个 bug 只在「用户本来就在底部拖选一段已经可见的文字」时出现，**别用「往上翻能选中」来证明它没问题**。
- **「滚动到底部」按钮**：不在底部时才出现，`absolute bottom-3 left-1/2 -translate-x-1/2`、`size-8` 圆形，
  **带 `aria-label="滚动到底部"`**（脚本靠它定位）。Agent 页与 `AiPanel` **各有一个**，
  查找时必须限定在当前消息列表容器内，不能用全局 `querySelector`。
- **编辑并重发**：点 `MessageEditButton` 只把内容灌进底部输入框（**不是就地编辑气泡**），
  发送时走 `resendAgentMessage` / `resendAiMessage` —— 它们**先同步 `set` 截断 `messages.slice(0, index)`**，
  再交给 `sendAgentMessage` / `sendAiMessage`；顺序反了会把「编辑前 + 编辑后」两条一起喂给模型。Esc 取消。
- **AiPanel 的差异**：输入框是**单行 antd `Input`**（不是 textarea）；编辑提示条在卡片顶部；
  点「编辑」会顺手 `setAiMinimized(sessionId, false)` 撑开卡片；它挂在**面板组的终端页面**上
  （`PanelView` 里 `aiOpen && aiSessionId`），不是活动栏功能区 —— 做 fixture 别手搓
  `sessions`/`groups`/`layout`/`ui.panelTabs`，直接调 `createLocalSession()` + `setSessionAiOpen(sid, true)` + `setAiMinimized(sid, false)`。
- 共用的页面内小工具在 `scripts/lib/agent-dom.mjs`（**选择器不写死宽度类**，从 fixture 文本反推容器）。

**20. antd 组件与 CDP 脚本的静默陷阱（写验证脚本时必踩）**

- **antd 会给恰好两个汉字的按钮中间插空格**（`关闭` 的 `textContent` 是 `关 闭`）——
  按 `textContent === '关闭'` 找按钮永远找不到，而 `if (btn)` 会把「没点到」静默咽掉。**比对前先去掉空白。**
- **合成事件关不掉 antd 下拉**：`document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))` 实测无效。
  关不掉的后果是后面切换工作区时，旧标签那个**已展开的下拉仍留在 DOM 里**（`offsetParent !== null`），
  数菜单条目时把两层一起数进来 → 断言假 FAIL。正确姿势：Dropdown 的 `trigger=['click']` 是开关，**再点一次触发器**。
- `console.log('文案：', value)` 多参数之间会**插一个空格**，脚本里别按整句比对。
- **探针里 `cdp.eval` 的代码经 Node 模板字面量插值：正则转义会被吃掉一层** —— 源码里写 `/\s+/g`（单反斜杠），页面实际执行的是 `/s+/g`，去空白**静默失效**（按钮按去空白文本匹配永远 `NOT-FOUND`；旁边独立写的同类表达式却正常，因为那里写的是 `\\s`）。**探针源码里的正则一律写 `\\s`**；排查「同名逻辑一处好一处坏」先 dump 页面侧函数源码（`.toString()`）对字节。

**21. antd 的 cssinjs 压过 Tailwind：给 antd 组件写宽度类会被静默吃掉**

- **根因**：antd 6 的样式是运行时注入的 cssinjs，**不在 `@layer` 里**，优先级高于 Tailwind 的
  `@layer utilities`。所以 `<Input className="w-56" />` 里那个 `w-56` **不生效也不报错** ——
  `.ant-input { width: 100% }` 直接把它压掉。
- **踩坑现场**：旧自动化脚本页的起始地址栏写的是 `<Input className="w-56 shrink-0" />`，
  实测计算宽度 **951px**（不是 224px）。它又带 `shrink-0`（不许被压缩），于是整条工具栏被顶出容器：
  溢出 190px，右侧按钮组整个跑到可视区外，**用户直接看不到按钮**。（该功能区已移除，案例保留。）
- **正确写法**：宽度交给**外层 div**，别写在 antd 组件上。
  ```tsx
  <div className="w-56 shrink-0">
    <Input size="small" className="text-xs" />
  </div>
  ```
- **同类风险的判定**：不是所有 antd 组件都这样。`Select` 实测 `className="w-28"` 是 **112px = w-28，正常生效** ——
  因为 antd 没有给 `.ant-select` 根节点设整体 `width`。**只有那些 antd 自己写了 `width: 100%` 的组件
  （`Input` / `Input.TextArea` 等）才会被压掉**。改之前先用 CDP 读一次 `getBoundingClientRect().width` 实测，别猜。
- 顺带记一条 antd 6 的结构变化：`Select` 的边框画在根节点 `.ant-select` 上，内层是 `.ant-select-content`
  （`border-width: 0`），**antd 5 的 `.ant-select-selector` 已经不存在** —— 照旧写法改它不报错也不生效。

**22. `ResizeHandle` 的方向 —— 受控面板在右侧时必须 `invert`**

- 拖拽条自己的逻辑：`delta = clientX - startX`（不动方向）。视觉上「往右拖 = 拖拽条右边的面板变宽」。
- `invert = true` 时取相反数，意思是「往左拖 = 右边的面板变宽」。
- 规则：**分隔条左边的面板用 `invert={false}`**，**右边的面板用 `invert={true}`**（浏览器面板在分隔条右侧，
  往左拖才是把它拉宽）。
- 用户报告「拖动改变宽度方向反了」就是这个：旧自动化页一开始没传 `invert`，鼠标往右拖面板反而变窄，
  体验像坏了（该功能区已移除，案例保留）。
- `ResizeHandle` 还用在侧边栏宽度（`app/App.tsx`）、Agent 页（`agent/AgentPage.tsx`）等多处；
  验证脚本**不能** `document.querySelector('[title="拖动调整宽度"]')` 一把抓，否则命中的可能是旁人的
  那个（实测踩过 —— 跑出来 pane 是 991 / editor 是 288，比例 3.44，根因就是选错了侧边栏的把手）。
  从页内一个已知按钮反推到页面根组件，再在根内 query。

**23. 标签内容宿主必须是 flex 列，否则面板根的 flex-1 静默失效、长列表滚不动**

- **现场**：主机日志多起来后，列表滚不动，可视区以下的内容被裁掉（列表容器自己的类是
  `min-h-0 flex-1 overflow-auto`，看着没毛病，别只盯着它查）。
- **根因**：`PanelView` 里每个标签的包层原来是 `<div className="h-full">` —— **裸块级**。
  面板根（如 `HostLogsPanel` 的 `flex min-h-0 flex-1 flex-col`）的 `flex-1` 只在父级是 flex 容器时才有意义，
  裸块级父下它不生效 → 面板高度 = 内容高度（实测条目容器涨到 24322px）→ 内部 `overflow-auto` 的
  `clientHeight` 永远等于 `scrollHeight`，永远没有滚动条；超出的部分溢到 pane 容器的 `overflow-hidden` 被裁掉。
- **正确做法**：包层写 `flex h-full flex-col`（已改）。这样 `flex-1` 根拿到确定高度、`min-h-0` 生效，
  内部滚动容器才真正被压扁、可滚。`h-full` 根的页面（终端 / 笔记 / SFTP / API / Agent…）不受影响 ——
  100% 高度在块级与 flex 父下都成立；auto 高度的根也不变（flex 列主轴不拉伸）。
- **同类已被此修复覆盖**：`TunnelsPanel`、`PluginsPage`（同款 `flex min-h-0 flex-1` 根），
  此前只是内容不够长没暴露。**新建面板还想用这个根式样，别再怀疑宿主**。
- **验证**：`tmp/probe-logs-scroll.mjs`（开日志标签 → 注 300 条假日志 → 量滚动容器）；修复前
  clientHeight/scrollHeight = 24322/24322、scrollTop 恒 0，修复后 592/24322、能滚到最后一条。
  判断面板「能否滚」不要看有没有滚动条类名，直接量 `clientHeight < scrollHeight` 再说 `scrollTop` 能不能动。

**24. 文本拆进多个 flex 子项时，边界空格会被 CSS 裁掉（命令预测显示成 `gitstatus`）**

- **现场**：终端命令预测下拉框里，多词命令显示成 `gitstatus`（用户报告「命令预测中的命令缺少了空格」）。
- **根因**：建议行 `button` 是 flex 容器，前缀 `{buf}` 与高亮剩余 `{rest}` 是两个子 span ——
  它们各自成为 flex 子项（块容器），边界空格（前段结尾 / 后段开头）落在各自行盒的行尾 / 行首，
  CSS 排版阶段按「行首 / 行尾的可折叠空格被移除」直接裁掉（`textContent` 仍是 `git status`，DOM 看不出）。
- **正确做法**：两段文字放回**同一个元素**（外层 span 照旧 `truncate`，内层 span 只挂 `font-medium text-primary`）——
  空格变成行内文本流的中段空格，不会被裁。⚠️ 前后缀高亮类渲染（diff / 搜索命中标注）都别把边界空格留在两个 flex 子项之间。
- **验证**：`scripts/verify-terminal-prediction.mjs` 按**渲染宽度**断言（range 联合包围盒 vs 同字体「带空格 / 粘连」两个基准）；
  **结构断言测不出来** —— 两种结构渲染出的文本内容一致，只有宽度 / 截图能看出差别。

**25. 全屏程序里「组合键之后的可打印键」被当成命令行输入（tmux 的 `Ctrl+B d` 误弹命令预测）**

- **现场**：tmux 里按 `Ctrl+B` 再按 `d`（detach），终端里没有任何输入回显，却弹出了命令预测面板 ——
  凭 `d` 前缀匹配出 `df` / `du` / `docker`…（用户报告）。vim 里按 `dd`、less 里按 `d`（翻页）同理。
- **根因**：本地预测只按「是不是可打印文本」跟踪缓冲。`Ctrl+B`（`\x02`）是控制字符，会把缓冲重置；
  但紧随其后的 `d` 是可打印字符，于是被当成用户在 shell 里敲的内容累积起来。tmux / vim / less
  这类全屏程序会把「组合键之后的可打印键」当作自己的命令消费掉，屏幕不回显 —— 本地缓冲与真实
  命令行彻底脱节。**本地无从区分 tmux 的 prefix 与 readline 的同类按键**（`\x02` 本身也被 tmux 吞掉），
  所以「精确修复」不成立。
- **正确做法**：这些全屏程序都跑在 xterm 的**备用屏幕**里 —— `term.buffer.active.type === 'alternate'`
  时整段按键都不参与预测（既不累积缓冲、也不拦截 `→` / `Ctrl+↑↓`），原样交给程序。
  ⚠️ 别退回「只看控制字符」的做法，那正是这个坑；也别把判断挪到 `recompute` 之外更宽松的位置。
- **代价**：tmux 窗口里的 shell 提示符下也不再有命令预测（那些键从本地看与 tmux 命令键无法区分）。
  想要「tmux 内也能预测」需要 shell 集成（OSC 133 之类）给出命令行边界，目前没做。
- **验证**：`scripts/verify-terminal-prediction.mjs` 用例 5 —— 先确认普通提示符下按 `d` 确实会弹
  （否则「不弹」说明不了问题），再用 shell 打印 `?1049h` 真进备用屏幕，断言按 `d` 不弹，最后 `?1049l` 回主屏。
**26. 面板组里所有标签常驻挂载：隐藏标签的 ResizeObserver 要防「尺寸塌缩」**
- `PanelView` 的标签不是按需挂载：切走的标签留在 DOM 里（加 `hidden` 类），RDP / 终端这类**有连接状态的页面
  切回来不用重连** —— 代价是**隐藏时观察者回调照样触发**。
- `RdpPage` 的尺寸守卫（`phase === 'connected'` 的 ResizeObserver）：回调里先防抖 400ms（拖拽分屏一秒几十次），
  再量容器 rect，`width < 200 || height < 150` 直接跳过 —— `display:none` 下 rect 全 0，把 0×0 当 resize
  发给远端会让桌面缩成一团；切回可见时观察者会再触发一次，不用手动补。
- 「标签是否可见」不要自己加 prop 透传：量 rect 就够，任何显示层变化都自动覆盖。

**27. React StrictMode 下「异步建连接」的 effect 不能用 cleanup 无脑拆**

- **现场**：dev 下 StrictMode 让 effect「建立 → 清理 → 再建立」跑两遍。天真写法（cleanup 里直接
  `rdp.close(connId)`）：第一次的 cleanup 若晚于第二次 run 的 `rdp.open` 落地，会把新 run 正在用的桥关掉
  （表现为偶发「连不上 / 秒断」，release 正常，只在 dev 复现）。
- **正确做法**（`RdpPage` 的 epoch 守卫）：`epochRef` 世代号 —— 每个 run 开头 `const myToken = ++epochRef.current`，
  每个 await 之后先查 `myToken !== epochRef.current` 就静默退出（让位给新 run，**不动桥**）；只有
  `cancelled && myToken === epochRef.current`（真卸载）才 `rdp.close`。
- 同类竞态：`build.connect()` 的结果回来时若已换代 / 已卸载，要先把 session `shutdown()` 再释放桥，别只丢引用
  —— WASM 会话里跑着 Rust 事件循环。
- 判据：这类 effect 的清理必须**幂等且可归属**（是谁建的谁清）—— 与 4.2「流式事件自带归属」同一思想。

**28. 侧栏列表行的行尾按钮必须绝对定位浮层，不能留在 flex 流里**

- 参考实现是 fishwork 的 `components/Sidebar.tsx`（本仓搬家到
  `shared/components/SidebarRowActions.tsx`）。**问题**：把按钮留在 flex 行里只加
  `opacity-0 group-hover:opacity-100`（或 `invisible` / `hidden`）**照样占一整格宽度** ——
  侧栏本来就窄，悬停才出现的按钮却全程在吃名字的宽度，长名字被提前截成几个字。
  主机 / 脚本 / 接口 / 笔记 / 面板都犯过，插件面板连 `Switch` 右侧那列都被两个按钮撑宽过 16px。
- 正确做法：`SidebarRowActions` 绝对定位在行右侧（`pointer-events-none`，
  hover 时 `group-hover:pointer-events-auto group-hover:opacity-100`，窄屏常显），
  底衬 `bg-gradient-to-l from-sidebar` 渐隐；名字平时吃满整行，只用
  `SIDEBAR_ROW_NAME.{one,two,three}`（`min-w-0 flex-1 truncate group-hover:pe-*`）在 hover 时让位。
  ⚠️ 按钮数与 `pe-*` **必须匹配**（每个按钮 = 18px + 2px 间隙 + 浮层 16px 内边距）：
  少让位文字会压在按钮下，多让位等于没修好。
- 顺带一条：**名称后紧跟的小元素（折叠箭头 / 取色点 / 数量）不能跟着 `flex-1`** ——
  否则它被顶到行尾、正好钻进浮层按钮底下（都是 hover 才显形，撞上看不出来）。
  这类行把让位类用在**外层容器**（`SIDEBAR_ROW_TRAIL_RESERVE`），名称只给 `truncate` 不给 `flex-1`。
- AI Agent 侧里「**新建会话**」从「更多」下拉里提出来常驻行尾、放在 more 左边（最高频动作）；
  探针定位走 `button[title$="中新建会话"]`，见 `scripts/verify-agent-acp-import.mjs`。

**31. `Form.useWatch` 只看得见「已注册字段」—— 别把 Form.Item 拆掉**

- **现场**：新建主机对话框的主机类型分段（Segmented）用 `Form.useWatch('kind')` 驱动分支字段区。
  点击切换后选中态变了（store 里 `kind` 也已是新值），但字段区**永远渲染默认分支**，无任何报错。
- **根因**（@rc-component/form 1.8.6 源码级实测）：WatcherCenter 每批变更后把 `formInst.getFieldsValue()`
  （**不带 `true`**）交给 watcher —— 只遍历 **Form.Item 注册过的**字段实体。分段选择器写成裸
  `<Segmented value={...} onChange={form.setFieldValue('kind', ...)}/>`（没包 `<Form.Item name="kind">`）时，
  store 有值但 watch 永远收到 `undefined`，三元分支静默走错。
- **正确做法**：受 watch 驱动的控件必须包在对应 name 的 `Form.Item` 里（Field 注入 value / onChange）；
  子控件 `onChange` 只放「切换时的副作用」（如端口从 22 换成 3389），不要再手写
  `setFieldValue('kind', ...)` —— Field 先派发 store 更新、再调子组件 onChange，顺序安全。
- **验证**：`scripts/verify-rdp-host-ui.mjs`（切「远程桌面」→ rdp 字段齐备、端口自动 3389）。

### 6.6 AI / Agent 专项

**21. 「思考内容」不显示 = provider 把 `reasoning_content` 丢了**

- 根因（实测，不是推测）：`@ai-sdk/openai` 的 **chat-completions 分支完全不解析思考字段** ——
  源码里 `reasoning` 相关标识全是 Responses API 的，chat 分支一个都不认，`forceReasoning` 也只影响请求参数兼容性。
- 而各家兼容网关字段还不统一：GLM / airouter / StepFun 用 `delta.reasoning_content`（字符串）；
  OpenRouter 用 `delta.reasoning` + `delta.reasoning_details`（数组）。
- 正确做法：`openai-compatible` + `chat-completions` 改走 **`@ai-sdk/deepseek`** 的 chat 模型
  （它解析 `reasoning_content`，请求体同样是标准 chat-completions），
  并在 fetch 层加 SSE 字段归一化（把 `reasoning` / `reasoning_details` 改写成 `reasoning_content`）。
  两个都在 `services/ai/resolve-model.ts`。
- ⚠️ **不要**给 `kind: 'openai'`（官方）也换成 deepseek —— 官方 chat 分支的 `max_tokens` 对 o1/o3 会被拒
  （要用 `max_completion_tokens`），官方走 Responses API 本来就有思考。
- `resolveModel` 单独成文件（不依赖 electron / node-pty）就是为了能直接跑真代码验证：用 vite lib 模式把它打成单文件 ESM 后 import。

**22. 兼容网关把流式 `tool_calls[].type` 发成空串 → 整条流 `Type validation failed`**

- 现象：一调用工具就报 `Type validation failed`，zod 错误 `invalid_union` →
  `path: ["choices",0,"delta","tool_calls",0,"type"]` → `expected "function"`。
  实测于 StepFun：首个增量正常发 `type:"function"`，**后续增量把 `type`/`id`/`name` 全发成空串**（只带 `arguments` 片段）。
- 根因：AI SDK 的 chat chunk schema 里 `type` 是**字面量** `z.literal('function')`（不是 `z.string()`），
  空串不合法；且 `function` 对象必须存在。一个字段脏 → 整条流被丢弃。`@ai-sdk/openai` 与 `@ai-sdk/deepseek` schema 一样严。
- 正确做法：在 fetch 层 SSE 归一化里补两条（`resolve-model.ts` 的 `rewriteSseLine` / `normalizeReasoningFetch`）：
  ① `tc.type !== 'function'` 一律改成 `'function'`；② `function` 缺失时用平铺的 `name`/`arguments` 补一个壳。
- ⚠️ 归一化 fetch 必须挂到**所有 chat-completions 分支**（含 `kind:'openai'` 官方分支 —— 用户可能把它指向兼容网关）。

**23. 历史消息里的工具过程必须用原生 `tool-call` / `tool-result` 结构**

- **不能**压成 `[调用工具 xxx]` / `[工具 xxx 返回] xxx` 这类纯文本摘要 ——
  模型会把这个格式当成「助手的说话方式」，多步工具链之后开始在正文里照抄 `[调用工具 read_file]` 这种假调用（用户直接看到过）。
- 转换见 `agent-core/agent.ts` 的 `toModelMessages`（终端 AI 助手复用同一份）：
  - 一轮历史的 parts 是**扁平交错**的（text, call, result, text, call, result…），
    要按「一批 tool-call 及其全部结果」切成若干段：`assistant`（文本 + tool-call）紧跟 `tool`（结果），顺序与 API 要求一致。
  - `tool-result.output` 是**包装结构**（`{ type: 'text' | 'json' | 'error-text', value }`），不是裸值；
    `ToolResultOutput` 类型 `ai` 包**没有导出**，用 `ToolResultPart['output']` 派生。
  - 悬空 tool-call（用户中止）要补占位 `error-text` 结果、孤儿 tool-result 要丢弃，否则 provider 直接拒请求。
  - ⚠️ **`historyLimit` 必须在转换前按历史条数截断**（`toModelMessages(history.slice(-N))`）——
    转换后一条历史会展开成多条模型消息，在模型消息上 `slice` 会把 `tool` 消息和它的 `tool-call` 拆开。
  - 系统提示词里同时明令禁止复述 `[调用工具 xxx]`（双保险，防旧历史里的残留文本继续带偏）。

**24. ACP 联调「prompt 挂起」先查权限模式，别怀疑 Web Streams**

- 外部 ACP agent 在应用里 `session.prompt()` 迟迟不 resolve、主进程日志停在「session ready」：
  示例 / 真实 agent 会在回合中发 `session/request_permission` 并**等待客户端响应**；
  应用处于 `permissionMode: 'confirm'` 且无人批准时，整轮 prompt 都不会返回。
- 正确做法：① 联调用 `permissionMode: 'full'` 或让确认卡自动批准；
  ② `acp-agent.ts` 的 runTurn **不要 await prompt** —— 先 `session.prompt(text).catch(() => undefined)` 发出，
  立即用 `session.nextUpdate()` 流式消费（错误同样经 updates 队列抛出），这样权限等待期间 UI 也能看到已产生的事件；
  ③ 进程 / 连接关闭会使 updates 队列 fail，`nextUpdate()` 抛错即可走异常路径。
- 已知安全区：完整 Electron 主进程作为 ACP 客户端 + 纯 Node agent（codex-acp 即此形态）通信正常；
  仅当 agent 自身也以完整 Electron 运行时协议会挂（真实场景不会出现）。
- Windows 下 npm 脚本入口要带 `.cmd` 后缀（`AcpAgentConfig.command`）。

**25. 技能发现的两个静默失效**

- **`Dirent.isDirectory()` 对软链接 / Windows 目录联接（junction）恒为 false**。
  别人用 skills CLI 装的技能常常就是这么挂进来的（本机实测 `~/.agents/skills/superpowers` 就是个 junction），
  只认 `ent.isDirectory()` 会**静默漏掉**。非目录时要补一次 `fs.stat`（跟随链接；断链抛错 → 跳过）。
- 判断「根目录本身就是技能」时**别写 `isDir(join(root, 'SKILL.md'))`** —— `SKILL.md` 是文件不是目录，
  这个条件永假，整条分支从来没生效过（静默失效，构建与类型检查都不报）。直接调 `readSkillDir(root)` 让它自己 stat。

**26. Agent 完成通知：前台判定必须在主进程**

- `isAppInForeground(win)` = 窗口存在且未销毁 / 可见 / 未最小化 / 已聚焦 —— 渲染端的 `document.hasFocus()`
  判断不了「隐藏到托盘」这类状态。渲染端只负责**凑内容**（会话标题 + 回复开头 120 字），主进程负责**发不发**。
- 开关是 `preferences.notifyOnAgentFinish`（缺省开，`getPreferences()` 会合并默认值）；用户主动中止（`finishReason === 'aborted'`）不发。
- 主进程在决策处**打日志**（跳过原因 / 已发送）——「通知怎么没弹」只能从这两行看出来。
- 会话行状态图标按「**等回答 > 运行中 > 静止**」选：`followupRequests` 里有条目的 `requestId` 等于该会话
  `agentRuns[cid].requestId` 就是「等用户回答」。
  ⚠️ 别用返回新对象 / 新 `Set` 的 selector 取这两张表（zustand 用 `Object.is` 比快照，会无限重渲染）——
  取整表再在渲染里按行推导。

**27. 会话选的模型重启后丢失 = `modelId` 没落盘**

- **现场**：每个会话选的模型，重启应用后回到默认（用户报告；ACP 与内置后端都一样）。
- **根因**：`modelId` 在**整条落盘链路上都缺席** —— `app-store.ts` 的 `persistConversation` 只传了
  `backend` + `configId`，preload 的入参类型、`ipc/agent.ts` 的入参类型、`storage.saveAgentConversation`
  都没有这个字段。于是「这个会话选了哪个模型」从来没写进磁盘，重启后只剩 `configId`，
  看起来就是「恢复成默认模型」。
- **正确做法**：`kind` / `configId` / `modelId` / `acpAgentId` / `acpSessionId` 同款处理
  （`'x' in input` + 每次显式带上），从渲染端到 storage 一路对齐（见 4.3）。
- ⚠️ **`kind` 是可缺省的（未定形态）**：新建的会话**不要**在落盘时缺 `kind` —— storage 的兜底会把它
  当成 `mastra`，于是「首条消息定型成 ACP」的会话在重启后显示成内置。正确顺序是
  `sendAgentMessage` 里**先按选中的模型算出 kind 写进会话，再落盘**（未定形态的会话则干脆不落盘）。
- ⚠️ 同一套语义现在也覆盖 **ACP 绑定**：`acpSessionId` 是 `session/new` 时由 agent 返回的，
  靠 `agent:acp-state` 广播回填 —— **回填那一刻必须落盘**，否则重启后那条会话成了「没有绑定」的
  孤儿记录。另外 ACP 会话的**消息永远不进 storage**（`saveAgentConversation` 里对 `kind: 'acp'`
  直接写空数组），别为了「能离线看历史」把它存回来。
- **验证**：`scripts/verify-agent-conversation-model.mjs` —— 真启动两次应用（同一 userData），
  覆盖 mastra 的形态 / 模型落盘语义与 ACP 的绑定落盘 + 「消息恒为空」。

**28. ACP agent 报 `Method not found: fs/write_text_file` = 客户端那两个方法没实现**

- **现场**：用 opencode 等 ACP agent，写文件那一轮直接失败，agent 侧吐
  `RequestError: "Method not found": fs/write_text_file`（用户报告）。
- **根因**：ACP 里客户端要实现 `fs/read_text_file` / `fs/write_text_file`；`acp-agent.ts` 当时只注册了
  `session/request_permission`，agent 发文件请求时服务端找不到 handler。
- **正确做法**：① initialize 的 capabilities 里广告 `fs: { readTextFile: true, writeTextFile: true }`；
  ② 用 `acp.methods.client.fs.readTextFile` / `.writeTextFile` 注册 handler；
  ③ ⚠️ 路径必须限制在**工作区内**（`services/ai/acp-fs.ts` 的 `resolveInsideWorkspace`）——
  agent 是我们 spawn 的外部进程，不能让它借这条通道读写工作区外的文件。
- **验证**：`scripts/verify-acp-fs.ts`（不起 Electron，直接跑 `acp-fs.ts` 真源码）。

**29. Windows 上 Agent 的 `execute_command` 要走 Git Bash（模型发的是 Linux 风格命令）**

- **触发信号**：Windows 上 Agent 执行 `ls` / `grep foo | wc -l` / `for f in *.md; do …; done` 全部报
  「不是内部或外部命令」「无法将…识别为 cmdlet」，而同样的命令在别的编码代理（Claude Code / Codex）里正常。
- **根因**：模型受训练语料影响，绝大多数时候按 POSIX 习惯写命令，**它不知道该改写成 PowerShell 语法**。
  原来的实现 Windows 走 PowerShell，等于每条 Linux 风格命令都要模型自己翻译一遍 —— 失败率高且 token 浪费。
- **正确做法**：Windows 上优先用 **Git Bash**（`<Git>\bin\bash.exe -lc <cmd>`）执行，模型直接拿到
  POSIX 工具链（ls / grep / sed / find / 管道 / `$VAR` / 通配）。
  - 探测复用 `services/terminal/shells.ts` 的 `findGitBash()`（**已导出**，与终端下拉同一份逻辑：
    常见安装路径 + `where git.exe` 推导）；结果在 `services/ai/agent.ts` 里**进程级缓存**（含扫盘）。
  - 注入方式是 `AgentToolOptions.bashPath`（**由调用方传，agent-core 不 import electron/shells**）——
    agent-core 保持零环境依赖，才能脱离 Electron 跑真源码做单测。
  - PATH 里显式前置 `<Git>\usr\bin`：coreutils 在那里，继承的 Windows PATH 通常不含它。
  - **没有 Git Bash 时回退 PowerShell**（不能因为缺 Git 就让工具不可用）；POSIX 平台恒为 bash。
  - 工具描述按实际环境措辞（「命令运行在 Git Bash（POSIX）环境…」/「…在 PowerShell 环境」）——
    模型要据此决定命令风格，描述与实际不符比不写更糟。
- ⚠️ **不要**改成 WSL：`wsl.exe` 里 `cwd` 得换成 `/mnt/c/...` 做路径翻译、且默认发行版可能没装，
  比 Git Bash 脆得多（终端里的 WSL 是另一回事，那是用户显式选的 shell）。
- **验证**：`scripts/verify-agent-posix-command.mjs`（跑 agent-core 真源码）—— 注入 bashPath 后
  `ls` / 管道 + 通配 / `grep -n` / for 循环 / `$HOME` 全按 POSIX 语义工作；不注入时回退 PowerShell
  且仍能执行；工具描述如实声明环境。需要 Git 时用 `DOGI_TEST_BASH` 指定 bash.exe 路径。

**30. 错误文案要「可替换」而不是「可追加」；重试次数是 mastra 的 `modelSettings.maxRetries`**

- **现场**：一次断流后消息里出现好几段几乎一样的 `⚠️ …` 文案（用户报告「多次重试的文案都追加显示出来了」）。
- **根因（渲染端）**：`error` 事件在 `agent-helpers.ts` 的 `appendAgentPart` /
  `appendAssistantPart` 里是往消息尾部 **push** 的。同理，任何「一轮里发两次 error」的路径都会堆出两段。
  ⚠️ **别把它归因成「p-retry 每次尝试各发一个 error chunk」—— 实测不是**：
  `scripts/probe-mastra-error-chunks.mjs` 用假 LanguageModel 跑 mastra 真源码，
  always-500 时 `maxRetries=0` → 1 个 error chunk、`maxRetries=2`（模型被调 3 次）→ **仍只有 1 个**；
  多步（先工具调用后失败）也只有 1 个；流中途 `controller.error()` / 迭代器抛 也都只 1 个
  （mastra 把它包成 `deferredErrorChunk` 且 `for await` 不抛）。
  升级 mastra 后**重跑这个探针**再下结论。
- **正确做法**：错误 part 落成 `{ type: 'text', text: '⚠️ …', error: true }`
  （两个 part 联合类型都加了这个可选标记，**不是**新 part 类型 —— 新类型要动
  `toModelMessages` / 渲染 / ACP 装配一整条链，代价不值）。
  - 后到的错误**替换**末尾那段（同一轮只留最后一条失败原因）；
  - `text-delta` **不合并进**带 `error` 标记的段 —— 否则后续正文被接在错误文案后面。
- ⚠️ 别用「文本以 `⚠️ ` 开头」来判：那会让模型正常输出的运维告警（`⚠️ 磁盘 90%`）也带上标记。
- **重试次数**（顺带加进设置）：mastra 把 `modelSettings.maxRetries` 直接交给 p-retry 的 `retries`
  （缺省 2），只在 `doStream` **开流前**失败时重试（`agent-BOxKOk3n.js` 的 `retryWithExponentialBackoff`）。
  生效值见 `@shared/ai-timeouts` 的 `resolveMaxRetries`，界面在「设置 → AI → 超时 → 请求失败重试次数」，
  `0` = 不限制。`agent.ts` 两条作用域的路径都要传（工作区 Agent / 终端助手）。
  ⚠️ **`0` 的代价**：翻译成 p-retry 的 `Infinity`，而 mastra 没设 `maxTimeout`，
  退避延时趋近 `Infinity` 后被 Node 夹成 1ms —— 不会空转（每次尝试都是真请求），
  但等于拿网关连接数去赌。别把 0 设成默认值。
- **验证**：`scripts/verify-agent-error-parts.mjs`（跑 `agent-helpers.ts` 真源码）。

**31. 工具入参也要「流式」：写文件时卡片必须能看到内容在长**

- **触发信号**：让模型用 `write_file` 写一个几 KB 的文件，工具卡只有一行「写入文件 + 转圈」，
  什么都不显示，直到整个文件写完才突然出现 diff（用户报告「看不出它在写什么」）。
- **根因**：工具**入参**也是流式生成的，上游把写文件这种大入参拆成成百上千帧
  （Mastra 1.x 的 `tool-call-input-streaming-start` 只有 id + 工具名，随后一串
  `tool-call-delta` / `payload.argsTextDelta`）。`adaptMastraPart` 此前没有这两个分支，
  整条落进 `default` 被丢掉 —— 只有完整 `tool-call` 那一刻界面才有东西可显示。
- **正确做法（四处，缺一不可）**：
  1. `agent-core/mastra-stream.ts` 把两个 chunk 转成 `{ type: 'tool-call-delta' }` 事件
     （`inputTextDelta` 可以为空串：那一帧的用处是**先把卡片建出来**，标题立刻是真实工具名）；
  2. **下发节奏**统一由 `services/ai/tool-input-throttle.ts` 节流（240 字符 / 60ms）。
     `agent.ts` 两条作用域的路径里**所有**事件都要走包好的 `send()`：
     ⚠️ 非增量事件前必须先 `flush()`，否则同一个 `toolCallId` 的增量会排到它自己的完整
     `tool-call` 之后，前端又用旧增量盖回去（顺序错了比不发还糟）。
  3. 渲染端（`stores/agent-helpers.ts`）按 `toolCallId` 攒进 `part.inputText`。
     ⚠️ **完整 `tool-call` 到达时必须按 id 收口**（把 input 覆盖上去、丢掉 inputText），
     **不能 push 新 part** —— 否则一次调用会渲染成两张卡，一张永远停在「正在生成…」。
     半截卡片先落 `input: null`（`buildRenderUnits` / `buildFileDiff` 都吃 null），收口才填真入参。
  4. 卡片（`features/agent/ToolCallRow.tsx`）用 `partialJsonString` 从**半截 JSON**（`JSON.parse` 必抛）
     里抠 path / command / content → 横条明细 + 「正在生成…」块；块**不要自己设 max-height**，
     滚动仍归 `CollapsibleRow`（见 6.18）。
- ⚠️ **`inputText` 只喂渲染，绝不落盘**：流式期间每 3 秒增量落盘（`persistConversationThrottled`），
  正好卡在生成中途会把半截 JSON 写进盘里 → 重开会话那张卡永远停在「正在生成…」。
  `persistConversation` 里的 `stripTransientParts` 是唯一守卫点，别删。
- ACP 会话**不发**增量事件，走的是原来那条路（只有完整 tool-call）—— 这条链路允许缺失，
  渲染端不能假设「调工具必然先来一串 delta」。
- **验证**：让 Agent 写一个 ≥2KB 的文件，卡片应从「转圈」变成文字逐帧变长（明细先出路径）；
  写完自动收回并显示 diff；中途「停止」后重开会话，消息里的工具卡不应残留「正在生成…」。

**32. 「思考 / 缓存命中」token 恒为 0 = usage 只读了顶层字段**

- **触发信号**：圆环详情里的「其中思考」「其中缓存命中」永远是 0（或整条不显示），
  而思考内容本身是正常流出来的 —— 两条通道互不相干，别被「有思考内容」误导。
- **根因**：AI SDK v6/v7 把这两项从顶层字段挪进了 `outputTokenDetails.reasoningTokens` /
  `inputTokenDetails.cacheReadTokens`，顶层只留 inputTokens / outputTokens / totalTokens。
  而 `services/ai/agent.ts` 当时只读 `u.reasoningTokens` / `u.cachedInputTokens`，
  一个字段都命中不了（v5 时代的口径）。
- **正确做法**：统一走 `agent-core/usage.ts` 的 `normalizeUsage`（多级兜底，含 OpenAI 原始形状的
  `completionTokensDetails` / `promptTokensDetails`），并且**优先从 `finish` chunk 取**
  （`readChunkUsage`）—— Mastra 的 `stream.usage` 是它自己归一化过的形状，明细不一定保留，
  只当兜底。两条路径（工作区 Agent / 终端助手）共用同一份，别各写一遍。
- **顺带**：`0` 与「没报」要分开 —— `normalizeUsage` 只在字段确实存在时才带上，
  调用方据此决定显不显示；拿 0 冒充「上游报的 0」等于骗人。
- **验证**：同一段长上下文连发两轮（第二轮会命中缓存），圆环详情的「其中缓存命中」不再为 0；
  用推理模型（deepseek-reasoner / o 系等）时「其中思考」也不再为 0。

**33. 纯 Node 探针跑主进程源码：`@shared/*` 的运行时导入会直接炸，且会连带让断言悄悄过期**

- **触发信号**：`verify-acp-history.ts` 报 `ERR_MODULE_NOT_FOUND: Cannot find package '@shared/acp-tools'`
  —— 或者更糟：**它已经这样坏了好几轮没人发现**（首次跑就挂在 import 上，前面的断言一条没执行）。
- **根因**：`--experimental-strip-types` 只擦**类型**，`import { x } from '@shared/y'` 这种**运行时**
  别名导入照旧交给 Node 解析，而 `@shared` 是 vite/tsconfig 的构建期别名，Node 不认。
  `import type` 才擦得掉（这也是大多数探针一直没踩到的原因）。
- **正确做法**：需要真源码 + 有运行时别名导入时，走 `.tooltest` 那一套 ——
  **把源文件与它依赖的 `@shared` 模块一起复制到临时目录**，把说明符改写成相对路径再跑
  （`verify-acp-history.ts` 现在复制 `acp-history.ts` + `acp-tools.ts` 到 `.acphistorytest/`）。
  ⚠️ 临时目录加进 `.gitignore`（`.tooltest` / `.cmdtest` / `.filetest` / `.acphistorytest` / `.artifacttest`）。
- **连带纪律**：探针跑不起来时**断言也跟着腐烂** —— 本次就发现第 7 节还在断言
  「无 messageId 多轮要拆成多条」，而 `pushTool` 早已改成**刻意糊成一条**（工具调用不是轮次边界）。
  改实现时同步改断言，或断言直接写新语义（本次改成断言「糊成一条 + 末段正文仍在」）。
- **验证**：修完必须真跑一遍到 `ALL PASS`，别只把 import 改通就收工。

**34. 客户端工具：任何分支都必须回填，否则整轮静默卡死**

- **触发信号**：模型调用客户端工具后界面一直转圈、没有报错、通知也不弹。
- **根因**：主进程侧 `clientToolBroker.invoke()` 返回的是**挂起的 Promise**，只有
  `clientTools:result` 能 settle 它。渲染端 `handleClientToolInvoke` 只要有一个分支忘了
  `resolve(...)`（工具没注册 / 权限确认抛错 / handler 抛错 —— 或者干脆忘了那个 `if (!handler)`），
  那个 Promise 永远不 settle，`streamText` 的当前步就卡住。abort 时的 `cancel(requestId)` 只是兜底，
  正常路径不会走到。
- **正确做法**：渲染端入口**只留一个出口** —— 所有分支都走同一个 `resolve(...)` 包装；
  「用户拒绝」按**正常结果**回填（模型要看到原因并改道），不是 tool error。
- **验证**：`verify-terminal-chat.mjs` 第 4 节（confirm 模式弹框 → 点「拒绝」→ 本轮仍正常收尾，
  且第二轮请求里带着拒绝原因）；`verify-tool-registry.mjs` 第 7 节（broker 侧的挂起 / 回填 / 取消）。

**35. 「先记长度、事后取增量」读终端输出 —— 环形缓冲有损，刷屏时直接返回空串**

- **触发信号**：AI 在终端跑了一条输出很多的命令（`ls -R /`、大日志 `tail`），工具结果里
  **一个字输出都没有**，模型接着瞎猜命令是不是失败了。
- **根因**：`recentOutput` 背后是 **256KB/会话的环形缓冲**（`MAX_OUTPUT_BUFFER`），超了就把最旧的挤掉。
  于是「先 `outputLength()` 记下当前长度 → 命令跑完 → `outputFrom(start)` 取增量」在刷屏场景下
  取回的**恰恰是被挤掉的那段**，得到 `''`。这不是边界条件，是这类命令的常态。
- **正确做法**：**写命令之前**就订阅 `sessionManager.on('data')` 边跑边收（`terminal-tools.ts` 的
  `captureDuring()`，`finally` 里必须摘监听），超长部分交给产物文件（见 4.24）。
  ⚠️ 顺带把 `TerminalSession.outputLength()` / `outputFrom()` **删干净**（接口 + 三个会话类 + `SessionManager`），
  只在注释里留「为什么删」——留着就等于给这个 bug 留一个看起来很顺手的入口。
  `execute_command` 同理：从 `child.stdout.on('data')` 边收边写，别再 `slice` 截断。
- **产物 id 是安全边界**：模型能传参数就能传 `../../`。`artifactPath()` 必须先过
  `/^[a-z0-9-]{6,80}$/` 再拼路径，**任何地方都不要把 `dir` 或真实路径交给模型**（同 `resolveInside`）。
- **验证**：`scripts/verify-output-artifact.mjs`（最后一条就是 >256KB 的回归用例）、`verify-terminal-chat.mjs` 第 3b 节。

### 6.7 数据与文件

**29. 导入 / 导出：zip 是自己实现的，凭据不导出**

- 入口：状态栏左下角菜单 →「导入 / 导出」二级菜单 → `DataTransferDialog`。
- 压缩包结构：一类数据一个 JSON（`hosts.json` / `notes.json` / `api.json`），外壳统一是
  `TransferPayload`（`version` + `kind` + `groups` + `items`）。导入**先写分组再写条目**，条目的 `groupId` 才指得到东西。
- zip 实现是 `services/transfer/zip.ts`（`node:zlib` 的 deflate + 手写 ZIP 头 / 中央目录 / EOCD）。
  **不要引 archiver** —— 它只是 electron-builder 间接带进来的，不是声明依赖。
- ⚠️ **凭据不导出**：主机密码 / 私钥 / 口令是 safeStorage 加密且**绑本机与系统账号**，
  拷到别的机器解不开（`decrypt` 只返回 `undefined`）。导出只带连接元数据，导入后要重新填 —— 别改回带凭据。
- 导入按 id upsert（同 id 覆盖、不同 id 新增），回报「新增 / 更新」条数；涉及的分组与列表都要重新拉，
  否则侧边栏还是旧数据。
- 验证用**双向交叉验证**：我们生成的 zip 用系统 `Expand-Archive` 能解开且内容一致；
  系统 `Compress-Archive` 生成的 zip 用 `readZip` 能读出且内容一致（含 UTF-8 文件名）。

**30. 应用图标一共 4 处，换图时必须同步**

改 `resources/app-icon.png` **不会**自动带动其他三处（否则标题栏、安装包、exe 还是旧图）。

| 文件 | 尺寸 | 用途 |
| --- | --- | --- |
| `resources/app-icon.png` | 985×985 | **唯一真源**。`services/system/icon.ts` 的 `resolveIconPath()` → 窗口 / 托盘 / 通知；打包经 `extraResources` 进安装目录 |
| `build/icon.ico` | 多尺寸 16/24/32/48/64/128/256 | `build.win.icon`，安装包 + exe 图标 |
| `build/icon.png` | 512×512 | electron-builder 默认图标（Linux 目标等未被 `win.icon` 覆盖的场景） |
| `src/renderer/src/assets/app-icon.png` | 256×256 | 标题栏左上角 logo（渲染 20px，200% DPI 下最多用 40px，256 足够） |

- ⚠️ `build/` 下**没有** `icon.icns`，`build.mac` 也没配 `icon` → 出 mac 包会退回 Electron 默认图标。
- 生成多尺寸 ICO 用 Pillow：`Image.save(path, format="ICO", sizes=[(s,s) for s in …])`；
  覆盖产物用 `shutil.copyfile` 先写临时目录再拷过去，别 `os.remove` 旧文件。

**31. cURL 导入的协议头补齐**

- `features/api/api-client.ts` 的 `parseCurl` 在 return 前补：url 不以 `http(s)://` 开头则补 `http://`
  （正则 `/^https?:\/\//i`；已有的 `ftp://` 等原样保留）。
- `--data-binary '@'` 这类「占位 / 空 body」按 cURL 规则**保持 POST**，不要自作主张解析成 GET。

**32. 终端命令记录：PTY 输出没有边界标记，别按「命令→输出」严格配对**

- 命中信号：命令条目的 detail 经常为空 / 相邻两条命令的输出混在一条上。根因：PTY 是裸字节流、无
  shell 集成（无 OSC 133），命令重建只能按控制序列推断；ConPTY/PSReadLine 的回显**迟到且分片**。
- 命令侧：方向键 / Tab 补全 / 光标移动等无法跟进的序列把当前行作废（宁缺毋错），**绝不猜一条没执行过的命令**。
- 输出侧：提交下一条命令就收尾上一条会把迟到输出丢成孤儿 —— `submit` 里上一命令 `pendingRaw.length === 0`
  时**不收尾**（槽位保留等它）；无效行回车不抢占槽位。极速连发时输出整段后移只能接受，以原始文件为准。
- ⚠️ `hostLogger.update(seq, { detail })` 即使 detail 为空 / 与上次相同也会广播 + 落盘一行 —— 回填前先比对
  （纯界面重绘清洗后是空串，直接跳过），否则 host.log 被空 update 撑爆。
- ⚠️ bracketed paste 标记不是所有 shell 都认（Windows PowerShell 5.1 未启用 `?2004h`，合成标记会吞输入）——
  探针里该用例必须放最后（见 5.2）。
- 验证：`scripts/verify-terminal-logging.mjs`。

---

**33. 「目录条目」展开成一大片文件名 = 被用户当成「一堆被修改的文件」**

- **现场**：源码管理面板的「更改」区，用户「明明没有改动」，却列出了很多「被修改的文件」，
  而且这些名字**点不开、也没有 diff**（原话：面板彻底崩了）。
- **根因**：那些名字**不是变更行**，而是**未跟踪目录条目**（嵌套仓库 / 链接目录，`status` 里只有
  `?? sub/` 一行）被展开后从磁盘递归列出来的**只读预览** —— 当时上限 200 条、且没有任何说明文字。
  真实项目里一展开就铺满整屏（实测 `activity-platform` 里嵌着 `activity-platform-app-v2`）。
- **正确做法**：目录条目展开必须①写明「只读、不参与提交」，②限制条数
  （`services/git.ts` 的 `listGitDir` 默认 **20**），③整块用浅色卡片与变更行明显区分。
  ⚠️ 不要因此去掉展开（用户会回头问「为什么点不开」），也不要放宽上限。
- **排查提示**：先分清「更改列表本身」和「某一行展开后的内容」—— `git status --porcelain -uall` 的
  行数才是前者（本次实测外层仓库只有 3 行：`M go.mod` + `?? activity-platform-app-v2/`）。
- **验证**：`scripts/verify-git-changes.ts`（目录条目预览上限 20）。

**34. 导入的 ACP 会话「正文被折进折叠条、复制按钮却复制看不见的文本」= 两处叠加**

- **现场**（用户报告）：ACP 导入的会话里很多消息被折成一行「思考 ×n · 工具调用 ×n」，
  **正文（最终回答）也跟着被折进去**，屏幕上看不到任何输出；折叠条下方却有一个复制按钮，
  复制出来的正是那段看不见的正文。纯思考 + 工具调用（没有正文）的消息整条折叠是**正常**的。
- **根因一（主进程装配）**：`session/load` 回放的「工具调用 → 完成更新」之间可能夹着**下一条消息的正文**
  —— 分段只看 `ContentChunk.messageId`，而 `ToolCall` / `ToolCallUpdate` **协议里就没有 messageId**，
  唯一线索是 `toolCallId`。原来 `pushTool` 一律把结果塞给「当前消息」，于是结果落到新那条消息上，
  渲染端按 `toolCallId` 找不到调用，只能当**孤儿结果**补在末尾 → 那条消息的末尾成了工具。
- **根因二（渲染端折叠）**：`turn-fold.tsx` 的 `findTailStart` 只认「末尾连续正文」，
  末尾不是正文时 `tailStart === units.length`，**整条消息（含正文）**全被折进折叠条。
- **正确做法**：①`services/ai/acp-history.ts` 的 `HistoryAssembler.pushTool` 按 `toolCallId`
  把结果路由回**调用所在的那条消息**（查不到才兜底给当前消息，结果不能丢）；
  ②`findTailStart` 在「末尾不是正文」时退到**最后一个正文块**，它之后的过程留在可见区 ——
  正文绝不能被折进折叠条。两处都要留：①治数据、②保证任何排序下正文都可见（mastra 的轮次也可能末尾是工具）。
- **验证**：`scripts/verify-acp-history.ts`（装配器单测，含「结果不许落到下一条消息」）+ 
  `scripts/verify-agent-acp-import.mjs`（注入 `[思考, 工具, 正文, 工具, 工具]` 断言正文在折叠条**外面**、
  纯工具轮次没有复制按钮）。⚠️ 断言要量「正文在不在折叠体里」（`bar.nextElementSibling`），
  只看 `innerText` 是看不出被折没折的 —— 折叠体收起时内容仍在 DOM 里。

**32. 标签关闭确认是「页面内确认 + emit 关闭」，别改回全局 Modal 或单槽位 guard**

- **触发信号**：给某类标签加关闭确认时不知道往哪加；或关笔记 / Agent 标签只弹「确定关闭标签？」
  通用确认，页面自己的确认（未保存三选一 / Agent 运行中）永远不出现 —— 后者就是单槽位事故的现象。
- **根因（旧实现事故）**：旧 `ui.tabCloseGuards` 是 `Record<tabId, guard>` 单槽位，`TabContentGuard`
  （父组件）与页面（子组件）注册**同一个 tabId** —— React 子组件 effect 先跑、父组件后写，
  页面级 guard 被通用 guard **覆盖成死代码**，而注释还写着「按注册顺序逐一调用」（从未存在过）。
- **正确做法**：关闭走「推送 + 回执」（`shared/lib/tab-event-bus.ts`，总线按 tabId 一条、多 handler）：
  `requestClosePanelTab` 先把标签带到前台（`requestTabCloseVisible`：确认框画在面板内部，
  背景标签不激活就在 `hidden` 面板里，确认框渲染出来也不可见）→ 推 `close-request`，页面 handler
  （`useTabEventBus` 注册）与防手滑 handler 在**标签内部**依次确认，任一 false 即中止；
  全过 emit `close`，经 `setTabCloseExecutor` 注入的回调回到 `closePanelTab`。总线由 `TabContentGuard`
  持有（mount 创建 / unmount 释放）；防手滑只对 `PAGE_MANAGED_CLOSE_TYPES`（note / agent）以外的标签注册，
  避免双重确认。本模块**不反向 import store**（会与 app-store 成环），关闭回执靠 executor 注入。
  确认框本体是 **antd Modal**（`shared/components/InlineConfirm.tsx`）：`getContainer={false}` 内联渲染
  在标签面板里（**别省略它** —— 缺省 portal 到 body，`styles.mask/wrapper` 的 absolute 就会以视口为
  包含块、遮罩盖满整窗），`styles.mask/wrapper` 行内样式把 antd 的 `position: fixed` 压成
  `absolute`，定位基准 = 消费方的 `relative` 根容器。
- **`confirmCloseTab` 是所有关闭确认的总开关**（含页面级）：通用防手滑与笔记「未保存三选一」/
  Agent「运行中」确认都在各自 handler 里读它 —— 关掉后笔记**直接走「不保存直接关闭」**
  （置 `discardingRef` 丢弃草稿、跳过卸载冲刷）再 emit close，Agent 直接放行中断关闭。
  开关只决定「要不要确认」：干净的笔记 / 空闲的 Agent 开着开关也是直接关（没有可确认的状态）。
- **验证**：`npm run typecheck` + 手工清单 —— 通用确认出现在该标签面板内（取消不动 / 关闭生效 /
  其他分屏不受影响）、勾「以后都不再提示」落盘 `confirmCloseTab`、笔记三选一（保存失败不关、
  「不保存」关闭且跳过冲刷）、Agent 流式中确认、右键关背景标签先激活再弹、批量关闭逐个确认且
  取消即中止、接口草稿的程序化关闭不受影响。

## 七、已知限制与待办

- **未实现**：批量命令下发、终端会话恢复（重启后不保留 scrollback）、
  本地终端与远程终端统一的历史搜索。
- **ACP**：
  - agent 未声明 `loadSession` 时，导入的会话**看不到历史**（打开会话即报错，发消息会退回
    `session/new` 并重绑，见 4.18）；这是协议限制，不是可修的实现缺陷。
  - `session/list` 只对**声明了该能力**的 agent 可用；`acp-detect.ts` 的候选表是写死的
    （codex / gemini / claude / copilot / opencode / pi-acp），新 CLI 需要手动添加。
  - 会话页能切换的 ACP 模型**只来自「设置 → ACP agent」里勾选的那份**（`AcpAgentConfig.models`）：
    没去拉取 / 没勾选就没有可切换项（下拉里给一条指向设置页的提示）。这是刻意的 ——
    agent 现场上报的模型列表常混着用不了的档位。
  - 终端 AI 助手**不提供** ACP（它是「一个终端会话一个助手」的形态，没有「绑定某个外部 agent」
    这一层）；ACP 只在 AI Agent 页用（见 1.3）。
- **打包体积后续**（files 白名单失效 + @playwright/mcp 嵌套 playwright 去重已修，安装包 129MB，
  Electron 运行时占 ~100MB 地板）：
  - `vditor` 的 `dist/js` 22MB（highlight 全语言 + mermaid/katex/echarts/abcjs/wavedrom），
    按 `VditorEditor` 实际用到功能裁剪；
  - `ironrdp-wasm` 只有渲染端在用（主进程 `rdp:wasm` 读的是 `out/renderer/rdp/` 拷贝），
    可移到 devDependencies 省掉 asar 里 4MB。
- **mac 打包**：缺 `icon.icns` 与 `build.mac.icon`（见 6.7 第 30 条）。
- **浏览器（Agent 浏览器工具与内嵌面板）**：
  - 偏好 `browserChannel` 只有类型与存储，**设置页还没有选择入口**（目前只能靠 auto 模式兜）。
  - Agent 的浏览器工具**不走确认闸**（`confirm` 模式下点击 / 输入也直接执行）——
    理由是与面板里用户手动点同一个浏览器属同一风险等级，但若之后要收紧，改
    `services/browser/agent.ts` 的 `browser_click` / `browser_type` / `browser_evaluate` 即可。
  - `browser_screenshot` 返回的是**文件路径**（存进工作区 `.dogi/screenshots/`），不是图片内容 ——
    多模态模型要「看图」得另做（当前 `toToolOutput` 会把 base64 截断成废数据）。
- **验证覆盖的空白**：`ask_followup_question`（追问卡）、命令面板、快捷键分发、SFTP 传输取消、
  WebSocket 各帧类型目前**没有**端到端脚本，改动这些区域时优先补脚本或至少手动过一遍。
- **历史脚本已移除**：见 5.2 末尾说明。

---

_本文档记录的是「为什么这么做」，不是「代码长什么样」—— 代码会变，约束背后的原因不会。_
_新增条目时：写清触发信号与验证方式，别只写结论。_
��区域时优先补脚本或至少手动过一遍。
- **历史脚本已移除**：见 5.2 末尾说明。

---

_本文档记录的是「为什么这么做」，不是「代码长什么样」—— 代码会变，约束背后的原因不会。_
_新增条目时：写清触发信号与验证方式，别只写结论。_
