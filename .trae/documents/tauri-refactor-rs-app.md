# OpsDesk 重构方案：Electron → Tauri（rs-app）

## Context（背景与目标）

OpsDesk 是一个 AI 驱动的运维终端桌面应用，目前是 Electron + React 19 + antd 6 + Tailwind 4 + zustand。
用户希望用 **Tauri v2（Rust 后端）** 重构，前端栈保持 React + Vite + antd + tailwindcss。

关键结论：
- **渲染层完全可复用**：经全量排查，`src/renderer` 对 Node/Electron 的依赖为 0，全项目仅通过 `window.api.*`（92 处，分布在 11 个文件）访问后端。UI 组件、store、主题、antd 集成均无 Electron 耦合。
- **需用 Rust 重写的全是主进程服务**：PTY/SSH 会话、存储加密、AI 流式、MCP、插件宿主、监控（Phase 1 只做核心那部分）。

已确认的决策（来自用户）：
1. **分阶段交付**：本次只做「核心可运行」——rs-app 工程 + 渲染层复用 + 本地终端/SSH + 配置/偏好/脚本/笔记/快捷键 + 窗口与托盘。AI/MCP/插件/监控留后续阶段。
2. 渲染层：**整体复用 + 顺手重构结构**（拆出 tauri 适配层、抽事件总线、平台信息注入，其余不动）。
3. rs-app：**完全独立选型**，不参考/不读取 rust-app 的 src 业务代码；仅参考同生态的公开标准选型（tauri 2.11 / russh 0.63 / portable-pty 0.9 / reqwest 0.12 / sled / serde）。
4. **保留现有 Electron 工程不动**：根目录 `src/`、`vite.*.mts`、`scripts/`、`package.json`（electron-builder）原样保留，可随时回退与对照。

## 目标结构

```
d:\Workspace\web\owner\shell\rs-app\
├── package.json            # 前端：vite + react + antd + tailwind + @tauri-apps/cli
├── vite.config.ts          # root: 'src/renderer'，端口 5175（strictPort），alias @ / @shared
├── tsconfig.json / tsconfig.node.json
├── src\renderer\
│   ├── index.html          # CSP 与 electron 版一致（script-src 'self' blob:）
│   ├── public\monaco-editor\**   # 从 src/renderer/public/monaco-editor 复制
│   └── src\                # 见下节「渲染层复用方案」
└── src-tauri\
    ├── Cargo.toml          # tauri 2 + 插件 + serde/serde_json + tokio + sled + aes-gcm
    ├── tauri.conf.json     # 无边框窗口、托盘、CSP、Cargo 门面独立选型
    ├── capabilities/default.json
    ├── src\lib.rs          # 注册插件 + 命令 + setup（托盘/单实例/系统主题）
    ├── src\commands.rs     # window.api 手写渠道 → invoke 命令表映射
    ├── src\services\       # 见“Rust 后端服务”
    └── icons\              # 复用 build/icon.ico + resources/app-icon.png 导出
```

说明：rs-app 完全独立选型，但会复用本仓库现成资源（`build/icon.ico`、`resources/app-icon.png`）与**生态标准 crate 选型**（russh、portable-pty、sled、reqwest），避免重复踩网络/编译坑。rs-app 与 rust-app 是互不相干的两套 Tauri 工程。

## 渲染层复用方案

`rs-app/src/renderer/src` 结构（在 electron 版基础上新增 `tauri/` 一层）：

```
src/
├── main.tsx              # 注入平台信息 → 渲染 React → bootstrap()
├── App.tsx / index.css / assets/
├── tauri/                # ★新增：替代 preload 的适配层
│   ├── api.ts            # 构造与 window.api 完全同形的 api 对象（invoke + listen）
│   └── events.ts         # 事件总线：统一订阅/退订 terminal|ai|monitor 事件
├── shared/               # 从 src/shared 迁入（types.ts / plugin.ts / shortcuts.ts）
├── stores/app-store.ts   # 仅改：监听注册收口到 events.ts；插件后端探测保护
├── components/**         # 原样迁入（含 settings/、TitleBar 的平台读取微调）
├── lib/**                # 原样迁入
└── plugins/host.ts       # 原样迁入（后端未实现时安全降级）
```

把 `src/renderer/**` 与 `src/shared/**` 复制到上述位置，然后做**最小必要重构**：

1. **新增 Tauri 适配层** `rs-app/src/renderer/src/tauri/api.ts`：
   - 实现与 `src/preload/index.ts` 完全一致的 `window.api` 结构（命名空间 + 方法）。
   - 每个命令方法：`invoke(cmd, args)` 映射到 Rust 命令；事件订阅（`terminal.data/exit/status/closed` 等）用 `@tauri-apps/api/core` 的 `listen` 封装成 on/off，返回取消函数。
   - `window.api.app.platform` 是**同步常量**（`TitleBar.tsx` 模块加载期读取）：Tauri 平台是异步的。处理：`api.ts` 导出 `syncAppPlatform()`，在 `main.tsx` 里 `await bootstrap()` 拿到 `os.platform()` 后、`render` 之前写入 `window.api.app.platform`。将 `TitleBar.tsx` 对 `platform` 的读取改为「渲染期读取已注好的值」，其余逻辑不动。

