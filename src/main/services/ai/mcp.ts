import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { dynamicTool, jsonSchema, type ToolSet } from 'ai'
import type { McpServerConfig, McpToolInfo } from '@shared/types'
import { storage } from '../storage'

interface McpServerState {
  config: McpServerConfig
  client: Client | null
  error?: string
}

const CONNECT_TIMEOUT_MS = 15000

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms)
    )
  ])
}

/** MCP 官方 SDK 客户端管理：按配置连接 stdio server，工具转换为 AI SDK ToolSet */
class McpManager {
  private states = new Map<string, McpServerState>()

  private async connect(config: McpServerConfig): Promise<McpServerState> {
    const state: McpServerState = { config, client: null }
    try {
      const client = new Client({ name: 'opsdesk', version: '0.1.0' })
      const transport = new StdioClientTransport({
        command: config.command,
        args: config.args ?? [],
        env: config.env
      })
      await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, `连接 ${config.name}`)
      state.client = client
    } catch (err) {
      state.error = err instanceof Error ? err.message : String(err)
    }
    return state
  }

  private async ensureConnected(config: McpServerConfig): Promise<McpServerState> {
    const existing = this.states.get(config.id)
    if (existing && !existing.error) return existing
    if (existing?.client) {
      try {
        await existing.client.close()
      } catch {
        // 忽略关闭失败
      }
    }
    const state = await this.connect(config)
    this.states.set(config.id, state)
    return state
  }

  /** 失效指定 server 或全部（配置变更时调用） */
  invalidate(id?: string): void {
    if (id) {
      const state = this.states.get(id)
      if (state?.client) void state.client.close().catch(() => {})
      this.states.delete(id)
    } else {
      for (const state of this.states.values()) {
        if (state.client) void state.client.close().catch(() => {})
      }
      this.states.clear()
    }
  }

  /**
   * 构建合并后的 AI SDK ToolSet（工具名冲突时以 server 名为前缀）
   * 同时返回工具信息与连接错误，供 UI 展示
   */
  async buildToolset(): Promise<{
    tools: ToolSet
    infos: McpToolInfo[]
    errors: string[]
  }> {
    const tools: ToolSet = {}
    const infos: McpToolInfo[] = []
    const errors: string[] = []
    const enabled = storage.listMcpServers().filter((s) => s.enabled)

    await Promise.all(
      enabled.map(async (config) => {
        const state = await this.ensureConnected(config)
        if (state.error || !state.client) {
          errors.push(`MCP[${config.name}] ${state.error ?? '未知错误'}`)
          return
        }
        try {
          const result = await state.client.listTools()
          for (const t of result.tools) {
            const name = result.tools.some((o) => o.name === t.name && o !== t)
              ? `${config.name}__${t.name}`
              : t.name
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
                      c.type === 'text' && 'text' in c
                        ? c.text
                        : JSON.stringify(c)
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

  listStatus(): Array<McpServerConfig & { error?: string }> {
    return storage.listMcpServers().map((config) => ({
      ...config,
      error: this.states.get(config.id)?.error
    }))
  }
}

export const mcpManager = new McpManager()
