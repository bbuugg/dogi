/**
 * `@fizz/agent-client` 总入口：API 层 + 宿主契约 + 少量纯工具。
 *
 * 大多数调用点按子路径取更清楚：
 * - `@fizz/agent-client/api`：`createApi()` 与 `Connection`
 * - `@fizz/agent-client/host`：`AgentHost` 契约 + `setAgentHost` / `getAgentHost`
 * - `@fizz/agent-client/web-host`：分发 + 浏览器兜底实现
 *
 * ⚠️ `web-host` 刻意不在根入口 re-export：它会把 `host` 的类型再导出一遍，
 * `export *` 下同名会变成歧义导出。要兜底实现就显式走子路径。
 *
 * 这个包**不许**出现 React / JSX —— 它要能被 CLI、node 脚本和 Electron 主进程直接吃。
 */
export * from './api'
export * from './host'
export * from './download-file'
export * from './terminal-liveness'
