# Dogi — 项目说明与开发约束

面向 AI 编码助手与后来者的工作手册。

> **本文件只放「每轮都可能违反的硬约束」+ 全局索引。**
> 机制说明（第四节）、功能详版（1.3）、验证脚本清单（5.2）、踩坑库（第六节）都在 `docs/` 分册里 ——
> 原稿 16 万字符，超出注入上限（`agent-core/project-doc.ts` 的 64K 字符）会被截断，
> 后面的内容一次也进不了上下文。**动手改某个模块前，先按下面的索引 `read_file` 对应分册。**

## 〇、改什么 → 读哪本

| 你要改的东西 | 先读 |
| --- | --- |
| 终端 / SSH / Mosh / 主机日志 / 编码 / 监控 | `docs/architecture/terminal.md`（4.1、4.12–4.16） |
| AI Agent 引擎、工具、上下文、权限、MCP、子 Agent、ACP | `docs/architecture/agent-core.md`（4.3–4.5、4.18、4.20、4.22–4.24、4.31、4.33–4.40） |
| Agent 界面（侧栏、消息流、文件视图、Git 面板） | `docs/architecture/agent-ui.md`（4.21、4.25、4.27–4.30） |
| 主题首帧 / 技能 / 工作区配置 / 自动更新 / 流式事件归属 / web_fetch | `docs/architecture/app-shell.md`（4.2、4.6–4.8、4.26、4.32） |
| 工作区文件预览 / 插件 / 浏览器 / RDP | `docs/architecture/browser-rdp-plugin.md`（4.9–4.11、4.17） |
| 接口请求（HTTP / WebSocket） | `docs/architecture/api-debug.md`（4.19） |
| 某功能的现状（终端 / 主机 / Agent / 笔记 / 插件各自的完整行为） | `docs/overview.md`（原 1.3 展开版） |
| 构建、依赖版本、主进程生命周期 | `docs/gotchas/build-and-env.md`、`docs/gotchas/main-process.md` |
| 渲染端 UI 细节、数据导入导出 | `docs/gotchas/renderer.md` |
| AI / Agent 的坑（工具入参流式、错误 part、插话、用量…） | `docs/gotchas/agent.md` |
| 「该跑哪个验证脚本」 | `docs/verification.md`（完整清单与用法） |

分册里的条目编号**沿用原编号**（4.x / 5.2、6.x），所以正文与代码注释里的
「见 4.24」「AGENTS.md 6.2 第 7 条」这类交叉引用仍然有效，只是承载位置从根文件搬到了分册。
**新增条目的写法**：写清触发信号与验证方式，别只写结论（这是分册的统一体例）。

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
| 渲染端 | React 19 + TypeScript 7 + Tailwind v4 + **antd 6**（组件库）+ **streamdown**（AI 消息 markdown）+ **lucide-react**（图标） |
| 状态 | zustand（单一 store：`src/renderer/src/stores/app-store.ts`） |
| 终端 | `@xterm/xterm` v6（DOM 渲染）+ `node-pty`（本地）/ `ssh2`（远程）+ `zmodem.js`（rz/sz 传文件） |
| 远程桌面 | `ironrdp-wasm`（IronRDP 编译的 WASM 客户端，画到 canvas）+ 主进程本地桥（WebSocket ↔ TCP/TLS，RDCleanPath 协议） |
| 编辑器 | **Monaco**（代码：接口请求 / 脚本 / Agent 文件面板；本地资源，`scripts/copy-monaco.cjs` 拷到 `public/`）· **Milkdown + Crepe**（笔记 Markdown） |
| AI | Vercel AI SDK v7（openai / anthropic / deepseek / google / openai 兼容）+ `@modelcontextprotocol/sdk`（MCP）+ `@agentclientprotocol/sdk`（外部 ACP agent） |
| 持久化 | `electron-store` + `safeStorage`（凭据加密，Windows 走 DPAPI） |
| 构建 | 自建三配置 Vite（见 3.1），无 electron-vite |
| 打包 | electron-builder（NSIS / dmg / AppImage+deb） |

### 1.3 功能区一览

**活动栏功能区**（`app/activities.tsx`，顺序可拖拽、可隐藏）

