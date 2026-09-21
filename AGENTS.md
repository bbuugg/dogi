# OpsDesk 项目注意事项

本文档记录本项目开发中实际踩过的坑与关键约束，按「触发信号 → 根因/约束 → 正确做法 → 验证方式」组织。改动相关模块前先读对应条目。

## 环境与原生依赖

### 1. node-pty 本地编译依赖

- **触发信号**：`npm install node-pty` 或 `node-gyp rebuild` 报错（本机缺 MSVC / Windows Build Tools）。
- **根因/约束**：node-pty 是需要本地编译的原生模块，安装时需 MSVC 工具链。本机已具备编译条件，直接使用官方 `node-pty`。
- **正确做法**：依赖用 `node-pty`，import 路径 `node-pty`（`src/main/services/terminal/sessions.ts`）。若机器缺编译环境，可回退到 `@lydell/node-pty` 预编译包（仅改 import 与依赖并重装）。
- **注意**：Windows ConPTY 下 `pty.spawn()` 返回的 `pid` 恒为 **0**，这不是错误，不要用 pid 判断进程是否存活，应以 `onExit` 事件为准。
- **验证方式**：`ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe -e "require('node-pty').spawn('cmd.exe',[],{})"` 能收到输出即正常。

### 2. npm 12 install-scripts 安全策略会静默跳过安装脚本

- **触发信号**：安装后 `node_modules/electron/dist/electron.exe` 不存在、esbuild 运行报二进制缺失；npm 输出 `install-scripts blocked` 警告。
- **根因/约束**：npm 12 默认阻止未批准的 postinstall/install 脚本，批准记录写在 `package.json` 的 `allowScripts` 字段。
- **正确做法**：`npm install-scripts approve electron esbuild node-pty ssh2` 后执行 `npm rebuild`；新装原生依赖后检查产物是否存在。
- **验证方式**：`ls node_modules/electron/dist/electron.exe`、`ls node_modules/node-pty/build`。

### 3. Electron 二进制下载需要镜像

- **触发信号**：electron postinstall 报 `TypeError: fetch failed`。
- **正确做法**：`ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/" node node_modules/electron/install.js`，或写入 `.npmrc`（`electron_mirror=...`）。

### 4. Git Bash 下 Windows 命令参数会被转义成路径

- **触发信号**：`taskkill /F /IM electron.exe` 报「无效参数/选项 - 'F:/'」。
- **正确做法**：双斜杠 `taskkill //F //IM electron.exe`，或 `MSYS_NO_PATHCONV=1`。

## 构建与 TypeScript

### 5. 构建编排为自建三配置 Vite，不要引入 electron-vite

- **约束**：用户明确不信任 electron-vite。
- **正确做法**：main = `vite.main.mts`（ESM，`out/main/index.js`）；preload = `vite.preload.mts`（**CJS**，`out/preload/index.cjs`）；renderer = `vite.config.ts`（`root: 'src/renderer'`）。dev 编排在 `scripts/dev.mjs`（vite dev + 双 watch + 自动重启 electron）。
- **原因**：沙箱 preload 只支持 CJS，因此输出必须是 `.cjs`；`package.json` 是 `type: module`，`.js` 会被当 ESM 导致 preload 加载失败。main 用 ESM（Electron 28+ 支持）。

### 6. Vite 8 不再通过 exports 暴露 `bin/vite.js`

- **触发信号**：`require.resolve('vite/bin/vite.js')` 抛 `ERR_PACKAGE_PATH_NOT_EXPORTED`。
- **正确做法**：用 `fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url))` 直接拼路径（见 `scripts/dev.mjs`）。

### 6a. npm workspace 包参与主进程打包必须在 external 里显式放行

- **触发信号**：构建成功但启动报 `ERR_MODULE_NOT_FOUND: Cannot find module '...packages/ai-agent/src/agent' imported from ...src/index.ts`，窗口不出现。
- **根因/约束**：`vite.main.mts` 的 `rollupOptions.external` 判定先于 alias 解析，裸 specifier `@opsdesk/ai-agent` 不匹配任何放行条件 → 被 external 保留为运行时 import；Node 解析到 `src/index.ts` 后其扩展名缺失的相对 import 直接炸。
- **正确做法**：external 判定里加 `!id.startsWith('@opsdesk')`（与 `@shared` 同理）。凡是新增要打进主进程 bundle 的 workspace 包，都要在此放行。
- **验证方式**：`out/main/index.js` 里不应再有 `from "@opsdesk/ai-agent"` 或指向 `packages/` 的 import（`//#region packages/...` 注释是正常的内联痕迹）。

