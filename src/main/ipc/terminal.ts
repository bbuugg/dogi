import { dialog, ipcMain } from 'electron'
import { promises as fs } from 'node:fs'
import { sessionManager } from '../services/terminal/sessions'
import { detectShells } from '../services/terminal/shells'
import { storage } from '../services/storage'
import type { SessionInfo, SshConnectProgress } from '@shared/types'
import type { IpcContext } from './shared'

/**
 * 终端 IPC：会话事件转发、会话控制、ZMODEM 文件传输（rz/sz）。
 *
 * 这里只做「会话 → 渲染端」的转发与命令透传；监控采集（monitor.ts）与
 * AI 实例销毁（ai.ts）各自订阅同一批会话事件，副作用归各自模块所有。
 */
export function registerTerminalIpc(ctx: IpcContext): void {
  // ---------- 终端事件转发 ----------
  sessionManager.on('data', (payload: { sessionId: string; data: string }) =>
    ctx.broadcast('terminal:data', payload)
  )
  sessionManager.on('exit', (payload: { sessionId: string; exitCode: number }) =>
    ctx.broadcast('terminal:exit', payload)
  )
  //主机阶段（解析/握手/认证/打开 shell/重试），渲染端据此显示连接进度
  sessionManager.on('status', (payload: SshConnectProgress) =>
    ctx.broadcast('terminal:status', payload)
  )
  sessionManager.on('created', (info: SessionInfo) => ctx.broadcast('terminal:created', info))
  sessionManager.on('closed', (payload: { sessionId: string }) =>
    ctx.broadcast('terminal:closed', payload)
  )

  // ---------- 终端控制 ----------
  ipcMain.handle('terminal:list', () => sessionManager.list())
  ipcMain.handle('terminal:listShells', () => detectShells())
  ipcMain.handle(
    'terminal:createLocal',
    (_e, cols?: number, rows?: number, shellId?: string, cwd?: string) => {
      // 未显式指定 shell 时使用偏好设置中的默认本地终端（'default' = 平台默认）
      const id = shellId || storage.getPreferences().localShell
      return sessionManager.createLocal(cols, rows, id, cwd)
    }
  )
  ipcMain.handle('terminal:createSsh', (_e, profileId: string, cols?: number, rows?: number) => {
    const profile = storage.getSshProfile(profileId)
    if (!profile) throw new Error(`SSH 配置不存在: ${profileId}`)
    return sessionManager.createSsh(profile, cols, rows)
  })
  // 按主机类型创建会话：local 启动本地命令，ssh 建立远程连接（统一入口）
  ipcMain.handle(
    'terminal:createFromProfile',
    (_e, profileId: string, cols?: number, rows?: number) => {
      const profile = storage.getSshProfile(profileId)
      if (!profile) throw new Error(`主机配置不存在: ${profileId}`)
      return profile.kind === 'local'
        ? sessionManager.createLocalHost(profile, cols, rows)
        : sessionManager.createSsh(profile, cols, rows)
    }
  )
  ipcMain.handle('terminal:write', (_e, sessionId: string, data: string) =>
    sessionManager.write(sessionId, data)
  )
  ipcMain.handle('terminal:resize', (_e, sessionId: string, cols: number, rows: number) =>
    sessionManager.resize(sessionId, cols, rows)
  )
  ipcMain.handle('terminal:kill', (_e, sessionId: string) => sessionManager.kill(sessionId))
  ipcMain.handle('terminal:recentOutput', (_e, sessionId: string, maxChars?: number) =>
    sessionManager.recentOutput(sessionId, maxChars)
  )
  // 等待会话就绪后写入内容（如：连上主机后自动执行保存的脚本），未就绪则丢弃
  ipcMain.handle('terminal:runScript', (_e, sessionId: string, data: string) =>
    sessionManager.writeWhenReady(sessionId, data)
  )

  // ---------- ZMODEM 文件传输（rz/sz） ----------
  // 打开系统文件选择框，读取选中文件并返回字节，供渲染端作为上传内容
  ipcMain.handle('zmodem:pickFiles', async () => {
    const window = ctx.win()
    if (!window || window.isDestroyed()) return []
    // Windows 上模态文件框可能被主窗口遮住（electron#32857），临时置顶并聚焦，
    // 确保选择框显示在最前、鼠标可正常交互
    if (window.isMinimized()) window.restore()
    window.setAlwaysOnTop(true)
    window.focus()
    let result: Electron.OpenDialogReturnValue
    try {
      result = await dialog.showOpenDialog(window, {
        properties: ['openFile', 'multiSelections']
      })
    } finally {
      window.setAlwaysOnTop(false)
    }
    const { canceled, filePaths } = result
    if (canceled || !filePaths.length) return []
    const files: { name: string; size: number; data: Buffer }[] = []
    for (const p of filePaths) {
      const buf = await fs.readFile(p)
      const name = p.split(/[\\/]/).pop() || 'file'
      files.push({ name, size: buf.length, data: buf })
    }
    return files
  })
  // 弹出保存对话框，返回用户选定的完整路径（先选位置再下载）；取消返回 null
  ipcMain.handle('zmodem:askSavePath', async (_e, defaultName: string) => {
    const window = ctx.win()
    if (!window || window.isDestroyed()) return null
    if (window.isMinimized()) window.restore()
    window.setAlwaysOnTop(true)
    window.focus()
    let result: Electron.SaveDialogReturnValue
    try {
      result = await dialog.showSaveDialog(window, { defaultPath: defaultName })
    } finally {
      window.setAlwaysOnTop(false)
    }
    const { canceled, filePath } = result
    if (canceled || !filePath) return null
    return filePath
  })
  // 将字节写入指定路径并保存，返回实际保存路径（失败返回 null）
  ipcMain.handle('zmodem:saveFileTo', async (_e, filePath: string, data: Uint8Array) => {
    try {
      await fs.writeFile(filePath, Buffer.from(data))
      return filePath
    } catch (e) {
      console.error('zmodem save failed', e)
      return null
    }
  })
}
