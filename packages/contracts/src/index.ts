/**
 * @fizz/contracts —— 前后端共用的契约层（**浏览器安全**：根入口不得牵入 Node 代码）。
 *
 * 三块内容：
 * - `types.ts` —— 跨包共享的运行时契约（对话流事件 / 工作区 / 会话 / 确认 / 任务）；
 *   各域包自己的类型（ACP / MCP / 技能 / git）在对应包的 `src/types.ts`，这里 type-only 反向引用；
 * - `agent-api.ts` —— HTTP/SSE 端点常量与请求 / 应答 DTO；
 * - `workspace-config.ts` —— 工作区快捷操作配置（含浏览器也要用的归一化函数）。
 *
 * `resolve-model`（AI provider 构造）已迁 `@fizz/agent`、`env`（.env 加载）已迁
 * `@fizz/workspace`、`shells`（shell 探测）已独立 `@fizz/shells`、
 * `workspace`（路径安全）在本包子路径 `./workspace` —— 都是 **Node 专用**代码，
 * 刻意不进根入口：一旦被根入口带出去，渲染端 import 一次 contracts 就会把
 * node:fs / provider 拖进浏览器产物。需要它们的一方走对应包（或本包子路径）。
 */
export * from './types'
export * from './workspace-config'
export * from './agent-api'
export * from './browser'
export * from './system-monitor'
export * from './container-public'
export * from './language'