### 7. TypeScript 7 移除了 `baseUrl`

- **触发信号**：`error TS5102: Option 'baseUrl' has been removed`。
- **正确做法**：paths 直接写相对 tsconfig 的路径（`"./src/shared/*"`），三个 tsconfig 均已如此。

### 8. UI 组件统一用 antd，不要再引入 shadcn

- **约束**：项目已彻底移除 shadcn/ui（`src/renderer/src/components/ui/**` 与 `@radix-ui/*`、`radix-ui`、`vaul`、`sonner`、`class-variance-authority`、`clsx`、`tailwind-merge`、`shadcn`、`tw-animate-css` 依赖全部删除），组件一律用 antd 6。
- **正确做法**：新增界面直接 `import { Button, Input, Modal, ... } from 'antd'`。全局通知用 `message` / `notification`（主题与中文由 `AntdProvider.tsx` 的 `holderRender` 接管）；`Select` 用 `options` + `onChange`（不是 `onValueChange`）；`Switch` 用 `onChange`（不是 `onCheckedChange`）；`Textarea` 用 `Input.TextArea`；`ContextMenu` 用 `<Dropdown trigger={['contextMenu']}>`。
- **弹窗/确认一律用 antd 组件**：`Modal` / `Modal.confirm` / `Popconfirm` / `Dropdown` / `message` / `notification` 均可，按交互场景自选（行内小确认用 Popconfirm，居中/危险操作用 Modal.confirm）。**禁止原生 `window.confirm` / `alert`**——原生弹窗不跟随主题且会阻塞渲染进程。
- **保留项**：`index.css` 里的 shadcn 语义变量（`--background/--foreground/--primary/--muted/--border/--sidebar*` 等）必须留着——它们既被全项目的 Tailwind 类名使用，也是 `AntdProvider` 映射 antd token 的来源。
- **插件侧**：宿主通过 `activate(api)` 注入 `api.antd`（antd 全量模块）与 `api.cn`、`api.icons`、`api.MonacoEditor`，插件不得自行 import 依赖。

## 依赖 API 版本差异（升级时必看）

### 9. AI SDK v7 / @ai-sdk/openai v4

- `createOpenAI()` 已无 `compatibility` 选项（v2/v3 有），OpenAI 兼容接口直接传 `baseURL` 即可。
- **`provider(modelId)` 默认走 Responses API（/v1/responses），不是 chat/completions**：第三方兼容网关（Ollama/vLLM/one-api 等）普遍没实现该接口而报 404。需要 Chat Completions 时必须显式 `provider.chat(modelId)`；本项目通过 `AiModelConfig.apiStyle` 切换（见 `ai.ts` 的 `resolveModel`），`openai-compatible` kind 默认 `chat-completions`。
- fullStream 事件字段：`text-delta` 是 `part.text`（v4 是 `textDelta`）、工具是 `input/output`（v4 是 `args/result`）。适配层见 `src/main/services/ai/ai.ts` 的 `adaptPart`。
- fullStream 的 `reasoning` part 同时带累积 `text` 与增量 `textDelta`：下发渲染端必须用 `textDelta`（渲染端自会累积），否则重复拼接。Agent 侧适配见 `packages/ai-agent/src/agent.ts` 的 `adaptAgentPart`，事件 `reasoning-delta` → part `{ type: 'reasoning', text }`；ACP 侧 `agent_thought_chunk` 同样映射为 `reasoning-delta`（见 `src/main/services/ai/acp-agent.ts`）。
- MCP 客户端已不在 `ai` 主包（v4 时代的 `experimental_createMCPClient` 已移除），用官方 `@modelcontextprotocol/sdk` 自行管理（见 `src/main/services/ai/mcp.ts`），工具用 `dynamicTool + jsonSchema` 包装。
- streamText 默认单步，自动工具循环需 `stopWhen: stepCountIs(N)`。

