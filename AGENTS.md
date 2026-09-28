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
内置终端 / SSH / SFTP / 服务器监控 / 接口调试 / 笔记 / 脚本 / 插件宿主，
以及一个能读写文件、执行命令、调用技能的 AI Agent。

### 1.2 技术栈

| 层 | 选型 |
| --- | --- |
| 桌面容器 | Electron 44（`contextIsolation` + preload 白名单 IPC，无 nodeIntegration） |
| 渲染端 | React 19 + TypeScript 7 + Tailwind v4 + **antd 6**（唯一 UI 库） |
| 状态 | zustand（单一 store：`src/renderer/src/stores/app-store.ts`） |
| 终端 | `@xterm/xterm` v6（WebGL 渲染）+ `node-pty`（本地）/ `ssh2`（远程）+ `zmodem.js`（rz/sz 传文件） |
| 编辑器 | Monaco（本地资源，`scripts/copy-monaco.cjs` 拷贝到 `public/`） |
| AI | Vercel AI SDK v7（openai / anthropic / deepseek / google / openai 兼容）+ `@modelcontextprotocol/sdk`（MCP）+ `@agentclientprotocol/sdk`（外部 ACP agent） |
| 持久化 | `electron-store` + `safeStorage`（凭据加密，Windows 走 DPAPI） |
| 构建 | 自建三配置 Vite（见 3.1），无 electron-vite |
| 打包 | electron-builder（NSIS / dmg / AppImage+deb） |

### 1.3 当前功能

**活动栏功能区**（`src/renderer/src/app/activities.tsx`，顺序可拖拽、可隐藏）

| 功能区 | 侧边栏 | 主区域 |
| --- | --- | --- |
| **主机** | 主机列表（分组 / 拖拽 / 颜色）+ 下半区「脚本」分区（可折叠、可拖高） | 终端标签、SFTP 文件管理标签 |
| **AI Agent** | 工作区 → 会话两层树，会话行带状态图标（等回答 / 运行中 / 静止） | Agent 会话页（对话流 + 内嵌终端 + 工作区文件树/预览 + 快捷功能） |
| **笔记** | 笔记列表（分组 / 拖拽 / 搜索） | Monaco 编辑器标签，语言可选 |
| **接口请求** | 保存的请求列表（分组 / 拖拽 / 历史） | HTTP 调试页 / WebSocket 调试页 |
| **自动化** | 自动化脚本列表（分组 / 拖拽 / 搜索，按名称或代码搜） | 脚本页（左 Monaco 编辑器 + 右内嵌浏览器 + 底部运行日志） |
| **插件管理** | 已安装插件列表 | 插件视图（以标签页打开）；内置：Redis 客户端（🔴）、端口占用（🔌） |

**终端**

- 本地终端：`node-pty`，shell 由 `services/terminal/shells.ts` 探测（PowerShell / pwsh / CMD / Git Bash / WSL / bash / zsh / fish…），偏好里可指定默认 shell。
- SSH：`ssh2`，密码或私钥认证，握手阶段进度推送（`resolving → handshake → authenticating → opening-shell → retrying → ready`），失败自动重连。
- Mosh：主机可单独开启（新建 / 编辑主机表单的「使用 Mosh」开关，`SshProfile.useMosh`）—— SSH 只做引导，终端数据走本地 mosh-client 的 UDP；机制与前置条件见 4.12。
- 会话输出环形缓冲 **256KB/会话**（`MAX_OUTPUT_BUFFER`），供 AI 工具按偏移增量读取。
- `TERM=xterm-256color` 硬编码 —— 否则远端 ncurses 程序（htop / btop / lazygit）按 8 色渲染成黑白。
- 每会话独立的 AI 助手（内嵌在终端页底部，可折叠）。
- zmodem：`sz`/`rz` 走系统对话框选文件 / 存文件（`zmodem:*` 三个通道）。
- 终端配色方案、字号缩放、选中即复制、右键粘贴、命令预测（历史补全）等偏好。
- 执行的命令与输出自动记进主机日志（`terminal` 作用域，来源带 [AI] / [脚本] 标记），每会话另有逐字节原始输出文件（见 4.13）。

**主机与运维**