2. **抽事件总线**：`app-store.ts` 里散落注册的全局监听（`terminal.on*`、`ai.on*`、`monitor.onData`）统一收口到 `tauri/events.ts`，store 只订阅总线；便于统一退订与测试。Phase 1 只接 terminal 事件。

3. **插件宿主做「可无后端」保护**：`app-store.bootstrap` 里 `loadPlugins()` 与 `host.ts` 依赖 `window.api.plugins.*`。Phase 1 无插件后端 → 在 `api.ts` 里把 `plugins` 命名空间做成**可用性探测分支**：后端未实现时 `plugins.list` 返回 `[]`、其余方法安全 no-op，`loadPlugins` 自然退化为空视图，UI 不报错。后续阶段再填真实现。

4. **ZMODEM**（`api.ts` 提供）：用 tauri 的 `dialog` + `fs` 插件实现 `zmodem.pickFiles/askSavePath/saveFileTo`（替换电子 dialog + fs）。`TerminalView` 的 ZMODEM 逻辑不动。

5. **CSP / 主题**：`index.html` 沿用 electron 版 CSP；`theme.ts` 的 `matchMedia(prefers-color-scheme)` 在 Rust 侧通过 `app` 主题系统 + emit `theme-changed` 推送保持一致（Tauri 侧用 `physicalTheme`/`theme` 事件，见 `lib.rs`）。`AntdProvider`、`index.css`、Tailwind 变量**原样保留**。

## Rust 后端服务（Phase 1）

每个服务对应 Rust 模块，命令名沿用 electron IPC 通道名（如 `terminal:createLocal`、`ssh:save`）。

### 1. `services/storage.rs` — 持久化
- sled 存 JSON；键空间：ssh_profiles / ssh_groups / scripts / notes / prefs / shorts。
- **加密**：`SshProfile.password/privateKey/passphrase`、`AiModelConfig.apiKey` 用本地密钥 AES-GCM 加密入库（keygen 存 `app_data` 下，读写时透明加解密，等价 electron `safeStorage`）。返回给渲染端时置空裸字段、只回 `hasPassword/hasPrivateKey/hasPassphrase`。
- 实现 CRUD + `ssh:arrange` 分组/连接重排（按 `groupIds` 与 `payload.profiles` 的顺序表重建）。

### 2. `services/terminal.rs` — 会话（核心）
- `LocalSession`：`portable-pty`（Windows 走 ConPTY）spawn shell，UTF-8 缓冲 `output`（`MAX_OUTPUT_BUFFER` 保留尾部），提供 `write/resize/kill/recentOutput/outputLength/outputFrom/isReady/exec`。构造时可选 `autoCommand`。terminated → `onExit`。
- `SshSession`：`russh` 客户端，按 `SshProfile` 建链：DNS/TCP → handshake → auth（password / privateKey+passphrase）→ 打开 shell（PTY，`xterm-256color`）。连接阶段经 `SshConnectProgress` 事件上报（`resolving/handshake/authenticating/opening-shell/retrying/ready`），失败按 `maxConnectAttempts`（electron 版=3）退避重试。连接期间收到的 resize 缓存在 desiredCols/Rows，shell 建立后补应用。`keepaliveInterval`、`readyTimeout` 对齐。
- `SessionManager`：单例，管理 id → session，转发 data/exit/status/created/closed；`writeWhenReady`（会话就绪才写，超时/已退出返回 false）；`list` 返回 `SessionInfo[]`。
- **事件推送**：经 `AppHandle.emit(event, payload)` → 前端 `listen`。事件名沿用 `terminal:data/exit/status/created/closed`。

### 3. `services/shells.rs` — 本地 shell 探测
- Windows 探测 PowerShell / pwsh / cmd / Git Bash（常见安装路径）/ WSL；约定 Unix 的 `$SHELL`。返回 `{ shells, defaultId }`，带进程级缓存。

### 4. `commands.rs` — 命令表与事件桥
- 用 `#[tauri::command]` 暴露 Phase 1 全部命令：`terminal:list/listShells/createLocal/createSsh/createFromProfile/write/resize/kill/recentOutput/runScript`、`ssh:*`、`scripts:*`、`notes:*`、`prefs:get/save`、`shortcuts:get/save/capture`、`zmodem:*`。
- `window:minimize/toggleMaximize/close/isMaximized` 按 `has_focus` 桥到主窗口，`window:maximized` 事件 emit。
- `app:info`（version、platform）、`app:openExternal`（`opener`/`open` crate，按 electron 的协议白名单过滤 http(s)/mailto/file）。