### 10. xterm 6 默认 WebGL 渲染器

- **触发信号**：DOM 里 `.xterm-rows` 的 textContent 始终为空，以为终端没输出。
- **正确做法**：验证终端内容不要读 DOM，走主进程 `recentOutput`（IPC `terminal:recentOutput`）。

## 架构约定与已修复的坑

### 11. 新增会话类型必须同时接通数据转发（教训）

- **事故**：`LocalSession` 的 `proc.onData` 只写了输出缓冲、漏了向 IPC 转发，终端黑屏；SshSession 因构造函数签名强制传 handlers 而幸免。
- **正确做法**：所有 Session 实现的输出/退出必须经 `handlers.onData/onExit` → `sessionManager.emit('data'/'exit')` → `ipc/terminal.ts` 的 broadcast → preload 订阅 → xterm，这条链缺一环就黑屏。新增传输类型（如 telnet、串口）时复制 SshSession 的 handlers 模式。
- **验证方式**：创建会话后调 `window.api.terminal.recentOutput(sessionId)` 应有 shell 提示符。

### 12. 主进程事件可能早于渲染端拿到 requestId（竞态）

- **事故**：AI 无配置时错误事件在 `ipcMain.handle('ai:chat')` 返回 requestId **之前**同步 emit，渲染端因 `activeRequestId` 未设置而丢弃事件。
- **正确做法**：主进程任何「立即产生事件」的路径都要延迟到 invoke 返回之后（`setTimeout(..., 0)`，见 `ai.ts` chat 的无配置分支）。

### 13. zustand create 工厂内引用自身变量会 TDZ 崩溃

- **触发信号**：在 `create()((set, get) => { ... useAppStore ... })` 工厂里读 store 变量 → `ReferenceError`，整棵 React 树卸载。
- **正确做法**：需要在模块作用域暴露 store（如调试 `window.__store`）时，写在 `create(...)` 赋值语句**之后**。

### 14. pty 输出早于渲染端订阅的丢失风险

- **现状**：渲染端在 React mount 后才订阅 `terminal:data`，shell 启动横幅若早于订阅到达会丢失（实测 PowerShell 启动较慢未观察到，但 SSH 快速 banner 有此风险）。
- **正确做法**（如需彻底修复）：渲染端挂载后先调 `terminal:recentOutput` 回放缓冲，再订阅实时事件。

### 15. CSP 严格模式

- renderer 的 CSP 为 `script-src 'self'`（`src/renderer/index.html`），**不允许内联 script**。需要启动前逻辑（如防主题闪烁）时，优先用主进程 `nativeTheme.themeSource`（在创建窗口前设置），不要往 index.html 加内联脚本。

## 验证工具链

- 无 GUI 截图环境时用 CDP 验证：启动加 `--remote-debugging-port=9333`，`curl http://127.0.0.1:9333/json/list` 取页面 WebSocket，`Runtime.evaluate` 驱动 UI。复杂表达式务必写成脚本文件执行（`node -e` 多层转义易错）。
- 旧 Electron 实例会残留并占用调试端口，验证前先 `taskkill //F //IM electron.exe`，以 page id 变化确认是新实例。

### 17. ACP 联调「prompt 挂起」先查权限模式，别怀疑 Web Streams

- **触发信号**：外部 ACP agent（如 SDK 示例 agent.js）在应用里 `session.prompt()` 迟迟不 resolve，主进程日志停在「session ready」。
- **根因/约束**：示例/真实 agent 会在回合中发起 `session/request_permission` 请求并**等待客户端响应**；应用处于 `permissionMode: 'confirm'` 且无人批准确认卡时，整轮 prompt 都不会返回。SDK 的 `ActiveSession.prompt()` 要等回合结束才 resolve，事件队列在此之前只会积压。
- **正确做法**：① 联调用 `permissionMode: 'full'` 或让确认卡自动批准；② `acp-agent.ts` 的 runTurn **不要 await prompt**——先 `session.prompt(text).catch(() => undefined)` 发出，立即用 `session.nextUpdate()` 流式消费（错误同样经 updates 队列由 `nextUpdate()` 抛出），这样权限等待期间 UI 也能看到已产生的文本/工具事件；③ 进程/连接关闭会使 updates 队列 fail，`nextUpdate()` 抛错即可走异常路径。
- **验证方式**：`scripts/verify-acp-e2e.mjs`（run/abort）+ `verify-acp-confirm.mjs`（确认卡广播→批准→回合完成）。
- **已知安全区**：完整 Electron 主进程作为 ACP 客户端 + 纯 Node agent（codex-acp 即此形态）通信正常；仅当 agent 自身也以完整 Electron 运行时协议会挂（真实场景不会出现）。