- 主机分组 / 强调色 / 拖拽排序；`kind: 'ssh' | 'local'` 统一建模。
- **SFTP**：浏览、上传文件 / **上传文件夹（递归，目录内每个文件一笔独立传输）**、下载（含目录递归）、远端复制 / 移动、删除 / 新建目录、重命名；进度经 `sftp:progress` 广播到状态栏的传输托盘；用户取消不算错误（`TransferCancelledError`）。
- **传输托盘**（状态栏右下）：结束的任务**不自动移除**（用户要求：完成后留在面板里，由用户逐条 × 或「清除已完成」清理）；已完成的上传 / 下载条目带**「打开文件位置」图标**（`shell:revealPath`：目录直接打开，文件在所在目录中选中；复制 / 移动没有本地侧、已取消 / 失败不给图标）。
- **服务器监控**：经 SSH `exec` 周期采集 `/proc` + `df`（CPU / 内存 / 负载 / 网速 / 磁盘 / uptime），间隔可配（`monitorInterval`）。
- **脚本**：侧边栏分区管理，命令面板可「运行脚本」（有终端直接写入执行，无终端则弹框选主机连上去跑）。
- **主机日志**：SSH 连接（按来源标签分终端会话 / Mosh 引导 / SFTP / SSH 隧道 / 连接测试）、会话就绪 / 关闭 / 断线重试、隧道启停与转发失败、SFTP 连接、主机指纹记录与重置统一记成结构化条目；终端里执行的命令与输出也在内（`terminal` 作用域，机制见 4.13）。

**AI 两条产品线**（共用一套流式事件与渲染组件，别各写一份）

1. **终端 AI 助手**（`AiPanel`）：挂在终端页面，工具作用于当前终端会话 —— `run_in_terminal` / `send_keys` / `read_terminal_output` / `list_terminal_sessions`。
2. **工作区 Agent**（`AgentPage` / `AgentConversationView`）：绑定本地目录，工具为 `list_files` / `find_files` / `search_files` / `read_file` / `write_file` / `edit_file` / `delete_file` / `execute_command` / `read_skill` / `browser_*`（见下），另有工作区文件树与图片 / 视频 / SVG 预览，以及可折叠的**内嵌浏览器面板**（看 Agent 正在操作哪个页面）。

两者共同支持：

- 后端二选一：`ai-sdk`（内置，复用模型配置）或 `acp`（连接外部 ACP agent，如 codex-acp）。
- **模型 / 后端按会话独立**（见 4.3）。
- 权限模式 `full` / `confirm`（确认模式下执行命令前弹确认卡）。
- `ask_followup_question`：AI 在回合中途向用户发**结构化选择题**，答完同一回合继续（见 4.5）。
- **MCP**：任意 stdio MCP server，工具自动合并给 AI。
- **技能（Skills）**：发现 `SKILL.md` 目录，渐进式披露 + `read_skill` 工具按需读（见 4.7）。
- 思考内容（reasoning）与工具调用渲染成**可折叠横条**，不是卡片（见 6.5 第 18 条）。
- 一轮结束且应用不在前台时发系统通知。

**浏览器自动化**（Playwright，机制见 4.11）

- **脚本管理**：脚本列表（分组 / 拖拽 / 搜索）+ Monaco 编辑器；一个脚本 = 一个标签 = 一个浏览器会话。
- **内嵌浏览器**：浏览器**无窗口**跑（headless），画面走 CDP screencast 镜像进面板；面板里的鼠标 / 键盘 / 滚轮再转发回页面，所以「用官方引擎录制」和「画面在面板内」能同时成立。
- **录制**：官方 codegen（`context._enableRecorder({ recorderMode: 'api' })`），操作实时生成 Playwright 代码写进编辑器；停止录制时统一落盘。
- **运行**：逐行执行脚本（`page` / `context` / `browser` / `expect` / `log` 注入作用域），每步与结果广播到底部日志，可中途中止。
- **浏览器来源**：偏好 `browserChannel`（`auto` / `bundled` / `msedge` / `chrome`），auto 按「自带 → Edge → Chrome」逐个尝试启动。
- **Agent 浏览器工具**：`browser_navigate` / `browser_snapshot` / `browser_click` / `browser_type` / `browser_press` / `browser_wait_for` / `browser_evaluate` / `browser_screenshot` / `browser_close`；定位用可访问性快照里的 `[ref=eN]`（`aria-ref` 选择器引擎），页面一变 ref 失效需重新快照。

**接口调试**

- HTTP：方法 / 头（键值对数组，保留空行）/ body、超时、代理、跳过 TLS 校验、手动取消、cURL 导入、请求历史、响应耗时与体积。
- WebSocket：长连接、附加握手头、子协议、`wss` 自签证书、文本 / 二进制帧（base64）、按 `connId` 隔离多标签。
- 与终端同款的多标签 / 分屏；一个请求 = 一个标签（新建即落盘）。

**应用外壳**

