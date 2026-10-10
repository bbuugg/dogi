# 踩坑库 · 环境 / 构建 / 依赖

> 本文件是 Dogi 根 `AGENTS.md` 的分册，**条目编号沿用原文档**（4.x / 6.x），
> 所以正文里「见 4.24」「AGENTS.md 6.2 第 9 条」这类交叉引用仍然有效，
> 只是承载位置从根文件搬到了这里。
> 改动对应模块前先读本文件；根 `AGENTS.md` 只有索引与全局硬约束。

---

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
  monaco/rdp 与 `out/renderer` 下的拷贝完全重复；当时的笔记编辑器还是 vditor，
  现已换成 Milkdown + streamdown，见 AGENTS.md 1.2）。
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
  从属关系用**顶层分组**表达（模型下拉：每条配置一个分组，组头 = 配置名、组内 = 裸模型 id，
  见 `features/agent/model-options.ts` 的 `configModelGroups`）；`onChange` 也要防御 `undefined`。
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

**14. 依赖清理的判据：只看「有没有 import」，不看「是不是看着眼熟」**

- **触发信号**：升级 / 裁体积 / 换 UI 方案后，`devDependencies` 里攒下一堆零引用的包。
  实测一次清掉 13 个：`cmdk` `tokenlens` `@xyflow/react` `media-chrome` `embla-carousel-react`
  `react-jsx-parser` `react-markdown` `remark-gfm` `nanoid` `motion` `radix-ui` `shadcn`
  `tw-animate-css`（以上 13 个均**已移除**）—— 连带 4000 多行 lock 里的传递依赖。渲染端依赖全靠 Vite 打进产物，
  不进 `dependencies` 就对安装包体积没有贡献，只是让 `npm install` 变慢、让读 package.json 的人误判技术栈。
- **正确判据**：`grep -rn "from '<pkg>'" src plugins scripts` 零命中**且**不是在 `index.css` 里 `@import`、
  不提供命令行二进制、不是某个包的 peer，才算零引用。
- **三类「看着像残留、其实在用」的坑**：
  - `cn`：被全项目 `import { cn } from 'cn'`，是 shadcn 时代的工具函数，UI 库换掉了它没换；
  - `@agentclientprotocol/codex-acp`：`src` 里搜不到，但它提供 `codex-acp` 这个**可执行文件**，
    `acp-detect.ts` 的候选表按命令名找它；
  - `shiki`：只在 CSS 注释里被提到，但 `@streamdown/code` 的代码高亮要它 —— **peer 依赖不能按 import 判**。
- **验证方式**：删完 `npm run typecheck` + `npm run build` 都过，再 `npm install --package-lock-only`
  看 lock 瘦身幅度；跑一条涉及该依赖的验证脚本。文档里的包名用 `scripts/check-doc-staleness.mjs` 核。