### 5. 窗口 / 托盘 / 单实例 / 主题
- `lib.rs setup`：创建无边框主窗口（`decorations:false`，`titleBarStyle` 交给前端自绘），托盘（icon 复用 `resources/app-icon.png`，右键「显示/退出」），`single-instance` 插件，`global-shortcut` + `os` + `dialog` + `fs` + `clipboard-manager` + `process` 插件注册。
- 系统主题：初始化/变更时 `emit("theme-changed", isDark)`；渲染端据此维持 `prefers-color-scheme` 一致。
- F5 拦截（护终端）与 Ctrl+R 透传：Tauri 在 `WindowEvent`/能力层按需处理，方向上保留 electron 版行为（Phase 1 至少保证不拦截终端所需按键）。

### 6. `services/shortcuts.rs` — 全局快捷键
- 读 `shorts` 配置，`global-shortcut` 插件注册/重注册/注销（capture 模式），触发时 `emit("app:shortcut", action)` 并聚焦窗口。

### 7. `services/zmodem.rs`（薄）
- `pickFiles/askSavePath/saveFileTo`：`dialog` + `fs` 插件组合，语义同 electron 版（多选读取字节、先选位置再写）。

## 核心 npm 依赖（rs-app）

- 运行：react/react-dom、antd、@xterm/xterm、@xterm/addon-fit、@xterm/addon-web-links、zmodem.js、@monaco-editor/react、monaco-editor、lucide-react、zustand、react-markdown、remark-gfm、react-dnd(+html5-backend)。**去掉** node-pty、ssh2、electron-store、electron（这些进 Rust）。
- Tauri：@tauri-apps/api@2、@tauri-apps/cli@2、plugin-shell/dialog/fs/os/clipboard-manager/global-shortcut/process/single-instance。
- dev：vite、@vitejs/plugin-react、@tailwindcss/vite、tailwindcss、typescript、@types/react*。

Cargo.toml 选用：`tauri`(features tray-icon,image-png,image-ico,devtools)、`tauri-plugin-shell/dialog/fs/os/global-shortcut/clipboard-manager/process/single-instance`、`serde`/`serde_json`、`tokio(full)`、`sled`、`aes-gcm`/`rand`/`base64`/`sha2`、`uuid`、`chrono`、`russh(ring)`、`portable-pty`、`vte`、`futures`、`regex`、`reqwest(json,stream,rustls)`、`open`。（与 rust-app 相同的生态标准版本，便于命中本地/镜像缓存）

## 硬约束（务必遵守）

- 不读/不抄 `rust-app/src/**` 与 `rust-app/src-tauri/src/**` 业务代码；只参考其公开配置文件做版本/能力参考。
- 现有 Electron 工程文件一律不删除、不修改。
- 渲染层 `window.api` 之外不引入任何 Node 能力；所有后端交互走 Tauri invoke/listen。
- 模态框组件用 antd `Modal`（项目既有规范）；不改 antd/主题体系。
- 密码/secrets 序列化不得明文落盘（AES-GCM 加密）。

## 实施步骤（顺序）

1. **初始化 rs-app 工程**：`create-tauri-app`（或手搭）生成 Vite+TS+React 骨架；写 `package.json`/`Cargo.toml`/`tauri.conf.json`/`capabilities/default.json`/`icons`。
2. **复制并接渲染层**：复制 renderer+shared；新增 `tauri/api.ts`、`tauri/events.ts`；改 `main.tsx`（platform 注入）、`TitleBar.tsx`（读注入值）、`app-store.ts`（走事件总线 + 插件后端探测保护）。先让「无后端也能编译/白屏不崩」。
3. **Rust 命令骨架 + 存储**：storage.rs + commands.rs + `app:info/prefs/ssh/scripts/notes/statics`；`cargo tauri dev` 跑通「读写入库」。
4. **本地终端**：terminal.rs `LocalSession`+`SessionManager`+主命令；前端 TerminalView 走通「打字→回显→resize→退出」。
5. **SSH**：SshSession（russh）+ 连接阶段事件 + 进度卡片；`ssh:save/connect`。
6. **快捷键 + 窗口 + 托盘 + 主题**：补齐 `window:*`、`shortcuts:*`、托盘/单实例、主题推送。
7. **ZMODEM + 收尾**：zmodem 命令；`cargo tauri build` 出可分发产物；核对「未实现后端」no-op 路径不崩。

## 验证

- `cd rs-app && npm install && npm run tauri:dev`：窗口出现（无边框、自绘标题栏可拖拽/缩放/关闭），无控制台报错。
- 本地终端：新建会话后 `window.api.terminal.recentOutput(id)` 含 shell 提示符（对齐 AGENTS.md #10 验证法，不读 xterm DOM）；键入 echo 有回显；Ctrl+滚轮字号生效。
- SSH：保存 profile → 连接 → SSH 连接进度卡片按阶段推进 → ready 后远端提示符出现；断开后重连可用。
- 配置：ssh/scripts/notes/prefs 的增删改查落盘；重启应用数据仍在；密码字段以 `has*` 脱敏回显、库内加密。
- 快捷键：录制、保存、触发 `app:shortcut`。
- 无插件后端：应用照常启动，插件页显示空列表，不报错。
- 旧 Electron 工程未被改动：`git status` 根目录无 src/scripts/package.json 变更。