- VS Code 式**面板树分屏**（`app/layout/pane-layout.ts`）：向上下左右拆分、拖拽调比例、标签跨组移动、标签条溢出时激活标签自动滚入可视区。
- **命令面板**（`Ctrl+Shift+P`）：命令 / 脚本 / 主机 / 插件的统一入口；插件可注册命令。
- **应用内快捷键**可改（偏好 → 快捷键），带冲突检测。
- 自定义标题栏、状态栏（保存状态 / 监控条 / AI 开关 / 传输托盘 / 左下角全局菜单）、二次确认关闭标签。
- 主题：明暗 + 强调色方案 + 终端独立配色；**首帧不闪**（见 4.6）。
- 托盘常驻、单实例锁、最小化到托盘。
- **数据导入 / 导出**：主机 / 笔记 / 接口请求打包成 zip（自实现，见 6.7）。

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
      ai/                  # ai.ts（终端助手）agent.ts（工作区 Agent）acp-agent.ts acp-detect.ts
                           # mcp.ts skills.ts resolve-model.ts ask-followup.ts
                           # workspace-config.ts workspace-fs.ts workspace-media.ts
                           # agent-core/（工具集 / 系统提示词 / 事件适配 / 路径与忽略规则）
      api/                 # http.ts ws.ts
      browser/             # session.ts（Playwright 会话 + screencast）resolver.ts input.ts
                           # runner.ts（脚本逐行执行）handlers.ts（事件出口）agent.ts（Agent 工具集）
      sftp/ transfer/      # sftp.ts；transfer/（zip.ts + 导入导出编排）
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
      stores/app-store.ts  # 全局 zustand store（跨切面）
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
  `sftp:*`、`scripts:*`、`notes:*`、`api:*`/`ws:*`、`ai:*`、`agent:*`、`followup:*`、`mcp:*`、
  `skills:*`、`plugins:*`/`plugin:*`、`shell:*`、`zmonitor`… `shared.ts` 放 `IpcContext` 与公共工具。
- 新增通道 → 在对应前缀的模块里 `ipcMain.handle`；**只有新增模块**才需要在 `ipc/index.ts` 加一行 `registerXxxIpc`。
- 需要广播或读窗口的模块接 `ctx: IpcContext`（`ctx.broadcast` / `ctx.win()`）；纯请求-响应型模块不接收参数。
- `ipc/index.ts` 里 `registerFollowupIpc` **必须排在 `registerAiIpc` / `registerAgentIpc` 之后**（两者共用一个 broker）。
- 会话事件的副作用归各自域：数据转发在 terminal.ts、采集生命周期在 monitor.ts、AI 实例销毁在 ai.ts。
  同一个 `sessionManager` 事件被多方订阅是**刻意的**（EventEmitter 多监听器），别为「集中」合回一个文件。
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
- 验证：创建会话后调 `window.api.terminal.recentOutput(sessionId)` 应能看到 shell 提示符。

### 4.2 流式事件必须**自带归属**

- 主进程任何「立即产生事件的路径」都要延迟到 invoke 返回之后（`setTimeout(…, 0)`）。
- ⚠️ 但**光靠 setTimeout 不够**：定时器是宏任务，可渲染端「拿到 invoke 回包 → 建 requestId→会话 映射」
  之间还隔着微任务 + IPC 往返，谁先到不确定。Agent 侧实测事件整条被丢，表现为「转圈永不结束 + 报错不显示 + 通知不弹」。
- 根治：**让事件自带归属** —— `ipc/agent.ts` 在 handler 里登记 `requestId → conversationId`（一定早于定时器），
  广播 `{ requestId, conversationId, event }`，渲染端优先用主进程给的 conversationId 补登记。
  新增任何「按 requestId 路由」的流式功能都照这个来。

### 4.3 后端与模型**按会话独立**

- `AgentConversation` 有 `backend?: AgentBackend` + `configId?: string` + `modelId?: string`；
  `configId` 的含义**由 `backend` 决定**（`ai-sdk` → `AiModelConfig.id`；`acp` → `AcpAgentConfig.id`，
  对应下拉里 `acp:<id>` 前缀）。
- 终端 AI 助手按 `sessionId` 存 `AiChatState.configId`（`clearAiMessages` 要**保留**它 —— 清的是消息，不是选中的模型）。
- 请求里带上 `backend` + `configId` + `modelId`，主进程**优先用请求里的，取不到才回退设置里的默认值**；
  会话选的配置被删掉时也要回退，否则该会话直接报「未配置」。
- `aiSettings.activeConfigId` / `activeAcpId` 降级为**新会话的初始值**，设置页那颗星叫「默认」。
- ⚠️ `saveAgentConversation` 判断这两个字段用 **`'configId' in input`** 而不是 `??`：
  落盘时每次显式带上它们，`undefined` 表示「这个会话没选、走默认」，必须能覆盖旧值 ——
  否则从 ACP / 某模型切回默认就永远切不回来。