| 功能区 | 侧边栏 | 主区域 |
| --- | --- | --- |
| **主机** | 主机列表（分组 / 拖拽 / 颜色）+ 下半区「脚本」分区 | 终端 / SFTP / 远程桌面标签 |
| **AI Agent** | 工作区 → 会话两层树（行首图标表示会话状态，底部「已归档」分组） | Agent 会话页（对话流 + 内嵌终端 + 工作区文件树 / 预览 + 快捷功能） |
| **笔记** | 笔记列表（分组 / 拖拽 / 搜索） | Markdown 编辑器（Milkdown + Crepe）标签 |
| **接口请求** | 请求列表（分组 / 拖拽 / 历史） | HTTP / WebSocket 调试页 |
| **插件管理** | 已安装插件列表 | 插件视图；内置：Redis 客户端、端口占用 |

其余模块：终端 AI 助手（每会话一个）、工作区 Agent（`mastra` / 外部 `acp` 两种形态）、
主机日志面板（全局单例标签）、命令面板、状态栏（监控条 / AI 开关 / 传输托盘）、
数据导入导出。**每块的展开细节见 `docs/overview.md`，机制细节见上表对应的分册。**

几条全局性的、容易踩的事实：

- 会话输出环形缓冲 **256KB/会话**（`MAX_OUTPUT_BUFFER`），标签换父节点时靠回放它恢复画面（4.1）。
- `TERM=xterm-256color` 硬编码 —— 否则远端 ncurses 程序（htop / btop / lazygit）按 8 色渲染成黑白。
- SFTP 与终端拖拽上传的进度**共用**状态栏右下角的传输托盘（`app/layout/TransferTray.tsx`）；
  rz/sz 的 zmodem 进度是终端内的浮层，不进托盘（会话活不过终端重挂载，见 4.1）。
- 主机日志是「记录点在各业务服务、logger 只当汇聚层」的结构（4.13）。

### 1.4 目录地图（只看目录，细节靠 `rg --files`）

```
src/shared/          三端共享的纯类型 / 纯逻辑（不得引 electron、不得引 DOM）
src/main/index.ts    窗口 / 托盘 / 菜单 / 单实例锁
src/main/ipc/        一个通道前缀一个文件（见 3.2）
src/main/services/   按功能域分目录：storage / ssh / terminal / ai / api / browser /
                     sftp / transfer / rdp / log / plugins / system / updater
src/preload/index.ts contextBridge 白名单 + 首帧主题
src/renderer/src/app/       应用装配与外壳（activities.tsx、layout/、面板树、状态栏）
src/renderer/src/features/  每个功能区的 UI + 它专属的纯函数（见 3.3）
src/renderer/src/shared/    复用组件（components/）与复用纯函数（lib/）
src/renderer/src/stores/    全局 zustand store（app-store.ts + types + 几个 helper）
docs/                本手册分册：architecture/（机制）gotchas/（踩坑）verification.md
                     index.html 是 GitHub Pages 项目主页，改文案直接改那个单文件
scripts/             探针 / 验证脚本，不参与构建，也不在 tsconfig 的 include 里
```

- `shared/` 三端共用：`types.ts` 是全部跨端类型，其余按主题拆（`workspace-config.ts`、`acp.ts`、
  `confirm.ts`、`agent-usage.ts`、`context-budget.ts`…）。
- **纯逻辑就别引 electron**：`ai/workspace-health.ts` 是这么写的，所以 `scripts/` 里的验证脚本能裸跑它。

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
- 旧的 `lib/`、`plugins/` 平铺目录**已不存在**；`components/` 还活着，但只剩**一个**跨功能区复用的
  组件（`ExpandButton.tsx`）—— 判定标准仍然是上面的「≥2 个功能区引用」，只有一个文件也该搬进 `shared/`。
  新文件别再往这三个目录放。

### 3.4 UI 一律 antd 6，不要再引入 shadcn / 自绘

- shadcn / radix 已**整体退场**：`src/renderer/src/components/ui/` 不存在，`src` 里没有任何 radix 组件，
  `shadcn`（CLI）、`radix-ui`、`tw-animate-css` 也已从 `devDependencies` 移除（2026-10 清理，当时零引用）。
  ⚠️ 但 **`cn` 这个包留着**：它被全项目 `import { cn } from 'cn'`（并由 `shared/lib/utils.ts` re-export），
  删它等于删全项目工具函数 —— 它不是 shadcn 的残留。
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

## 四、关键机制（索引）

**这一节已全部下沉。** 下面是条目 → 文件的对照表；改动对应模块前 `read_file` 对应分册
（分册内的条目号与下表一致，正文与代码注释里的「见 4.x」引用依然有效）。

