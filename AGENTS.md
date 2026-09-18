# OpsDesk 项目注意事项

本文档记录本项目开发中实际踩过的坑与关键约束，按「触发信号 → 根因/约束 → 正确做法 → 验证方式」组织。改动相关模块前先读对应条目。

## 环境与原生依赖

### 1. node-pty 本地编译依赖

- **触发信号**：`npm install node-pty` 或 `node-gyp rebuild` 报错（本机缺 MSVC / Windows Build Tools）。
- **根因/约束**：node-pty 是需要本地编译的原生模块，安装时需 MSVC 工具链。本机已具备编译条件，直接使用官方 `node-pty`。
- **正确做法**：依赖用 `node-pty`，import 路径 `node-pty`（`src/main/services/sessions.ts`）。若机器缺编译环境，可回退到 `@lydell/node-pty` 预编译包（仅改 import 与依赖并重装）。
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

### 7. TypeScript 7 移除了 `baseUrl`

- **触发信号**：`error TS5102: Option 'baseUrl' has been removed`。
- **正确做法**：paths 直接写相对 tsconfig 的路径（`"./src/shared/*"`），三个 tsconfig 均已如此。

### 8. UI 组件统一用 antd，不要再引入 shadcn

- **约束**：项目已彻底移除 shadcn/ui（`src/renderer/src/components/ui/**` 与 `@radix-ui/*`、`radix-ui`、`vaul`、`sonner`、`class-variance-authority`、`clsx`、`tailwind-merge`、`shadcn`、`tw-animate-css` 依赖全部删除），组件一律用 antd 6。
- **正确做法**：新增界面直接 `import { Button, Input, Modal, ... } from 'antd'`。全局通知用 `message` / `notification`（主题与中文由 `AntdProvider.tsx` 的 `holderRender` 接管）；`Select` 用 `options` + `onChange`（不是 `onValueChange`）；`Switch` 用 `onChange`（不是 `onCheckedChange`）；`Textarea` 用 `Input.TextArea`；`ContextMenu` 用 `<Dropdown trigger={['contextMenu']}>`。
- **保留项**：`index.css` 里的 shadcn 语义变量（`--background/--foreground/--primary/--muted/--border/--sidebar*` 等）必须留着——它们既被全项目的 Tailwind 类名使用，也是 `AntdProvider` 映射 antd token 的来源。
- **插件侧**：宿主通过 `activate(api)` 注入 `api.antd`（antd 全量模块）与 `api.cn`、`api.icons`、`api.MonacoEditor`，插件不得自行 import 依赖。

## 依赖 API 版本差异（升级时必看）

### 9. AI SDK v7 / @ai-sdk/openai v4

- `createOpenAI()` 已无 `compatibility` 选项（v2/v3 有），OpenAI 兼容接口直接传 `baseURL` 即可。
- **`provider(modelId)` 默认走 Responses API（/v1/responses），不是 chat/completions**：第三方兼容网关（Ollama/vLLM/one-api 等）普遍没实现该接口而报 404。需要 Chat Completions 时必须显式 `provider.chat(modelId)`；本项目通过 `AiModelConfig.apiStyle` 切换（见 `ai.ts` 的 `resolveModel`），`openai-compatible` kind 默认 `chat-completions`。
- fullStream 事件字段：`text-delta` 是 `part.text`（v4 是 `textDelta`）、工具是 `input/output`（v4 是 `args/result`）。适配层见 `src/main/services/ai.ts` 的 `adaptPart`。
- MCP 客户端已不在 `ai` 主包（v4 时代的 `experimental_createMCPClient` 已移除），用官方 `@modelcontextprotocol/sdk` 自行管理（见 `src/main/services/mcp.ts`），工具用 `dynamicTool + jsonSchema` 包装。
- streamText 默认单步，自动工具循环需 `stopWhen: stepCountIs(N)`。

### 10. xterm 6 默认 WebGL 渲染器

- **触发信号**：DOM 里 `.xterm-rows` 的 textContent 始终为空，以为终端没输出。
- **正确做法**：验证终端内容不要读 DOM，走主进程 `recentOutput`（IPC `terminal:recentOutput`）。

## 架构约定与已修复的坑

### 11. 新增会话类型必须同时接通数据转发（教训）

- **事故**：`LocalSession` 的 `proc.onData` 只写了输出缓冲、漏了向 IPC 转发，终端黑屏；SshSession 因构造函数签名强制传 handlers 而幸免。
- **正确做法**：所有 Session 实现的输出/退出必须经 `handlers.onData/onExit` → `sessionManager.emit('data'/'exit')` → `ipc.ts` broadcast → preload 订阅 → xterm，这条链缺一环就黑屏。新增传输类型（如 telnet、串口）时复制 SshSession 的 handlers 模式。
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

### 16. did-finish-load 里 setZoomFactor 会让隐藏窗口永不显示

- **触发信号**：构建（`electron .` 加载 out/renderer）后进程在任务管理器里活着，但窗口不出现；dev（`VITE_DEV_SERVER_URL`）一切正常。
- **根因/约束**：窗口是 `show: false` + `ready-to-show` 才 `show()`。`file://` 页面 + 隐藏窗口下，`did-finish-load` 里调 `webContents.setZoomFactor()` 触发的重布局会让首帧永远不产出 → `ready-to-show` 永不触发 → 窗口永不显示。dev 走 `loadURL(http)`，渲染端有 HMR 等后续活动会补触发首帧，所以 dev 掩盖了问题。
- **正确做法**：zoom 复位只放在 ① 窗口创建后（loadFile 之前，无害）；② `ready-to-show` 里 `show()` 之后；③ `did-finish-load` 里仅当 `mainWindow.isVisible()` 时执行（reload 场景）。见 `src/main/index.ts` createWindow。
- **验证方式**：`npm run build` 后 `electron .` 应出现窗口；也可用 Win32 `EnumWindows + IsWindowVisible` 脚本断言主窗口 `visible=True`。
- **排查技巧**：这种"进程在、无窗口"的问题，主进程 stderr 往往完全干净（err.log 空）。给 main 加 `console.error` 诊断事件时序（did-finish-load / ready-to-show / 强制 show）是最快定位手段。
