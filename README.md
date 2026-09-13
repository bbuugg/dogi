# OpsDesk — AI 运维终端

基于 Electron + React 的运维工具，第一阶段提供终端能力：本地终端、SSH 连接管理（增删改查）与 AI 助手（可直接操作终端）。

## 功能

### 终端
- **本地终端**：基于 `@lydell/node-pty`（预编译 PTY，Windows 下默认 PowerShell）
- **SSH**：基于 `ssh2`，支持密码 / 私钥认证，keepalive、多会话
- **多标签**：基于 `@xterm/xterm`（v6），xterm 6 默认 WebGL 渲染
- 会话输出环形缓冲（256KB / 会话），供 AI 与调试读取
- **主题**：跟随系统 / 亮色 / 暗色（设置 → 偏好），基于 Electron `nativeTheme.themeSource`，终端配色同步切换

### AI 助手
- 基于 **Vercel AI SDK v7**：支持 OpenAI / Anthropic / DeepSeek / Google / 任意 OpenAI 兼容接口（Ollama、vLLM、中转网关）
- 多套模型配置随时切换（AI 面板顶部下拉）
- AI 通过内置工具操作终端：`run_in_terminal` / `read_terminal_output` / `list_terminal_sessions`
- **MCP 支持**：接入任意 stdio MCP server（官方 `@modelcontextprotocol/sdk`），工具自动合并给 AI
- 安全开关：「AI 自动执行终端命令」可在设置中关闭（关闭后 AI 只读）
- 自定义系统提示词

### 安全
- SSH 密码 / 私钥口令使用 Electron `safeStorage`（Windows DPAPI）加密存储
- 渲染进程与主进程隔离（contextIsolation + preload 白名单 IPC）
- 密钥类字段在列表接口中脱敏（`hasPassword` 等标记）

## 开发

改动 Electron / 原生模块相关的注意事项与踩坑记录见 [AGENTS.md](./AGENTS.md)（node-pty 预编译、npm install-scripts、CDP 验证方法等）。

```bash
npm install          # 安装依赖
npm run dev          # 开发模式（Vite dev server + main/preload watch + Electron 自动重启）
npm run build        # 类型检查 + 全量构建（out/）
npm run start        # 运行已构建产物
npm run typecheck    # 仅类型检查
```

> 注意：项目使用 npm 12 的 install-scripts 安全策略，首次安装后如提示脚本被阻止：
> `npm install-scripts approve electron esbuild node-pty ssh2`，再 `npm rebuild electron node-pty esbuild`

## 架构

```
src/
  shared/types.ts       # 三端共享类型
  main/                 # Electron 主进程
    index.ts            # 窗口创建 / 生命周期
    ipc.ts              # IPC 通道注册
    services/
      sessions.ts       # 会话管理（node-pty 本地 + ssh2 远程，统一抽象）
      storage.ts        # electron-store 持久化 + safeStorage 加密
      ai.ts             # AI SDK v7 多模型 + 终端工具
      mcp.ts            # MCP 客户端管理（stdio）
  preload/index.ts      # contextBridge API（全量类型化）
  renderer/             # React + Tailwind v4 + shadcn/ui + zustand
    src/components/     # Sidebar / TerminalTabs / TerminalView / AiPanel / 设置
```

构建不依赖 electron-vite，使用三个独立 Vite 配置自建编排：

| 目标 | 配置 | 输出 |
| --- | --- | --- |
| main（ESM） | `vite.main.mts` | `out/main/index.js` |
| preload（CJS，沙箱兼容） | `vite.preload.mts` | `out/preload/index.cjs` |
| renderer | `vite.config.ts` | `out/renderer/` |

## AI 模型配置示例

设置 → 模型配置 → 新建：

| 服务商 | Base URL | 模型示例 |
| --- | --- | --- |
| OpenAI | 留空 | `gpt-4o` / `gpt-5.1` |
| Anthropic | 留空 | `claude-sonnet-4-5` |
| DeepSeek | 留空 | `deepseek-chat` |
| Google | 留空 | `gemini-2.5-pro` |
| OpenAI 兼容 | `http://localhost:11434/v1`（Ollama） | 服务端模型 ID |

## 后续规划

- SFTP 文件管理、端口转发、批量命令下发
- AI 命令执行前人工确认（human-in-the-loop）
- 终端分屏、会话恢复
- electron-builder 打包（安装包）
