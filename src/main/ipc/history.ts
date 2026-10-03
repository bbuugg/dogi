/**
 * 终端命令历史（数据源在 services/terminal/history.ts）。
 *
 * 只做薄转发：list / remove / clear 是请求-响应，add 用 on 不等回执
 * （渲染端在 store 里乐观更新镜像，落盘成败不影响界面；命令频率低，
 * 不会造成 IPC 洪水）。参数统一先做类型校验再进服务。
 */
import { ipcMain } from 'electron'
import { commandHistory } from '../services/terminal/history'

export function registerHistoryIpc(): void {
  ipcMain.handle('history:list', () => commandHistory.list())

  ipcMain.on('history:add', (_e, cmd: unknown) => {
    if (typeof cmd !== 'string') return
    commandHistory.add(cmd)
  })

  ipcMain.handle('history:remove', (_e, cmd: unknown) => {
    if (typeof cmd !== 'string') return
    commandHistory.remove(cmd)
  })

  ipcMain.handle('history:clear', () => {
    commandHistory.clear()
  })
}
