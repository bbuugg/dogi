import { ipcMain } from 'electron'
import { storage } from '../services/storage'
import type { NoteEntry } from '@shared/types'

/** 笔记 IPC：笔记与分组的 CRUD 与排序。 */
export function registerNotesIpc(): void {
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
}
