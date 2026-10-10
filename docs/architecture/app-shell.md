# 关键机制 · 应用外壳与运行环境

> 本文件是 Dogi 根 `AGENTS.md` 的分册，**条目编号沿用原文档**（4.x / 6.x），
> 所以正文里「见 4.24」「AGENTS.md 6.2 第 9 条」这类交叉引用仍然有效，
> 只是承载位置从根文件搬到了这里。
> 改动对应模块前先读本文件；根 `AGENTS.md` 只有索引与全局硬约束。

---

### 4.2 流式事件必须**自带归属**

- 主进程任何「立即产生事件的路径」都要延迟到 invoke 返回之后（`setTimeout(…, 0)`）。
- ⚠️ 但**光靠 setTimeout 不够**：定时器是宏任务，可渲染端「拿到 invoke 回包 → 建 requestId→会话 映射」
  之间还隔着微任务 + IPC 往返，谁先到不确定。Agent 侧实测事件整条被丢，表现为「转圈永不结束 + 报错不显示 + 通知不弹」。
- 根治：**让事件自带归属** —— `ipc/agent.ts` 在 handler 里登记 `requestId → conversationId`（一定早于定时器），
  广播 `{ requestId, conversationId, event }`，渲染端优先用主进程给的 conversationId 补登记。
  新增任何「按 requestId 路由」的流式功能都照这个来。

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
- **发版**：`package.json` 里 `repository` + `build.publish: [{ provider: 'github', owner, repo }]`。
  本项目的 `dist:*` 全是 `electron-builder --publish never`（只出包，不上传），真正的上传在
  `.github/workflows/build.yml` 的 `softprops/action-gh-release`。
  ⚠️ **该步骤的 `files` 白名单必须包含 `release/latest*.yml` 与 `release/*.blockmap`** ——
  `--publish never` 同样会在 `release/` 里生成 `latest.yml`（这就是打包产物 `app-update.yml`
  要的清单），但 Release 上不挂它就等于自动更新全挂：客户端拉到 tag 后请求
  `<release>/download/vX/latest.yml` 得到 404 → `ERR_UPDATER_CHANNEL_FILE_NOT_FOUND`
  → 被 `error` 事件静默吞掉，用户永远收不到更新（真实事故：v0.0.6–v0.0.15 所有 Release 的
  assets 里都只有安装包）。`*.blockmap` 是增量下载用的，缺了只是每次全量下 ~126MB。
  ⚠️ 顶层 `files` 白名单仍是唯一 matcher（见 6.2 第 9 条），**别在任何平台段加 `files`**。
- ⚠️ **macOS 自动更新要 `zip` 目标**：`MacUpdater` 用 `findFile(files, "zip", ["pkg", "dmg"])`
  找包，只有 `dmg` 会抛 `ERR_UPDATER_ZIP_FILE_NOT_FOUND`；且 Squirrel.Mac 要求包**已签名**，
  本仓库 CI 的签名步骤默认注释掉，所以 mac 侧在自己配好证书前不要对外承诺自动更新。
- **验证**：`scripts/verify-updater-release.mjs`（纯 Node：用 `electron-updater` 自己的
  `GitHubProvider` 打真实 Release，断言能取到清单 —— 改完 workflow 后跑它确认线上可更新）；
  开发态下另一路断言 `updater:status` 通且 `supported: false`、点版本号给明确提示（不报错）。

### 4.32 `web_fetch`：只做 fetch 引擎，长输出走产物机制

`services/ai/web-fetch.ts`（移植自 fishwork 的 `packages/tools/src/web-fetch.ts`），
`scope: 'both'`（只读、无副作用，两条线都能用），注册在 `builtin-tools.ts`。
抓静态 HTML → 抽标题 / 正文链接 → `turndown` 转 Markdown → 返回给模型。

- ⚠️ **刻意不带 fishwork 的 `engine: 'browser'`**：那条分支自己 `playwright.chromium.launch()`，
  而本项目已有整套浏览器基础设施（`services/browser/`：系统浏览器解析、持久 profile、
  内嵌面板、`browser_*` 工具），再引第二套启动逻辑等于把 4.11 的坑（channel / executablePath /
  screencast）复制一遍。**需要 JS 渲染 / 登录态时模型改用 `browser_navigate` + `browser_snapshot`** ——
  工具描述里写明了这条分工，别再加 browser 分支。
- **长输出不落 fishwork 的 `output-log` / `read_log`，走本项目的产物机制**（4.24）：
  `OutputArtifactWriter` + `read_tool_output`（内联给「开头 + 结尾 + 产物 id + 续读参数」）。
- 协议白名单只放 `http:` / `https:`（挡掉 `file:` / `data:` / `javascript:`）；非法 URL、
  抓取失败、已中止**都返回一句能据此改道的话而不是抛错** —— 那是可预期结果，抛错会打断整轮。
- 依赖 `turndown`（`dependencies`，`@types/turndown` 为 devDep）。它�� CJS 的 `export =`，
  在 ESM 产物里靠**动态 import + default 解包**拿构造器；`vite.main.mts` 的 external 规则
  把它留成裸 import，运行时要打进安装包（顶层 `files` 白名单默认含生产 node_modules，
  别为此改 `build.files`）。
- 验证：`scripts/verify-agent-project-doc-web-fetch.ts`（本地 HTTP 服务器真抓）⚠️**已移除**。
