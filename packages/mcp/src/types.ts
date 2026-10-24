/**
 * @fizz/mcp 的领域类型：MCP server 配置与工具信息。
 * 类型真源在本包，前端一律 `import type` 引用。
 */

/** MCP 的传输方式：`stdio` 本地子进程，`http` Streamable HTTP，`sse` 旧版 HTTP+SSE。 */
export type McpTransport = 'stdio' | 'http' | 'sse'

/** 只需要「能连上」的那部分字段（探测工具清单时不必给 id）。 */
export type McpServerTarget = Pick<
  McpServerConfig,
  'name' | 'transport' | 'command' | 'args' | 'env' | 'url' | 'headers'
>

/**
 * MCP（Model Context Protocol）server 的配置。
 *
 * ⚠️ 这里**没有** `enabled`：是否启用是**会话级**的选择（`AgentConversation.mcpServerIds`），
 * 不是配置本身的属性。配了 = 可以被某个会话选中；某个会话选没选它，由那个会话自己决定。
 *
 * **按传输方式分两组字段**，只有对应那组会被读到：
 * - `stdio`：`command` + `args` + `env`（本地拉起的子进程）
 * - `http` / `sse`：`url` + `headers`（远端服务）
 *
 * `transport` 是**可选**的：存量配置里没有这个字段，一律当 `stdio`（用
 * `normalizeMcpTransport` 归一，别直接判 `=== 'stdio'`）。
 */
export interface McpServerConfig {
  id: string
  name: string
  /** 缺省 = `stdio`（兼容存量配置） */
  transport?: McpTransport
  /** `stdio` 专用：启动命令 */
  command?: string
  /** `stdio` 专用：启动参数 */
  args?: string[]
  /** `stdio` 专用：环境变量 */
  env?: Record<string, string>
  /** `http` / `sse` 专用：服务地址 */
  url?: string
  /** `http` / `sse` 专用：附加请求头（如 `Authorization`） */
  headers?: Record<string, string>
}

export interface McpToolInfo {
  serverName: string
  name: string
  description?: string
}

/**
 * 保存 MCP server 的入参（带 id = 更新，不带 = 新建）。
 * 领域层 / 客户端 API / 前端 store 共用这一份，别各写一遍再慢慢跑偏。
 */
export type McpServerInput = { id?: string } & Omit<McpServerConfig, 'id'>

/** 归一化传输方式：老配置没有 `transport`，一律视为 `stdio`。 */
export function normalizeMcpTransport(transport?: McpTransport): McpTransport {
  return transport === 'http' || transport === 'sse' ? transport : 'stdio'
}

/** 这个 server 是不是走子进程（决定 UI 显示命令还是 URL）。 */
export function isStdioMcpServer(server: { transport?: McpTransport }): boolean {
  return normalizeMcpTransport(server.transport) === 'stdio'
}

/** 一行摘要，给列表项 / 下拉菜单 / 删除确认用：`npx -y foo` 或 `https://…/mcp`。 */
export function mcpServerSummary(server: {
  transport?: McpTransport
  command?: string
  args?: string[]
  url?: string
}): string {
  if (!isStdioMcpServer(server)) return server.url ?? ''
  return [server.command ?? '', ...(server.args ?? [])].join(' ').trim()
}
