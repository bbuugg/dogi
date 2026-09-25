import { ipcMain } from 'electron'
import {
  listInstalledIdes,
  openFileManagerAt,
  openIdeWith,
  openTerminalAt
} from '../services/system/opener'

/**
 * 系统打开 IPC：用系统程序打开目录 / 终端 / IDE（平台差异见 services/system/opener.ts）。
 *
 * 渲染端的「在文件管理器中打开」「用 IDE 打开」等菜单项走这里。
 */
export function registerOpenerIpc(): void {
  ipcMain.handle('shell:openFileManager', (_e, dir: string) => openFileManagerAt(dir))
  ipcMain.handle('shell:openTerminal', (_e, dir: string) => openTerminalAt(dir))
  ipcMain.handle('shell:listIdes', () => listInstalledIdes())
  ipcMain.handle('shell:openIde', (_e, ideId: string, dir: string) => openIdeWith(ideId, dir))
}