### 16. did-finish-load 里 setZoomFactor 会让隐藏窗口永不显示

- **触发信号**：构建（`electron .` 加载 out/renderer）后进程在任务管理器里活着，但窗口不出现；dev（`VITE_DEV_SERVER_URL`）一切正常。
- **根因/约束**：窗口是 `show: false` + `ready-to-show` 才 `show()`。`file://` 页面 + 隐藏窗口下，`did-finish-load` 里调 `webContents.setZoomFactor()` 触发的重布局会让首帧永远不产出 → `ready-to-show` 永不触发 → 窗口永不显示。dev 走 `loadURL(http)`，渲染端有 HMR 等后续活动会补触发首帧，所以 dev 掩盖了问题。
- **正确做法**：zoom 复位只放在 ① 窗口创建后（loadFile 之前，无害）；② `ready-to-show` 里 `show()` 之后；③ `did-finish-load` 里仅当 `mainWindow.isVisible()` 时执行（reload 场景）。见 `src/main/index.ts` createWindow。
- **验证方式**：`npm run build` 后 `electron .` 应出现窗口；也可用 Win32 `EnumWindows + IsWindowVisible` 脚本断言主窗口 `visible=True`。
- **排查技巧**：这种"进程在、无窗口"的问题，主进程 stderr 往往完全干净（err.log 空）。给 main 加 `console.error` 诊断事件时序（did-finish-load / ready-to-show / 强制 show）是最快定位手段。

### 18. spawn 外部 GUI 程序时 windowsHide: true 会隐藏窗口

- **触发信号**：`opener.ts` 的 `openFileManagerAt` 返回 `{ ok: true }` 但资源管理器窗口不出现；IDE/外部终端同理。
- **根因/约束**：`windowsHide: true` 会设置 `STARTF_USESHOWWINDOW | SW_HIDE`，explorer.exe 等 GUI 程序会**继承该显示标志**，spawn 成功但新窗口被隐藏（无任何报错）。
- **正确做法**：打开外部 GUI 程序（explorer / IDE / 终端窗口）时不要传 `windowsHide: true`，只用 `{ detached: true, stdio: 'ignore' }` + `unref()`。见 `src/main/services/system/opener.ts` 的 `launch`。
- **验证方式**：调用前后对比 `Get-Process explorer | ? MainWindowHandle -ne 0` 的窗口列表，应有新增窗口（或用 MainWindowHandle 从 0 → 非 0 断言）。
- **注意**：PowerShell 里 taskkill 用单斜杠 `taskkill /F /IM electron.exe`；双斜杠（Git Bash 转义语法）在 PowerShell 下无效、静默失败，导致旧实例残留占用调试端口。

### 19. antd 6 Select 的 options 不再支持 type:'divider'

- **触发信号**：模型下拉（Agent 输入框左下角）里出现一个空白的选项行，Dropdown 菜单里的 divider 则正常。
- **根因/约束**：`type: 'divider'` 是 antd 5.10 给 Select options 加的写法，antd 6 已移除支持，该项会被当作普通 option 渲染（无 value 无 label → 空行）。**Dropdown 的 menu items 里的 divider 仍受支持**，两者别混。
- **正确做法**：Select options 需要分组时用 `{ label: '组名', options: [...] }` 结构（渲染为组头）；不要用 divider。
- **验证方式**：打开下拉，`.ant-select-item-option` 的 textContent 不应有空串；`rg "type: 'divider'" src` 中出现在 Select options 里的都是漏网之鱼（Dropdown menu 里的合法）。

### 20. 脚本没有独立功能区；侧边栏纵向分区统一用 StackedSections