| 文件 | 条目 |
| --- | --- |
| `docs/architecture/terminal.md` | 4.1 终端数据链与重挂载回放 · 4.12 Mosh · 4.13 主机日志 · 4.14 平台探测 · 4.15 终端编码 · 4.16 监控不支持态 |
| `docs/architecture/agent-core.md` | 4.3 会话形态与模型 · 4.4 工作区两层 · 4.5 挂起/广播/回填 · 4.18 ACP · 4.20 上下文压缩 · 4.22 两条 AI 线 · 4.23 工具注册表与客户端工具 · 4.24 超长输出落产物 · 4.31 项目约束文档 · 4.33 权限与确认 · 4.34 插话与签出 · 4.35 子 Agent · 4.36 MCP · 4.37 用量统计 · 4.38 插件钩子 · 4.39 命令实时输出 · 4.40 工作区目录巡检 |
| `docs/architecture/agent-ui.md` | 4.21 文件视图 · 4.25 列表与消息流性能 · 4.27 终端标签身份 · 4.28 侧栏状态图标 · 4.29 会话归档 · 4.30 源代码管理面板 |
| `docs/architecture/app-shell.md` | 4.2 流式事件自带归属 · 4.6 首帧主题 · 4.7 技能 · 4.8 工作区配置 · 4.26 自动更新 · 4.32 web_fetch |
| `docs/architecture/browser-rdp-plugin.md` | 4.9 `dogi-ws://` 预览协议 · 4.10 插件 blob import · 4.11 浏览器 · 4.17 RDP |
| `docs/architecture/api-debug.md` | 4.19 请求体四形态 |

---

## 五、验证工具链

### 5.1–5.2 探针怎么跑、跑哪个脚本

- 完整用法见 `docs/verification.md`（5.1 隔离实例 + CDP 的坑、5.2 逐条脚本清单）。**三条最容易白跑的**：
  - 本机常驻着打包版 Dogi → **别杀它**，`--user-data-dir` 起隔离实例，GPU 参数要
    `--no-sandbox --in-process-gpu --disable-gpu-sandbox`；
  - 隔离实例首次 `loadFile` **不提交首帧**（`__store` 就绪但 `#root` 空、控制台无报错）——
    连上先 `bringToFront()` + `Page.reload`，再轮询界面元素；
  - 终端滚轮必须 `Input.dispatchMouseEvent` 真事件，合成 `WheelEvent` 滚不动（监听点不在 viewport 上）。
- 按改动范围挑代表脚本（**全清单见分册**，别凭记忆跑）：

| 你改了什么 | 至少跑 |
| --- | --- |
| 终端 / 会话 / 回放 | `verify-terminal-replay.mjs` `verify-terminal-prediction.mjs` `verify-terminal-logging.mjs` |
| SFTP / 传输 | `verify-sftp-transfers.mjs` |
| SSH / 主机 / 日志 / 编码 | `verify-host-logs.mjs` `verify-windows-host.mjs` |
| RDP / 浏览器 | `verify-rdp-bridge.mjs` `verify-agent-browser.mjs` `verify-builtin-playwright-mcp.mjs` |
| Agent 工具 / 上下文 / 会话 | `verify-agent-file-tools.mjs` `verify-tool-registry.mjs` `verify-output-artifact.mjs` `verify-context-compression.mjs` `verify-agent-acp-import.mjs` |
| Agent 界面 | `verify-agent-outline-scroll-cost.mjs` `verify-agent-list-projection.ts` `verify-agent-file-preview.mjs` |
| 纯函数 / 数据层 | 同名 `.ts` 脚本用 `node --experimental-strip-types` 直接跑，不需要 Electron |

### 5.3 Tailwind 类名必须去产物 CSS 里核对

- **任意透明度值实测不会被生成**：`bg-foreground/[0.04]` 这类写法静默失效 —— 界面上毫无变化，构建也不报错。
- **语义色令牌少一个映射，整族工具类静默消失**：`@theme inline` 里没有 `--color-X: var(--X)` 时，
  `text-X` / `bg-X` 整族都不会生成（实例：`--color-destructive-foreground` 缺失 → 关闭按钮 hover「红底 + 灰字」）。
  用 `node scripts/check-missing-color-utils.mjs` 全量扫描（构建后跑）。
- 类名在 CSS 里是**转义过的**（`.grid-rows-\[0fr\]`），grep 时 pattern 要跟着转义；
  `hover:` 变体类只有 `.hover\:text-x:hover`、没有裸 `.text-x`。

---

### 5.4 文档引用要与代码一致（`check:docs`）

- **每次改动收尾跑 `npm run check:docs`**：它扫 `AGENTS.md` + `docs/**` 里所有反引号引用
  （文件路径 / 包名 / `@shared/*` 别名），逐个对磁盘和 `package.json` 核一遍（`check:colors` 是另一件事，
  它要产物 CSS，得先 build）。
