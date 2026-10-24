/**
 * MCP 工具集构建（无 Electron）：按配置连接 MCP server（stdio / http / sse），
 * 把工具转成 AI SDK ToolSet。
 *
 * 设计上与桌面端 `services/ai/mcp.ts` 同构，但**不依赖 storage**——配置由调用方传入，
 * 这样 server / cli 都能用同一份逻辑，桌面端换成 server 后端后也无需再维护自己那份。
 * 连接是惰性的：只在「列工具 / 真正跑一轮」时按需拉起，不在配置时预连。
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { dynamicTool, jsonSchema, type ToolSet } from 'ai'
import {
  normalizeMcpTransport,
  type McpServerConfig,
  type McpServerTarget,
  type McpToolInfo
} from './types'

interface McpServerState {
  config: McpServerConfig
  client: Client | null
  error?: string
}

const CONNECT_TIMEOUT_MS = 15000

/**
 * 按配置造 transport —— 三种方式的**唯一**分叉点（列工具 / 真正跑一轮都走这里，
 * 免得两处各写一遍、跑偏）。
 *
 * `http` / `sse` 走远端地址，没有子进程要关；`sse` 是协议里的旧版（服务端还在用时选它），
 * 新服务一律 `http`。headers 直接进 `requestInit`，让 `Authorization` 之类的鉴权能透传。
 */
function createTransport(config: McpServerTarget): Transport {
  const transport = normalizeMcpTransport(config.transport)
  if (transport === 'stdio') {
    if (!config.command?.trim()) throw new Error('缺少启动命令')
    return new StdioClientTransport({
      command: config.command.trim(),
      args: config.args ?? [],
      env: config.env
    })
  }
  if (!config.url?.trim()) throw new Error('缺少服务地址')
  const url = new URL(config.url.trim())
  const requestInit: RequestInit = config.headers ? { headers: config.headers } : {}
  return transport === 'sse'
    ? new SSEClientTransport(url, { requestInit })
    : new StreamableHTTPClientTransport(url, { requestInit })
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms)
    )
  ])
}

export interface McpToolset {
  tools: ToolSet
  infos: McpToolInfo[]
  errors: string[]
}

/**
 * 构建合并后的 AI SDK ToolSet（工具名冲突时以 server 名为前缀）。
 * 同时返回工具信息与连接错误，供 MCP 设置页预览。
 *
 * ⚠️ **调用方负责筛选**：这里不做任何启用 / 白名单过滤，传进来的都会去连。
 * 会话链路传的是「这个会话选中的那批」（`AgentConversation.mcpServerIds`），
 * 预览端点传的才是全部 —— 见各自调用点。
 */
export async function buildMcpToolset(configs: McpServerConfig[]): Promise<McpToolset> {
  const tools: ToolSet = {}
  const infos: McpToolInfo[] = []
  const errors: string[] = []

  await Promise.all(
    configs.map(async (config) => {
      let state: McpServerState = { config, client: null }
      try {
        const client = new Client({ name: 'fizz', version: '0.1.0' })
        await withTimeout(
          client.connect(createTransport(config)),
          CONNECT_TIMEOUT_MS,
          `连接 ${config.name}`
        )
        state = { config, client }
      } catch (err) {
        errors.push(`MCP[${config.name}] ${err instanceof Error ? err.message : String(err)}`)
        return
      }

      try {
        const result = await state.client!.listTools()
        for (const t of result.tools) {
          const dupe = result.tools.some((o) => o.name === t.name && o !== t)
          const name = dupe ? `${config.name}__${t.name}` : t.name
          tools[name] = dynamicTool({
            description: t.description ?? `MCP 工具 ${t.name}`,
            inputSchema: jsonSchema(t.inputSchema as Parameters<typeof jsonSchema>[0]),
            execute: async (input: unknown) => {
              try {
                const res = (await state.client!.callTool({
                  name: t.name,
                  arguments: (input ?? {}) as Record<string, unknown>
                })) as CallToolResult
                const isError = res.isError === true
                const text = (res.content ?? [])
                  .map((c) =>
                    c.type === 'text' && 'text' in c ? c.text : JSON.stringify(c)
                  )
                  .join('\n')
                return isError ? `[MCP 工具错误] ${text}` : text
              } catch (err) {
                return `[MCP 工具调用失败] ${err instanceof Error ? err.message : String(err)}`
              }
            }
          })
          infos.push({ serverName: config.name, name, description: t.description })
        }
      } catch (err) {
        errors.push(
          `MCP[${config.name}] 列出工具失败: ${err instanceof Error ? err.message : String(err)}`
        )
      }
    })
  )
  return { tools, infos, errors }
}

/**
 * 探**单个** MCP server 自己的工具清单：连上 → `listTools` → **立刻把连接收掉**。
 *
 * 与 `buildMcpToolset` 的分工：
 * - 那个返回的 ToolSet 需要连接一直活着（工具要能被真正调用），所以它**不能**关；
 * - 这个是「看一眼就走」，必须在 finally 里 close —— 否则用户每点一次「工具」，
 *   服务端就多留一个常驻连接（stdio 是子进程，http/sse 则是挂着的 SSE 流）。
 *
 * 工具名**不加 server 前缀**（`buildMcpToolset` 只在多个 server 撞名时才加）：
 * 这里回答的是「这个 server 自己提供了哪些工具」，就该是它自己报的名字。
 */
export async function probeMcpServerTools(
  config: McpServerTarget
): Promise<{ infos: McpToolInfo[]; errors: string[] }> {
  const infos: McpToolInfo[] = []
  const errors: string[] = []
  let client: Client | null = null
  try {
    client = new Client({ name: 'fizz', version: '0.1.0' })
    await withTimeout(
      client.connect(createTransport(config)),
      CONNECT_TIMEOUT_MS,
      `连接 ${config.name}`
    )
    const result = await withTimeout(
      client.listTools(),
      CONNECT_TIMEOUT_MS,
      `列出 ${config.name} 的工具`
    )
    for (const t of result.tools) {
      infos.push({ serverName: config.name, name: t.name, description: t.description })
    }
  } catch (err) {
    errors.push(`MCP[${config.name}] ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    // close() 对 stdio 会连子进程一起收掉、对 http/sse 会掐掉那条 SSE 流；
    // 失败无所谓（远端可能已经自己断了）
    await client?.close().catch(() => undefined)
  }
  return { infos, errors }
}