- `setAgentConversationModel` **不动 `updatedAt`**（配置变更不该让会话跳到列表最前）。
- ACP 常驻连接按 `conversationId` 缓存：同一工作区两个会话必须各有独立 agent 上下文，共用会串味。

### 4.4 工作区 Agent 是「工作区 → 多个会话」两层

- 会话 CRUD 走 `agent:conversations:list/save/delete`；**save 只返回单个会话**，不回传全量（会话带完整历史，体量大）。
- 落盘时机是「发消息时 + 一轮结束（finish / error）时」，**不是每个 token**。
- 切工作区用 `selectAgentWorkspace`（自动定位最近更新的会话，没有就现建一个空会话）；
  「当前会话」一律读 `activeAgentConversationId`，**不要再用 workspaceId 索引消息**。
- 删除会话 / 工作区前先 `abortAgent(id)`，否则主进程的 agent 进程变孤儿。
- ⚠️ 切换功能区**不会**自动打开会话标签（对齐笔记）：只有点侧边栏会话行和新建会话才开标签。
- 会话视图是 **props 驱动**的 `AgentConversationView({ conversationId })`，`AgentPage` 只是薄接线层 ——
  `activeAgentConversationId` 是全局单例指针，多标签并存时只能指向一个，不改成 props 驱动就会两个标签渲染同一会话。

### 4.5 需要用户输入的工具走「挂起 + 广播 + 回填」

- 机制与命令执行确认卡完全相同：`tool.execute` 里挂起 → IPC 广播 → 渲染端渲染卡片 → 用户作答 →
  IPC 回填 resolve → `streamText` **当前回合继续**。
- broker 是全局单例（`ask-followup.ts` 的 `askFollowupBroker`），Agent 页与终端 AI 助手共用一组通道。
- **收尾必须做**（少一步就卡死）：`agent.ts` / `ai.ts` 的 `finally` 与 `abort`、以及 `ai.ts` 的 `dispose`
  都要 `askFollowupBroker.cancel(requestId)`，把挂起的 Promise settle 掉。
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

### 4.11 浏览器自动化：headless Playwright + CDP screencast

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

**录制用官方 codegen**：`context._enableRecorder({ recorderMode: 'api' }, sink)`。

- `recorderMode: 'api'` 才走 `ProgrammaticRecorderApp`（**不弹 Inspector 窗口**）；默认的 `'default'`
  会开一个独立窗口，画面就不在 Dogi 面板里了 —— 这正是「官方引擎录制」和「画面在面板内」能同时成立的原因。
- `hideToolbar: true` 关掉浏览器内的录制浮层（画面已经镜像进面板，再叠一层只会碍事）。
- ⚠️ 这是**未公开 API**（`_` 前缀、不在 types 里）。**升级 Playwright 必须重验两件事**：
  ① `recorderMode: 'api'` 是否仍不弹窗；② `actionAdded(page, action, code)` 的第三个参数是否仍是代码字符串。
- 「停止录制才落盘」是刻意的：录制中每个动作都写一次盘既没必要也写得太频（见 `AutomationPage` 的 `markDirty(true)`）。

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

**会话 id 是主进程与渲染端之间的唯一契约**：自动化面板用 `automation-<scriptId>`（一个脚本 = 一个标签 = 一个会话），
Agent 用 `agent-browser:<conversationId>`。推导函数在 `@shared/browser` —— **别在两端各写一份字符串**，
漂了之后的表现是「帧收不到 / 面板一直转圈」，很难查。

- **事件出口只有一处**：`services/browser/handlers.ts`。会话有两条创建路径（面板的 `browser:open`、
  Agent 工具第一次调用时的懒启动），两条都要把帧推到同一组 `browser:*` 通道；broadcaster 由
  `registerBrowserIpc(ctx)` 注入一次（那时才拿得到 `IpcContext`）。所有事件**自带 sessionId**（见 4.2）。
- ⚠️ **面板必须在「会话首次可用」时补报一次尺寸**：`ResizeObserver` 只在面板**自身**尺寸变化时触发，
  而浏览器常常是别人先启动的（Agent 用默认视口起、或脚本运行里的懒启动）—— 不补报，页面就按旧视口
  比例被压扁、两侧留白。

**脚本执行不用子进程**：`new AsyncFunction('page','context','browser','expect','log', line)` 逐行注入
（`runner.ts`）。逐行模式只在「行内括号自平衡且行尾是 `;` / `}`」时启用，否则整段执行 ——
判定放宽会把多行语句拆坏，宁可整段跑。

**Agent 工具定位用 ref，别让模型拼 CSS 选择器**：`locator.ariaSnapshot({ mode: 'ai' })` 产出带
`[ref=eN]` 的可访问性快照（**公开 API**），回解析用 `page.locator('aria-ref=eN')`（公开选择器引擎）。
ref 只在当前页面状态下有效，页面一变（导航 / 重渲染）就得重新快照。