- **触发信号**：想给脚本单加一个活动栏图标、或写 `selectActivity('scripts')` / 找 `SCRIPTS_ACTIVITY_ID` 跳转脚本列表。
- **根因/约束**：脚本只服务于主机，已从活动栏摘除（`SCRIPTS_ACTIVITY_ID` 常量已删除），改为「主机」侧边栏的下半区分区（上半区是主机列表，两区都可独立收起/展开）。折叠状态存在 `ui.collapsedSections`，key 见 `src/renderer/src/app/section-ids.ts`。
- **正确做法**：跳转脚本用 `useAppStore((s) => s.openScriptsSection)`（一次展开「主机功能区 + 侧边栏 + 脚本分区」三层）。侧边栏内任何「上下分区、各自可折叠」的布局都用 `shared/components/StackedSections.tsx`：`<StackedSections>` + `<SectionShell id grow minHeight>` + `<SectionHeader>` + `<SectionContent>`，分区 id 以「功能区.分区名」注册到 `app/section-ids.ts`。
- **空间规则（别改成裸 flex）**：折叠的分区只占标题栏（`shrink-0`，不加 flex 简写），展开的分区 `flex: <grow> 1 0` + `min-height`；这样上面的分区收起时下面的自动上移补位，展开时也压不到 `minHeight` 以下。`SectionContent` 收起时用 `display:none` 而**不卸载**，否则面板里的搜索词、分组展开态会被重置。
- **可拖拽高度**：分区声明 `resizableAbove={上方分区 id}` 后，顶部会多一条横向拖拽条（`SectionResizer`，绝对定位压在边界线上、不占布局高度），拖过的高度写入 `ui.sectionHeights`，此后该分区用 `flex: 0 0 <H>px`（剩余空间全归上方）。拖拽条只在「上下两个分区都展开」时存在——上方收起时下方本就要吃满剩余空间，固定高度反而会留白，所以那种情况下自动回到弹性分配。拖动时 `max = 容器高度 - 上方分区的 inline minHeight`（上方那份数字直接从 DOM 读，别在调用方再传一遍）。
- **验证方式**：收起「主机」分区后脚本分区应紧贴其标题栏下方并占满剩余高度；展开后脚本停在底部且高度不低于 180px（`getComputedStyle` 的 `minHeight`）；拖动两者之间的横线，脚本高度随之变化且上方主机不被压到 200px 以下，收起再展开后高度保持。

### 21. renderer 按功能分层：features / app / shared（别在 components 或根目录堆文件）

- **触发信号**：要新建 `XxxPanel.tsx` / `XxxPage.tsx` / 某个功能专用的工具函数，却不知道放哪；或看到 `src/renderer/src/` 根目录散落着 `activities.tsx`、`section-ids.ts` 这类文件。
- **根因/约束**：历史上组件全部平铺在 `components/`、工具全部平铺在 `lib/`，导致**互不相关的功能区**（主机 / 笔记 / 接口请求…）代码混在一起，改一处要先靠文件名猜归属。现约定三层结构，**每个文件都必须有明确归属**：

  | 目录 | 收录什么 | 判定标准 |
  |---|---|---|
  | `features/<功能>/` | 业务功能的 UI **与**它专属的纯函数/类型 | 只服务某一个功能区，删掉这个功能就没人用 |
  | `app/` | 应用装配与外壳：入口装配、功能区注册表、外层布局、主区域容器 | 不属于任何单一业务功能，是"整个应用"的一部分 |
  | `shared/` | `components/`（复用 UI 组件）+ `lib/`（复用纯函数） | 被 **≥2 个** 功能区引用 |

