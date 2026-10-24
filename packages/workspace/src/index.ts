/**
 * @fizz/workspace：领域与存储层，TS 源码直接导出（与 contracts / agent 等同一模式）。
 *
 * 三块内容：
 * - `store.ts` —— JsonStore 持久化（数据目录 `FIZZ_DATA_DIR`，缺省 `~/.fizz-server`）
 *   与 SecretBox 密钥盒；
 * - `domain.ts` —— AgentDomain：工作区 / 会话 / 模型 / ACP agent / MCP server /
 *   技能设置的领域操作（内存态 + 落盘）；
 * - `trigger-domain.ts` —— TriggerDomain：定时任务的规则存储（与 AgentDomain 并列、共用同一个 store）；
 * - `assistant-store.ts` —— 项目管理助手的会话持久化（一实体一文件,不进会话树）。
 */
export { JsonStore, SecretBox, resolveDataDir, newId } from './store'
export type { CoreData, StoredSshHost } from './store'
export { AgentDomain } from './domain'
export type { ResolvedSshHost, PluginModelEntry } from './domain'
// 数据导入 / 导出：外壳解析与文件名 ↔ 类型的对应（服务端路由用它拆包，界面用它认文件）
export {
  ALL_TRANSFER_KINDS,
  FILE_OF,
  KIND_LABEL,
  kindOfFile,
  parseTransferDocument,
  parseTransferPayload
} from './transfer'
export { TriggerDomain } from './trigger-domain'
// 应用日志：全局 logger 单例 + 命名空间注册表（各功能模块用 registerNamespace 自报家门）
export {
  appLog,
  registerNamespace,
  appLogNamespaces,
  appLogUnregisteredScopes,
  APP_LOG_MAX_ENTRIES
} from './app-log'
export type { AppLogEntry, AppLogLevel, AppLogNamespace, AppLogScope } from './app-log'
// 终端转录：把一条终端会话的输入输出回填进同一条应用日志 + 落一份按会话分的文件
// （server 的两份终端 + 桌面主进程共用）
export {
  TerminalTranscript,
  startTerminalTranscript,
  flushTerminalLogs,
  clearTerminalLogs,
  TERMINAL_LOG_DIR_NAME
} from './terminal-transcript'
// `.env` 文件加载（零依赖，server 启动引导用；真实环境变量优先、绝不覆盖）
export { loadEnvFile, type EnvFileResult } from './env'
// PTY 进程树的收掉方式（server 终端的「停止」/ 关标签都走它；agent-host 的桌面终端另有实现）
export { killPtyTree, type KillablePty } from './host-process'