**验证**（都要跑，见 5.2）：`scripts/verify-automation.mjs`（面板全链路 + 视口预设 + **点击坐标精度**
+ 录制 + 运行）、`scripts/verify-agent-browser.mjs`（Agent 内嵌面板与 id 契约）、
`scripts/verify-agent-browser-tools.mjs`（Agent 工具行为，直接跑 `services/browser/agent.ts` 的真源码）、
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
- 取调试目标**别用 curl**（本机走代理会回 `upstream connect failed`），用 Node 自带 `fetch`。
- 连 CDP 用 `scripts/lib/cdp.mjs`（Node 22 自带 WebSocket，零依赖）：
  `connect()` → `eval()` / `reload()` / `bringToFront()` / `screenshot()` / `report(checks)`。
- **发按键前必须 `bringToFront()`**（`Page.bringToFront` + `Emulation.setFocusEmulationEnabled`），
  否则 reload 之后 keydown 根本不派发。
- **造数据直接 `window.__store.setState(...)`**，别点一串 UI 绕到目标页面；
  切功能区用 `ui: { ...s.ui, activeActivity: 'agent' }`，写完 `sleep(900)` 给 React 一帧。
- **改渲染端后**：`npx vite build --outDir <临时目录>` + `cp -rf` 回 `out/renderer` + `Page.reload`，
  不必重启 Electron。
- **截图要自己 Read 一遍再下结论**：断言只能证明结构，配色 / 对齐 / 图标位置得靠眼睛。
  强制主题：`Emulation.setEmulatedMedia({ features: [{ name: 'prefers-color-scheme', value: 'light' }] })`。

### 5.2 现有验证脚本

| 脚本 | 覆盖 |
| --- | --- |
| `scripts/verify-automation.mjs` | 浏览器自动化全链路：功能区注册 → 新建脚本 → 开标签 → 启动浏览器 → screencast 帧到达渲染端 → **点真实「录制」按钮** → 官方 recorder 产出 `getByTestId` 代码 → **点「停止录制」** → 落盘 → 运行脚本 → 关会话 |
| `scripts/verify-agent-browser.mjs` | Agent 内嵌浏览器面板：工作区/会话准备 → 点工具栏浏览器按钮 → 面板出现且拿到帧（**验证会话 id 契约**）→ 收起面板不关会话 |
| `scripts/verify-agent-browser-tools.mjs` | Agent 浏览器工具行为：**直接跑 `services/browser/agent.ts` 真源码**（本地假站点），覆盖 navigate → ref 点击 → evaluate 验状态 → 中文输入 → press → wait_for → 截图落盘 → close → 关闭后能重建 |
| `scripts/verify-agent-status.mjs` | 会话列表三态图标 + 系统通知三条路径（前台挡下 / 开关关闭 / 最小化后真发出 —— **会真的弹一条通知**） |
| `scripts/verify-agent-file-preview.mjs` | `dogi-ws://` 图片解码、SVG 预览↔编辑、`<video>` 的 206 Range、压缩包提示、`../` 越界 |
| `scripts/verify-quick-actions.mjs` | `.dogi/workspace.json` 自动建目录、脏数据降级、下拉入口与顶栏同排、执行命令开终端、弹窗开关 |
| `scripts/verify-host-logs.mjs` | 主机日志全链路：隔离实例 + 进程内 ssh2 测试服务器 —— SSH 四类来源标签与实时推送（`logs:entry`）、TOFU 指纹、隧道强断（error 级）/ 改名重启 / 停止、SFTP 失败路径、JSONL 落盘与清空归零、面板单例标签 / 过滤 / 搜索 |
| `scripts/verify-sftp-transfers.mjs` | SFTP 上传文件夹 + 传输托盘：进程内假 SFTP 服务器（ssh2 服务端事件式 API，见下方 ⚠️）——「上传 → 上传文件夹…」逐层 MKDIR + 每文件 WRITE（内容比对）、3 笔独立传输落 store（含 `localPath`）、完成条目 6.5s 后仍在（不自动移除）、上传 / 下载带「打开文件位置」/ 已取消不带、`revealPath` 错误路径 `ok:false`、清除已完成清空且入口消失。⚠️ 会真实弹出一次系统文件管理器 |
| `scripts/verify-port-killer.mjs` | 端口占用插件全链路：插件播种/视图注册 → 探针 spawn 的 node 子进程真占随机端口 → 查询命中（PID / 进程名 / 监听中）→ 行内复制命令（`killCommand` 平台格式）→ **Popconfirm 真杀**（子进程退出 + 端口连接被拒 + 自动复查为空）→ 保护/校验分支（kill PID 1 / 非法 / 不存在、search 70000）→ **UDP 占用**（netstat UDP 行没有状态列）→ 重新查询 |
| `scripts/verify-terminal-logging.mjs` | 终端命令 + 输出记录：命令装配（普通 / 退格 / Ctrl+C / 不可还原行不记 / bracketed paste）、`[脚本]` 来源标记、输出增量回填同一条目、原始会话文件（含未记录命令的裸输出）、关闭条目、JSONL 同 seq 多行、面板终端过滤、清空连 `sessions/` 归零。⚠️ bracketed paste 用例必须放最后：部分 PowerShell（如本机 5.1）未启用 `?2004h`，合成标记会吞掉后续回显 |
| `scripts/verify-terminal-prediction.mjs` | 终端命令预测：CDP 真键盘注入（先点终端给 xterm 焦点）——未输入无下拉、「键入 git → 'git status' 行渲染宽度带空格」、「前缀以空格结尾 → 仍带空格」、`→` 接受 → 下拉收起 + PTY 回显补全后的 `git log`、备用屏幕（tmux / vim）里按 `d` 不弹（见 6.5 第 25 条）。⚠️ 防的是 flex 子项边界空格被裁的坑（见 6.5 第 24 条）：断言必须量渲染宽度，`textContent` 测不出来 |
| `scripts/verify-skills.mjs` | 技能发现（含 junction 安装）、无 frontmatter 退化、额外根目录、设置页渲染与开关落盘 |
| `scripts/check-missing-color-utils.mjs` | 扫描产物 CSS，找出「语义色令牌漏映射导致整族工具类没生成」 |
| `scripts/shot-titlebar.mjs` | 强制 hover 截图 + 计算样式，查标题栏配色 |
| `scripts/browser-input.test.ts` | 浏览器面板的坐标映射纯函数（`object-contain` 留白 / 画面矩形 / 黑边丢点 / 滚轮）。**能直接跑**：`node --experimental-strip-types scripts/browser-input.test.ts`（被测文件只有 type-only import，不需要 `.tooltest` 包装） |

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

