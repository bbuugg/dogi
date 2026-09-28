import { ipcMain } from 'electron'
import { storage } from '../services/storage'
import type { AutomationScript } from '@shared/types'

/** 自动化脚本 IPC：脚本与分组的 CRUD 与排序（与笔记同构）。 */
export function registerAutomationIpc(): void {
  ipcMain.handle('automation:list', () => storage.listAutomationScripts())
  ipcMain.handle('automation:save', (_e, script: AutomationScript) =>
    storage.saveAutomationScript(script)
  )
  ipcMain.handle('automation:delete', (_e, id: string) => storage.deleteAutomationScript(id))
  ipcMain.handle(
    'automation:arrange',
    (
      _e,
      payload: { groupIds: string[]; scripts: Array<{ id: string; groupId?: string }> }
    ) => storage.arrangeAutomation(payload)
  )
  ipcMain.handle('automation:groups:list', () => storage.listAutomationGroups())
  ipcMain.handle('automation:groups:save', (_e, input: { id?: string; name: string }) =>
    storage.saveAutomationGroup(input)
  )
  ipcMain.handle('automation:groups:delete', (_e, id: string, deleteScripts?: boolean) =>
    storage.deleteAutomationGroup(id, deleteScripts)
  )
}