- 为什么要有：这些文档**每轮都注入模型上下文**（4.31），一个过时的文件名会让模型去找不存在的模块。
  文档越写越大，靠人肉复查必然漏 —— 已实测漏过：笔记编辑器写成 Monaco（实际 Milkdown）、
  消息流滚动写成自研 hook（实际 `use-stick-to-bottom`）、打包待办里挂着早已移除的 `vditor`。
- 确属有意留档的旧引用（标了「已移除 / 已删除」，或 `tmp/` 下的探针产物）脚本会跳过；
  其余一律报错，改文档（首选）或加进脚本顶部 `IGNORE`。

---

## 六、踩坑与硬约束（索引）

**这一节也已下沉。** 所有条目都是实测结论（不是推测、不是网上抄的通用建议），
按「触发信号 → 根因/约束 → 正确做法 → 验证方式」组织，**每条都带具体事故背景**。

| 文件 | 条目 |
| --- | --- |
| `docs/gotchas/build-and-env.md` | 6.1 环境与原生依赖（npm install 脚本 / Electron 镜像 / node-pty）· 6.2 构建与 TypeScript（Vite 8 路径 / `baseUrl` 移除 / 别直接 `npx vite build` / electron-builder 平台级 `files` 让顶层白名单失效）· 6.3 依赖 API 版本差异（AI SDK v7 / xterm 6 / antd 6 / Playwright 1.63 / wasm-bindgen） |
| `docs/gotchas/main-process.md` | 6.4 主进程与生命周期（`did-finish-load` 缩放让窗口永不显示 / `windowsHide` 隐藏 GUI 程序 / zustand TDZ / pty 输出早于订阅 / 单实例锁 / BoringSSL keyUsage） |
| `docs/gotchas/renderer.md` | 6.5 渲染端 UI 细节（flex 列宿主 / 折叠横条 / 滚动共用 hook / antd 与 CDP 的静默陷阱 / antd 压过 Tailwind / ResizeHandle 方向 / 边界空格被裁 / 备用屏幕 / 侧栏浮层按钮 / Form.useWatch）· 6.7 数据与文件（zip 自实现 / 应用图标四处 / cURL 导入 / 终端命令记录 / git 目录条目 / ACP 回放折叠 / 标签关闭协议） |
| `docs/gotchas/agent.md` | 6.6 AI / Agent 专项（reasoning 字段丢失 / 兼容网关脏字段 / 历史工具结构 / ACP 权限挂起 / 技能静默失效 / 完成通知 / modelId 落盘 / ACP fs 方法 / Windows POSIX 执行 / 错误 part 可替换 / 工具入参流式 / usage 口径 / 客户端工具必须回填 / 环形缓冲有损 / 插话与钩子顺序 / 会话字段三处登记 / 增量与收口顺序） |

---

## 七、已知限制与待办

- **未实现**：批量命令下发、终端会话恢复（重启不保留 scrollback）、本地与远程统一的命令历史搜索。
- **子 Agent 默认关闭**（4.35）：中间过程界面上看不到；只支持工作区 Agent；只读白名单。
- **会话签出不支持 ACP**（4.34）：消息在外部 agent 手上，导出去是空壳；导出也不含模型配置与凭据。
- **ACP 的协议限制**（4.18）：没声明 `loadSession` 就看不到导入会话的历史；候选 CLI 表是写死的；
  可切换模型只来自设置里勾选过的那份。
- **浏览器**（4.11）：`browserChannel` 设置页还没有入口；Agent 浏览器工具不走确认闸；
  `browser_screenshot` 只给文件路径，多模态要看图得另做。
- **验证覆盖空白**：`ask_followup_question`、命令面板、快捷键分发、SFTP 传输取消、
  WebSocket 各帧类型没有端到端脚本 —— 改这几块优先补脚本。
- **打包体积**：安装包 129MB，Electron 运行时占 ~100MB 地板；
  `ironrdp-wasm` 只有渲染端在用，可移到 devDependencies。
- **mac 打包**：缺 `icon.icns` 与 `build.mac.icon`（见 6.7）。

---

_本文件只放「每轮都可能违反的硬约束」+ 索引。_
_详细机制见 `docs/architecture/`，功能现状见 `docs/overview.md`，_
_踩坑史见 `docs/gotchas/`，验证清单见 `docs/verification.md`。_
_本文档记录的是「为什么这么做」，不是「代码长什么样」—— 代码会变，约束背后的原因不会。_