⚠️ `verify-port-killer.mjs` 里「被占用的端口」都是**探针自己 spawn 的 node 子进程**（TCP 监听 / UDP 绑定）：
结束时杀的是这个子进程，能拿准退出码、且伤不到任何真实服务 —— **永远不要拿宿主或系统进程当靶子**。
「权限不足 → 弹管理员命令弹窗」分支需要真实高权限进程才能触发（如 SYSTEM 进程），自动化里不制造，
只覆盖命令生成（`killCommand`）与受保护 PID（kill PID 1）分支。

⚠️ 跑浏览器相关脚本时，**DOM 里可能同时存在多个 `alt="浏览器画面"` 的 `<img>`**（历史遗留的隐藏面板）。
按 `querySelectorAll` 取第一个会命中隐藏的那个（rect 为 0），断言全落空 ——
`verify-automation.mjs` 开头会先关掉遗留的 automation 标签，取 img 时也要挑 rect 非零的那个。

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

### 6.3 依赖 API 版本差异（升级时必看）

**9. AI SDK v7 / `@ai-sdk/openai` v4**

- `createOpenAI()` **已无 `compatibility` 选项**（v2/v3 有），兼容接口直接传 `baseURL`。
- ⚠️ **`provider(modelId)` 默认走 Responses API（`/v1/responses`）**，不是 chat/completions ——
  第三方兼容网关（Ollama / vLLM / one-api）普遍没实现而报 404。要 Chat Completions 必须显式 `provider.chat(modelId)`；
  本项目通过 `AiModelConfig.apiStyle` 切换，`openai-compatible` 默认 `chat-completions`。
- fullStream 字段：`text-delta` 是 `part.text`（v4 是 `textDelta`）、工具是 `input`/`output`（v4 是 `args`/`result`）。
  适配层在 `services/ai/ai.ts` 的 `adaptPart` 与 `agent-core/agent.ts` 的 `adaptAgentPart`。
- ⚠️ **思考内容的增量在 `part.text`**（不是 `textDelta`，也不是 `delta` —— 只有 `UIMessageChunk` 才用 `delta`）。
  `reasoning-start` / `reasoning-end` 只是起止标记、不带内容；**不存在 `type: 'reasoning'` 这种 fullStream part**，
  写错不会报错，思考内容会被静默丢弃。
- MCP 客户端已不在 `ai` 主包（`experimental_createMCPClient` 已移除），用官方 `@modelcontextprotocol/sdk`
  自行管理（`services/ai/mcp.ts`），工具用 `dynamicTool` + `jsonSchema` 包装。
