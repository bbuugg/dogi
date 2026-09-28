import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { dynamicTool, jsonSchema, type ToolSet } from 'ai'
import type { McpServerConfig, McpToolInfo } from '@shared/types'
import { storage } from '../storage'
import { detectBrowsers } from '../browser/resolver'

/** ESM 里取 CJS 风格的 require（用于解析内置 @playwright/mcp 的真实路径） */
const require = createRequire(import.meta.url)

/** 内置 Playwright MCP 的固定 id（浏览器来源偏好变更时也要按它失效连接） */
export const BUILTIN_PLAYWRIGHT_ID = '__builtin_playwright'

/**
 * 解析内置 @playwright/mcp 的本地 CLI 入口。打包后它随应用一起分发，无需运行时 npx 下载。
 * 解析不到（极端情况下）才回退到 npx 兜底，保证功能不中断。
 */
function resolveBuiltinPlaywrightMcp(): {
  command: string
  args: string[]
  env?: Record<string, string>
} {
  try {
    const pkgPath = require.resolve('@playwright/mcp/package.json')
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
      bin?: string | Record<string, string>
    }
    const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.['playwright-mcp']
    if (bin) {
      let entry = join(dirname(pkgPath), bin)
      // 打包后 entry 落在 app.asar 内，而**子进程无法执行 asar 里的文件** ——
      // 必须换成 asar.unpacked 下的真实路径（package.json 的 asarUnpack 已包含 @playwright/mcp）
      const packed = `${sep}app.asar${sep}`
      if (entry.includes(packed)) entry = entry.replace(packed, `${sep}app.asar.unpacked${sep}`)
      return {
        command: process.execPath,
        args: [entry],
        // ⚠️ 必须开 ELECTRON_RUN_AS_NODE：否则 process.execPath（Electron 二进制）会被当成
        // 「再启动一个 Dogi」，而应用有单实例锁 —— 第二个实例立刻退出，MCP 客户端只看到
        // `MCP error -32000: Connection closed`（内置 Playwright 永远连不上）。
        // 设为 1 后同一二进制按 Node 运行，才会真正跑起 MCP CLI。
        env: { ELECTRON_RUN_AS_NODE: '1' }
      }
    }
  } catch {
    // 忽略，走兜底
  }
  return { command: 'npx', args: ['-y', '@playwright/mcp@latest'] }
}

/**
 * 把应用的「浏览器来源」偏好映射成 @playwright/mcp 的浏览器参数。
 *
 * ⚠️ `--browser` 只认 chrome / firefox / webkit / msedge，**没有「自带 Chromium」这个取值**，
 * 不指定时默认走 Chrome 通道 —— 机器上没装 Chrome 时一调用工具就是「浏览器启动失败」。
 * 自带 Chromium 只能用 `--executable-path` 指到真实可执行文件。
 */
function builtinBrowserArgs(): string[] {
  const pref = storage.getPreferences().browserChannel ?? 'auto'
  const order: Array<'bundled' | 'msedge' | 'chrome'> =
    pref === 'auto' ? ['bundled', 'msedge', 'chrome'] : [pref]
  const candidates = detectBrowsers()
  for (const channel of order) {
    const hit = candidates.find((c) => c.channel === channel && c.available && c.path)
    if (!hit?.path) continue
    return channel === 'bundled'
      ? ['--executable-path', hit.path]
      : ['--browser', channel]
  }
  // 一个都没探测到：交给 MCP 自己的默认（Chrome 通道），至少错误信息来自 Playwright 本身
  return []
}

interface McpServerState {
  config: McpServerConfig
  client: Client | null
  error?: string
}

/**
 * 内置的 Playwright MCP：随应用打包分发，**只在把浏览器工具选成「系统浏览器」时**才挂载
 * （见 effectiveServers）。**每次现算**而不是模块级常量：浏览器来源偏好改了之后无需重启
 * 应用就能生效。
 */
function builtinPlaywrightServer(): McpServerConfig {
  const r = resolveBuiltinPlaywrightMcp()
  return {
    id: BUILTIN_PLAYWRIGHT_ID,
    name: 'Playwright（内置）',
    command: r.command,
    args: [...r.args, ...builtinBrowserArgs()],
    env: r.env,
    enabled: true
  }
}

/**
 * 实际参与 agent 的 MCP server：内置 Playwright（**浏览器工具选了「系统浏览器」时**）
 * + 用户配置里已启用的。
 *
 * 浏览器工具来源是三态（见 BrowserToolMode）：
 * - `off` / `in-app`：不挂内置 Playwright MCP（`in-app` 由应用自带的浏览器工具提供能力，
 *   无窗口运行、画面镜像到界面里的浏览器面板）；
 * - `system`：挂上内置 Playwright MCP —— 独立进程，会拉起**本机**的 Edge/Chrome 窗口。
 */
function effectiveServers(): McpServerConfig[] {
  const list = storage.listMcpServers().filter((s) => s.enabled)
  if (storage.getPreferences().browserToolMode === 'system') {
    list.unshift(builtinPlaywrightServer())
  }
  return list
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
    /** 子进程 stderr 的尾部若干行：连接失败时用来解释「为什么连不上」 */
    const stderrTail: string[] = []
    try {
      const client = new Client({ name: 'dogi', version: '0.0.1' })
      const transport = new StdioClientTransport({
        command: config.command,
        args: config.args ?? [],
        env: config.env,
        // 收走 stderr 而不是让它 inherit：连接失败时客户端只给出「Connection closed」，
        // 真正的原因（命令不存在、参数错、浏览器缺失…）都在子进程的 stderr 里
        stderr: 'pipe'
      })
      transport.stderr?.on('data', (chunk: Buffer) => {
        const text = String(chunk).trimEnd()
        if (!text) return
        stderrTail.push(text)
        if (stderrTail.length > 20) stderrTail.shift()
        console.warn(`[mcp] ${config.name}: ${text}`)
      })
      await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, `连接 ${config.name}`)
      state.client = client
    } catch (err) {
      const base = err instanceof Error ? err.message : String(err)
      state.error = stderrTail.length ? `${base}\n${stderrTail.join('\n')}` : base
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
    const enabled = effectiveServers()

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

  /** 拉取单个 server 的工具清单（设置页「拉取工具」用，互不影响、不污染合并 ToolSet） */
  async listServerTools(
    config: McpServerConfig
  ): Promise<{ tools: McpToolInfo[]; error?: string }> {
    const state = await this.ensureConnected(config)
    if (state.error || !state.client) {
      return { tools: [], error: state.error ?? '未知错误' }
    }
    try {
      const result = await state.client.listTools()
      const tools: McpToolInfo[] = result.tools.map((t) => ({
        serverName: config.name,
        name: t.name,
        description: t.description
      }))
      return { tools, error: undefined }
    } catch (err) {
      return {
        tools: [],
        error: err instanceof Error ? err.message : String(err)
      }
    }
  }
}

export const mcpManager = new McpManager()
