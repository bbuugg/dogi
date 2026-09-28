import { dialog, ipcMain } from 'electron'
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { storage } from '../services/storage'
import type { IpcContext } from './shared'
import type { NoteEntry, NoteImportResult } from '@shared/types'

/** 单个导入文件的大小上限：笔记正文是文本，超过这个尺寸基本是误选（如压缩包 / 大日志） */
const MAX_IMPORT_SIZE = 5 * 1024 * 1024
/** 二进制探测窗口：前 8KB 里出现 NUL 字节就当作二进制文件跳过 */
const BINARY_SCAN_SIZE = 8 * 1024

/** 文件框里默认放行的文本类扩展名（仍保留「全部文件」，只是给了个方便筛选） */
const TEXT_EXTENSIONS = [
  'md',
  'markdown',
  'txt',
  'text',
  'log',
  'json',
  'yaml',
  'yml',
  'toml',
  'ini',
  'conf',
  'csv',
  'xml',
  'html',
  'htm',
  'css',
  'js',
  'ts',
  'py',
  'go',
  'java',
  'sql',
  'sh'
]

/** 笔记 IPC：笔记与分组的 CRUD 与排序。 */
export function registerNotesIpc(ctx: IpcContext): void {
  ipcMain.handle('notes:list', () => storage.listNotes())
  ipcMain.handle('notes:save', (_e, note: NoteEntry) => storage.saveNote(note))
  ipcMain.handle('notes:delete', (_e, id: string) => storage.deleteNote(id))
  ipcMain.handle(
    'notes:arrange',
    (
      _e,
      payload: { groupIds: string[]; notes: Array<{ id: string; groupId?: string }> }
    ) => storage.arrangeNotes(payload)
  )
  ipcMain.handle('notes:groups:list', () => storage.listNoteGroups())
  ipcMain.handle('notes:groups:save', (_e, input: { id?: string; name: string }) =>
    storage.saveNoteGroup(input)
  )
  ipcMain.handle('notes:groups:delete', (_e, id: string, deleteNotes?: boolean) =>
    storage.deleteNoteGroup(id, deleteNotes)
  )

  /**
   * 从本地导入文件：弹系统文件框（可多选），每个文件生成一篇 Markdown 笔记。
   * 读文件必须在主进程做（渲染端拿不到文件系统），返回最新列表 + 新建 id，
   * 渲染端据此刷新侧边栏并打开第一篇。
   */
  ipcMain.handle('notes:import', async (): Promise<NoteImportResult> => {
    const window = ctx.win()
    if (!window || window.isDestroyed()) {
      return { notes: storage.listNotes(), createdIds: [], skipped: [] }
    }
    // Windows 上模态文件框可能被主窗口遮住（electron#32857），临时置顶并聚焦
    if (window.isMinimized()) window.restore()
    window.setAlwaysOnTop(true)
    window.focus()
    let result: Electron.OpenDialogReturnValue
    try {
      result = await dialog.showOpenDialog(window, {
        title: '导入文件为笔记',
        properties: ['openFile', 'multiSelections'],
        filters: [
          { name: 'Markdown / 文本', extensions: TEXT_EXTENSIONS },
          { name: '全部文件', extensions: ['*'] }
        ]
      })
    } finally {
      window.setAlwaysOnTop(false)
    }
    if (result.canceled || result.filePaths.length === 0) {
      return { notes: storage.listNotes(), createdIds: [], skipped: [] }
    }

    const items: { title: string; content: string }[] = []
    const skipped: string[] = []
    for (const filePath of result.filePaths) {
      const name = basename(filePath)
      try {
        const buf = await readFile(filePath)
        if (buf.length > MAX_IMPORT_SIZE || buf.subarray(0, BINARY_SCAN_SIZE).includes(0)) {
          skipped.push(name)
          continue
        }
        items.push({ title: name.replace(/\.[^.]+$/, '') || name, content: buf.toString('utf8') })
      } catch {
        // 权限不足 / 文件被删 / 是目录：跳过并在结果里报出文件名
        skipped.push(name)
      }
    }

    const { notes, createdIds } = storage.importNotes(items)
    return { notes, createdIds, skipped }
  })
}