- `streamText` 默认单步，自动工具循环需要 `stopWhen: stepCountIs(N)`。

**10. xterm 6 默认 WebGL 渲染**

- DOM 里 `.xterm-rows` 的 textContent 始终为空是正常的（不是没输出）。
  **验证终端内容不要读 DOM**，走主进程 `recentOutput`（IPC `terminal:recentOutput`）。

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

**12. Playwright 1.63（浏览器自动化，机制见 4.11）**

- ⚠️ **`headless: true` 默认走 `chromium-headless-shell`**（与完整 Chromium 是两个 build），
  它不保证提供 screencast，画面会是黑的 → 自带 Chromium 必须写 `channel: 'chromium'`。
- ⚠️ **`chromium.executablePath({ channel })` 忽略 channel 参数**（实测永远返回自带 Chromium 的路径），
  拿它判断系统浏览器装没装会得到错误答案 → 系统浏览器自己探安装路径。
- **自带 Chromium 未下载时 `launchAttempts` 会把它从候选里剔除**：Playwright 会抛
  「Executable doesn't exist」而不是自动跳过，留着只会多一次失败往返。
  本机 `~/AppData/Local/ms-playwright` 里缓存的版本号与 1.63 期望的（chromium-1243）**可能不匹配**，
  此时 auto 模式会回退到系统 Edge / Chrome —— 这是正常的，不是 bug。
- `context._enableRecorder` 是**私有 API**（升级必须重验，见 4.11）；而
  `locator.ariaSnapshot({ mode: 'ai' })` 与 `page.locator('aria-ref=eN')` 是**公开 API**，可以放心用。
- 安装时用 `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`（项目不依赖自带 Chromium，优先用系统浏览器）。

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

- **单实例锁**：已有一个 Dogi 在跑时，新进程直接退出并把已有实例调到前台。打包版与 dev 的 userData 不同，互不影响。
- **托盘**：关闭窗口默认隐藏到托盘（`preferences.minimizeToTray`），`before-quit` 才置 `isQuiting` 让窗口真关。
  退出时 `will-quit` 要 `tray.destroy()`，否则托盘图标残留。
- **菜单**：自定义菜单刻意**去掉 zoom 角色**，否则 Ctrl +/-/0 会缩放整个页面并抢在渲染端之前触发；
  Reload / Force Reload **不注册加速键**（Ctrl+R 必须透传给终端：vim 的 redo、readline 反向搜索都靠它）；
  F5 在 `before-input-event` 里拦掉（会毁掉终端会话）。
- **凭据只在主进程解密**：`storage.getSshProfile` 返回明文，渲染端永远拿不到；列表接口只给 `hasPassword` 这类脱敏标记。

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

**20. antd 组件与 CDP 脚本的三个静默陷阱（写验证脚本时必踩）**

- **antd 会给恰好两个汉字的按钮中间插空格**（`关闭` 的 `textContent` 是 `关 闭`）——
  按 `textContent === '关闭'` 找按钮永远找不到，而 `if (btn)` 会把「没点到」静默咽掉。**比对前先去掉空白。**
- **合成事件关不掉 antd 下拉**：`document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))` 实测无效。
  关不掉的后果是后面切换工作区时，旧标签那个**已展开的下拉仍留在 DOM 里**（`offsetParent !== null`），
  数菜单条目时把两层一起数进来 → 断言假 FAIL。正确姿势：Dropdown 的 `trigger=['click']` 是开关，**再点一次触发器**。
- `console.log('文案：', value)` 多参数之间会**插一个空格**，脚本里别按整句比对。

**21. antd 的 cssinjs 压过 Tailwind：给 antd 组件写宽度类会被静默吃掉**

- **根因**：antd 6 的样式是运行时注入的 cssinjs，**不在 `@layer` 里**，优先级高于 Tailwind 的
  `@layer utilities`。所以 `<Input className="w-56" />` 里那个 `w-56` **不生效也不报错** ——
  `.ant-input { width: 100% }` 直接把它压掉。
- **踩坑现场**：自动化脚本页的起始地址栏原本写的是 `<Input className="w-56 shrink-0" />`，
  实测计算宽度 **951px**（不是 224px）。它又带 `shrink-0`（不许被压缩），于是整条工具栏被顶出容器：
  溢出 190px，右侧「保存 / 录制 / 运行」按钮组整个跑到可视区外，**用户直接看不到按钮**。
- **正确写法**：宽度交给**外层 div**，别写在 antd 组件上。
  ```tsx
  <div className="w-56 shrink-0">
    <Input size="small" className="text-xs" />
  </div>
  ```
