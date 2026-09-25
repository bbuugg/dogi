import { ipcMain } from 'electron'
import { storage } from '../services/storage'
import type { ScriptEntry } from '@shared/types'

/**
 * 用户脚本 IPC：脚本与分组的 CRUD 与排序。
 *
 * 脚本的执行不走这里 —— 渲染端把正文转成终端输入后走 `terminal:runScript`。
 */
export function registerScriptsIpc(): void {
  ipcMain.handle('scripts:list', () => storage.listScripts())
  ipcMain.handle('scripts:save', (_e, entry: ScriptEntry) => storage.saveScript(entry))
  ipcMain.handle('scripts:delete', (_e, id: string) => storage.deleteScript(id))
  ipcMain.handle(
    'scripts:arrange',
    (
      _e,
      payload: { groupIds: string[]; scripts: Array<{ id: string; groupId?: string }> }
    ) => storage.arrangeScripts(payload)
  )
  ipcMain.handle('scripts:groups:list', () => storage.listScriptGroups())
  ipcMain.handle('scripts:groups:save', (_e, input: { id?: string; name: string }) =>
    storage.saveScriptGroup(input)
  )
  ipcMain.handle('scripts:groups:delete', (_e, id: string, deleteScripts?: boolean) =>
    storage.deleteScriptGroup(id, deleteScripts)
  )
}