- **正确做法**（新增文件时按下表放）：
  - `features/hosts/`（HostsPanel、SshProfileDialog、ssh-color.ts）、`features/scripts/`（ScriptsPanel、ScriptsPage、RunScriptDialog、script.ts）、`features/notes/`、`features/api/`（ApiPanel、ApiPage、WsPage、TabButtons、api-client.ts）、`features/agent/`、`features/plugins/`（含 `host.ts` 插件运行时宿主）、`features/terminal/`（TerminalView、terminal-*.ts）、`features/settings/`（含 SettingsDialog）
  - `app/`：`App.tsx`、`activities.tsx`（功能区注册表）、`activity-ids.ts`、`section-ids.ts`；`app/layout/`：ActivityBar、Sidebar、TitleBar、StatusBar、PanelView、CommandPalette、TabCloseConfirm、`pane-layout.ts`（PanelView 的分屏模型）
  - `shared/components/`：AntdProvider、ResizeHandle、StackedSections、MonacoEditor、MonitorBadge、EditorSaveStatus；`shared/lib/`：theme.ts、color-themes.ts、utils.ts、format.ts
  - `stores/app-store.ts`（全局 zustand，跨切面）、`main.tsx` / `index.css` / `assets/` 留在 `src/renderer/src/` 根（入口与静态资源，与 `index.html` 同级是惯例）
  - **判定"要不要进 features"的捷径**：这个模块能不能只用一个功能名来回答"它是干什么的"？能 → 进对应 `features/<名>/`；只能答"整个应用" → `app/`；要列举两个以上功能 → `shared/`。
- **验证方式**：`src/renderer/src/components`、`lib`、`plugins` 三个旧目录**已不存在**（有残留说明又按旧习惯放了文件）；引用一律是 `@/features/...` / `@/app/...` / `@/shared/...`，`rg "@/components/|@/lib/|from '@/activities'" src` 不应有命中。

### 22. 主进程：ipc 按通道前缀拆模块，services 按功能域分目录

- **触发信号**：想往 `src/main/ipc.ts`（已拆除）加通道；或在 `src/main/services/` 下找不到某个服务。
- **根因/约束**：原来单个 `ipc.ts` 堆了 95 个通道、无分组，`services/` 15 个文件平铺也看不出谁与谁同属一个模块。现约定：
  - `src/main/ipc/`：一个模块一个文件，**通道前缀 ≈ 文件名** —— `terminal:*`→terminal.ts、`ai:*`→ai.ts、`agent:*`→agent.ts、`mcp:*`→mcp.ts、`api:*`/`ws:*`→api.ts、`ssh:*`→hosts.ts、`scripts:*`→scripts.ts、`notes:*`→notes.ts、`plugins:*`/`plugin:*`→plugins.ts、`shell:*`→opener.ts、`prefs:*`/`shortcuts:*`/`window:*`/`app:*`/`dialog:open`→system.ts，另有 `shared.ts`（IpcContext 与公共工具）。
  - `src/main/services/`：按功能域分 `terminal/`（sessions、shells、monitor）、`ai/`（ai、agent、acp-agent、acp-detect、mcp）、`api/`（http、ws）、`plugins/host.ts`、`system/opener.ts`；`storage.ts` 留在 services 根 —— 它是被所有域引用的持久化层，塞进任何域都不对。
- **正确做法**：
  - 新增通道 → 在对应前缀的模块里 `ipcMain.handle`；只有**新增模块**时才需要在 `ipc/index.ts` 里加一行 `registerXxxIpc`。
  - 需要广播或读窗口的模块接 `ctx: IpcContext`（`ctx.broadcast(channel, payload)` / `ctx.win()`）；纯请求-响应型模块**不接收参数**。
  - 会话事件的副作用归各自域：数据转发在 terminal.ts、采集生命周期（created→start / closed→stop）在 monitor.ts、AI 实例销毁在 ai.ts。同一个 `sessionManager` 事件被多方订阅是**刻意的**（EventEmitter 多监听器），别为了"集中"再合回一个文件。
  - `main/index.ts` 从 `./ipc/index` 导入（写全，别依赖目录解析）。
- **验证方式**：重构前后通道集合必须完全一致 —— 用同一条正则对比：
  `git show <旧提交>:src/main/ipc.ts` 与 `rg -o "ipcMain\.handle\(\s*'([^']+)'" src/main/ipc` 提取的通道名集合应完全相同（本次为 **95 个，零差异**；⚠️ 必须用 `\s*` 跨行匹配，否则会漏掉写成 `ipcMain.handle(\n  'xxx',` 的那些通道）。改完跑 `npm run typecheck` + `npx vite build -c vite.main.mts`。

### 23. 插件只有一种加载方式：blob import（webview 方式已移除）

