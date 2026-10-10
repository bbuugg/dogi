# 关键机制 · 浏览器 / RDP / 插件 / 预览协议

> 本文件是 Dogi 根 `AGENTS.md` 的分册，**条目编号沿用原文档**（4.x / 6.x），
> 所以正文里「见 4.24」「AGENTS.md 6.2 第 9 条」这类交叉引用仍然有效，
> 只是承载位置从根文件搬到了这里。
> 改动对应模块前先读本文件；根 `AGENTS.md` 只有索引与全局硬约束。

---

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
- 插件的能力按 `manifest.permissions` 声明（`'http'` / `'storage'` / `'fs'` / `'hooks'`），
  **没声明就用不了** —— 主进程侧 `buildMainApi` 的每个能力入口都先 `requireXxx()`。
  其中 `'hooks'`（拦 / 改写 AI 工具调用）见 4.38。
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