- **同类风险的判定**：不是所有 antd 组件都这样。`Select` 实测 `className="w-28"` 是 **112px = w-28，正常生效** ——
  因为 antd 没有给 `.ant-select` 根节点设整体 `width`。**只有那些 antd 自己写了 `width: 100%` 的组件
  （`Input` / `Input.TextArea` 等）才会被压掉**。改之前先用 CDP 读一次 `getBoundingClientRect().width` 实测，别猜。
- **回归**：`scripts/verify-automation.mjs` 已固化三条断言（工具栏无横向溢出 / 所有控件都在工具栏内 /
  起始地址栏宽度等于 224px），改工具栏布局时它们会拦住这类回归。
- 顺带记一条 antd 6 的结构变化：`Select` 的边框画在根节点 `.ant-select` 上，内层是 `.ant-select-content`
  （`border-width: 0`），**antd 5 的 `.ant-select-selector` 已经不存在** —— 照旧写法改它不报错也不生效。

**22. `ResizeHandle` 的方向 —— 受控面板在右侧时必须 `invert`**

- 拖拽条自己的逻辑：`delta = clientX - startX`（不动方向）。视觉上「往右拖 = 拖拽条右边的面板变宽」。
- `invert = true` 时取相反数，意思是「往左拖 = 右边的面板变宽」。
- 规则：**分隔条左边的面板用 `invert={false}`**，**右边的面板用 `invert={true}`**（浏览器面板在分隔条右侧，
  往左拖才是把它拉宽）。
- 用户报告「拖动改变宽度方向反了」就是这个：自动化页一开始没传 `invert`，鼠标往右拖面板反而变窄，
  体验像坏了。`scripts/verify-automation.mjs` 已固化两条断言（往右拖变小、往左拖变大）—— 改拖拽行为时
  它会拦住回归。
- `ResizeHandle` 还用在侧边栏宽度（`app/App.tsx`）、Agent 页（`agent/AgentPage.tsx`）等多处；
  验证脚本**不能** `document.querySelector('[title="拖动调整宽度"]')` 一把抓，否则命中的可能是旁人的
  那个（实测踩过 —— 跑出来 pane 是 991 / editor 是 288，比例 3.44，根因就是选错了侧边栏的把手）。
  从「录制」按钮反推到 AutomationPage 根，再在根内 query —— `scripts/verify-automation.mjs` 的
  `SPLIT_HANDLE` 是这写法。

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

### 6.7 数据与文件

**27. 导入 / 导出：zip 是自己实现的，凭据不导出**

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

**28. 应用图标一共 4 处，换图时必须同步**

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

**29. cURL 导入的协议头补齐**

- `features/api/api-client.ts` 的 `parseCurl` 在 return 前补：url 不以 `http(s)://` 开头则补 `http://`
  （正则 `/^https?:\/\//i`；已有的 `ftp://` 等原样保留）。
- `--data-binary '@'` 这类「占位 / 空 body」按 cURL 规则**保持 POST**，不要自作主张解析成 GET。

**30. 终端命令记录：PTY 输出没有边界标记，别按「命令→输出」严格配对**

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

## 七、已知限制与待办

- **未实现**：批量命令下发、终端会话恢复（重启后不保留 scrollback）、
  本地终端与远程终端统一的历史搜索。
- **mac 打包**：缺 `icon.icns` 与 `build.mac.icon`（见 6.7 第 28 条）。
- **浏览器自动化**：
  - 偏好 `browserChannel` 只有类型与存储，**设置页还没有选择入口**（目前只能靠 auto 模式兜）。
  - Agent 的浏览器工具**不走确认闸**（`confirm` 模式下点击 / 输入也直接执行）——
    理由是与面板里用户手动点同一个浏览器属同一风险等级，但若之后要收紧，改
    `services/browser/agent.ts` 的 `browser_click` / `browser_type` / `browser_evaluate` 即可。
  - `browser_screenshot` 返回的是**文件路径**（存进工作区 `.dogi/screenshots/`），不是图片内容 ——
    多模态模型要「看图」得另做（当前 `toToolOutput` 会把 base64 截断成废数据）。
  - 自动化标签的关闭**没走** `preferences.confirmCloseTab` 的二次确认（走的是 `closePlainTab`）。
- **验证覆盖的空白**：`ask_followup_question`（追问卡）、命令面板、快捷键分发、SFTP 传输取消、
  WebSocket 各帧类型目前**没有**端到端脚本，改动这些区域时优先补脚本或至少手动过一遍。
- **历史脚本已移除**：见 5.2 末尾说明。

---

_本文档记录的是「为什么这么做」，不是「代码长什么样」—— 代码会变，约束背后的原因不会。_
_新增条目时：写清触发信号与验证方式，别只写结论。_