- **触发信号**：想给插件加"独立 HTML + preload + vite 构建"的加载方式；或在代码/文档里看到 `plugin:webviewInfo`、`webviewTag`、`build:plugins`、`create:plugin` 这类历史名词。
- **根因/约束**：插件渲染端曾经支持两种入口 —— 字符串（宿主读源码，blob import 执行）与对象 `{ type:'webview', entry, preload }`（插件自行构建 HTML + preload，由 `<webview>` 标签加载）。webview 方式要多维护一整套构建链（插件的 vite 配置、preload 脚本、dist 产物、主题 postMessage 桥），换来的只是"插件用自己的 DOM"，已整体移除。
- **正确做法**：插件渲染端只有一种形态 —— `plugin.json` 里 `renderer: "xxx.js"`（插件目录内的 ESM 源码文件名）。链路是：`pluginHost.getRendererCode()` 读源码 → 渲染端 blob URL 动态 `import` → 调用 `activate(api)` 注册视图。插件**不写 HTML、不写 preload**，界面直接用宿主注入的 `api.antd` / `api.icons` / `api.MonacoEditor` / `api.cn` 编写（见 `features/plugins/host.ts` 的 `RendererHostApi`）。要新增插件，照 `plugins/redis-client/` 的结构写即可（它只有 `plugin.json` + `main.js` + `renderer.js`）。
- **本次一并删除的设施**：`plugin:webviewInfo` 通道与 `window.api.plugins.webviewInfo`、`PluginRenderer` 的联合类型、`PluginViewInstance.renderType/webviewEntry/webviewPreload`、`PanelView` 的 `PluginWebviewTab`、主进程 `webviewTag: true` 与「Toggle Webview Devtools」菜单、`scripts/build-plugins.mjs`、`scripts/create-plugin.mjs`、npm 脚本 `build:plugins` / `create:plugin`。
- **验证方式**：`rg -i webview src scripts plugins` 应零命中（`node_modules/` 与 `out/` 里 monaco 自身的代码除外）；`npm run typecheck` 与三端构建通过；`plugins/redis-client` 能正常打开即为回归通过。

### 24. Agent 是「工作区 → 多个会话」两层；消息只有一份真源

- **触发信号**：要给 Agent 加对话相关能力（历史列表、导出、按会话统计），或发现消息在 store 里有维护两遍的迹象。
- **根因/约束**：侧边栏 `AgentPanel` 是两层结构 —— 工作区（绑定的本地目录）可展开，下面列出它的**会话**（`AgentConversation`）。每个会话有独立的 `messages` 与 agent 上下文。三条硬约束：
  1. **消息只有一份真源**：渲染端 `agentConversations`（含 messages）；`agentRuns: Record<conversationId, AgentRunState>` 只放 streaming / requestId / error。别再往 agentRuns 里塞 messages（旧形态 `agentChats` 就是一份消息两处维护）。
  2. **落盘时机是「发消息时 + 一轮结束（finish / error）时」**，不是每个 token —— 每个 part 都写盘会让长回复反复序列化整段历史。新建的空会话只存在于内存，发出首条消息才写盘。
  3. **ACP 后端的常驻连接按 conversationId 缓存**（`sessions: Map<conversationId, ConversationAcpSession>`，见 `services/ai/acp-agent.ts`）：同一工作区的两个会话必须各有独立 agent 上下文，共用连接会让两个会话串味。`AgentChatRequest` 因此带 `conversationId`。
- **正确做法**：会话 CRUD 走 `agent:conversations:list/save/delete` 三个通道（save 返回**单个**会话，不回传全量 —— 会话带完整历史、体量可能很大）。切工作区用 `selectAgentWorkspace`，它会自动定位该工作区最近更新的会话、一个都没有就现建一个空会话；一切"当前会话"的判断读 `activeAgentConversationId`，不要再用 workspaceId 去索引消息。删除会话 / 工作区前先 `abortAgent(id)` 停掉在跑的请求，否则主进程的 agent 进程会变成孤儿。
- **验证方式**：`rg "agentChats" src` 应无命中；同一工作区开两个会话分别对话，ACP 后端下应看到两个独立的 agent 进程（`disconnect` 一个不影响另一个）；重启应用后会话列表与消息仍在。

