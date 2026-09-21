import { ipcMain } from 'electron'
import { mcpManager } from '../services/ai/mcp'
import { storage } from '../services/storage'
import type { McpServerConfig } from '@shared/types'

/**
 * MCP Server IPC：配置 CRUD 与工具清单。
 *
 * 改动配置后要 `invalidate` 掉已缓存的连接 —— 否则设置页保存了新地址，
 * 下一次对话仍然连着旧进程。
 */
export function registerMcpIpc(): void {
  ipcMain.handle('mcp:list', () => mcpManager.listStatus())
  ipcMain.handle('mcp:save', (_e, server: McpServerConfig) => {
    const next = storage.saveMcpServer(server)
    mcpManager.invalidate(server.id)
    return next
  })
  ipcMain.handle('mcp:delete', (_e, id: string) => {
    const next = storage.deleteMcpServer(id)
    mcpManager.invalidate(id)
    return next
  })
  ipcMain.handle('mcp:tools', async () => {
    const { infos, errors } = await mcpManager.buildToolset()
    return { tools: infos, errors }
  })
}
