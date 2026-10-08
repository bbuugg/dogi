/**
 * MCP 服务配置的**展示辅助**（主进程 / 渲染端共用）。
 *
 * 为什么单独抽出来：`transport` 是后加的字段，老配置里没有它 —— 于是「怎么判定一个
 * server 是什么传输」「列表里那一行该显示什么」这两个问题在设置页、输入框 Popover、
 * 主进程连接逻辑里各要回答一次。答案必须一致（判定不一致就会出现「列表显示 stdio、
 * 实际按 http 连」这种鬼故事），所以只留一份。
 */
import type { McpServerConfig, McpTransport } from './types'

/** 传输方式收敛：老配置（无该字段）/ 脏值一律按 stdio —— 与主进程 `McpManager.transportOf` 同规则 */
export function mcpTransportOf(config: Pick<McpServerConfig, 'transport'>): McpTransport {
  return config.transport === 'http' || config.transport === 'sse' ? config.transport : 'stdio'
}

/** 传输方式的中文短名（列表里那个小标签用） */
export const MCP_TRANSPORT_LABELS: Record<McpTransport, string> = {
  stdio: '本地进程',
  http: 'HTTP',
  sse: 'SSE'
}

/** 传输方式的完整说明（设置表单里给用户看的那句） */
export const MCP_TRANSPORT_HINTS: Record<McpTransport, string> = {
  stdio: '本地子进程：用命令 + 参数启动，通过标准输入输出通信',
  http: '远端 Streamable HTTP 端点：填服务地址即可（新式远端服务用这个）',
  sse: '远端旧式 SSE 端点：填服务地址即可（老服务仍在用，保留兼容）'
}

/**
 * 列表行里那行等宽摘要：stdio 显示命令 + 参数，http / sse 显示地址。
 *
 * ⚠️ 别对 http / sse 去拼 `command` —— 那两个字段在远端传输下是空的，
 * 拼出来是一行空白，用户根本看不出这个 server 到底连哪儿。
 */
export function mcpServerSummary(config: McpServerConfig): string {
  const transport = mcpTransportOf(config)
  if (transport === 'stdio') {
    return `${config.command || '(未填写命令)'} ${(config.args ?? []).join(' ')}`.trim()
  }
  return config.url?.trim() || '(未填写服务地址)'
}