### 25. 主题闪烁：preload 在首帧前应用，别用启动画面去遮

- **触发信号**：启动时先看到一帧「默认主题 / 黑色」，再跳成设置里的配色；或者想加启动画面来盖住它。
- **根因/约束**：
  - `index.html` 的 `<html class="dark">` 是静态硬编码，而用户的**明暗与配色主题**（`dark` class / `data-color-theme` / 自定义强调色变量）都要等渲染端 `bootstrap()` **异步**拿到 preferences 后才由 `applyColorTheme()` 应用 —— 这中间就是那一帧跳变。
  - antd 的 token 也不是预设的：`AntdProvider` 用 `readAppTokens()` **现读 CSS 变量**（`useMemo` 依赖 `preferences.colorTheme`），所以 CSS 变量晚一步，antd 组件整体就晚一步。
  - ⚠️ **不要试图用「等主题就绪再显示主窗口」来遮**（试过：主进程建启动画面 + 渲染端报就绪 + 延迟揭示）。它既没解决问题（主窗口显示前的那一帧仍在），又硬给启动加了几百毫秒，还得维护一堆状态标志 + 超时兜底。**要消除，不要遮挡**。
  - ⚠️ CSP 是 `script-src 'self'`，不能往 index.html 塞内联脚本干这件事（见第 15 条）。
- **正确做法**：**preload 在页面脚本之前执行**，这是唯一能赶在首帧前的时机。
  - 主进程 `ipcMain.on('prefs:themeSync')` 用 `event.returnValue` 同步返回 `{ theme, colorTheme, customColor }`（`ipc/system.ts`）。
  - `preload/index.ts` 的 `applyInitialTheme()` 在**模块顶层立即调用**：`sendSync` 取一次偏好 → 按与主进程相同的规则解析明暗（`theme === 'dark'`，或 `system` 且 `matchMedia`）→ `classList.toggle('dark')` + `applyColorTheme(theme, custom, root)`。
  - ⚠️ **`document.documentElement` 在 preload 里是 `null`**：preload 跑在 document_start，此时连 `<html>` 都还没被解析出来。写成 `if (!root) return` 会让整套逻辑**静默失效**（现象就是"改了没用、照样闪"，而主进程那句 `[theme] 首帧主题已交给 preload` 照样打印，很容易误判为已修好）。必须用 `MutationObserver` 盯着 `document` 的子节点，等 `<html>` 一出现立刻补上 —— 观察者回调是微任务，在解析器继续之前执行，仍在首帧之前（实测此刻 `document.readyState === 'loading'`）。
  - 主题的纯逻辑放在 `src/shared/theme.ts`（`customAccentVars` + `applyColorTheme`），因为 preload 够不着渲染端的 `shared/lib/theme.ts`。它**不能引 DOM 类型**（`@shared` 同时被 node 侧 tsconfig 消费、lib 不含 DOM），所以 `applyColorTheme` 的第三参用自定义的 `ThemeElement` 接口；preload 侧另有一份最小 DOM 声明 `src/preload/dom.d.ts`（只声明 `document.documentElement` 与 `window.matchMedia`）。渲染端 `shared/lib/theme.ts` 只是包一层 `document.documentElement` 再 re-export，调用点无需改动。
  - 渲染端的 `initThemeSync` / `applyColorTheme` 保持不变：负责运行中的切换，也是 preload 万一失败时的兜底。
- **验证方式**（两段都要看，只看主进程那句会误判 —— 它只证明偏好交出去了，不证明用上了）：
  1. 主进程：`[theme] 首帧主题已交给 preload： <theme> <colorTheme>`，应出现在「插件加载」日志之前；
  2. preload：用 `$env:ELECTRON_ENABLE_LOGGING='1'` 启动，从 stderr 抓 `[theme] preload 已补应用首帧主题： <theme> <colorTheme> loading` —— **结尾的 `loading` 是关键判据**，`document.readyState === 'loading'` 说明它写在文档解析阶段、首帧之前。缺了这条日志就说明应用那步被 `if (!root) return` 之类挡掉了。
  另外 `rg -i "splash|app:ready|revealMainWindow" src` 应零命中（旧的遮挡方案已整体移除）。
