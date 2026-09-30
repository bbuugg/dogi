import { dialog, ipcMain } from 'electron'
import { readFile, writeFile, stat, readdir } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { storage } from '../services/storage'
import type { IpcContext } from './shared'
import type { NoteFileItem, NoteFileContent } from '@shared/types'

/** Markdown 文件扩展名（不区分大小写） */
const MD_EXTENSIONS = ['.md', '.markdown', '.mdown', '.mdx']
/** 单文件读取大小上限：10MB（笔记是文本，超过这个尺寸基本是误选） */
const MAX_FILE_SIZE = 10 * 1024 * 1024

function isMarkdown(name: string): boolean {
  const lower = name.toLowerCase()
  return MD_EXTENSIONS.some((ext) => lower.endsWith(ext))
}

/**
 * 递归扫描目录下的 Markdown 文件，返回树形结构。
 * - 目录排在文件前面，各自按名称排序
 * - 空目录不显示（不产出子项的目录直接跳过）
 * - 最大递归深度 10 层，防符号链接环
 */
async function scanDir(dir: string, depth = 0): Promise<NoteFileItem[]> {
  if (depth > 10) return []
  let entries: import('node:fs').Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const dirs = entries.filter((e) => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))
  const files = entries.filter((e) => e.isFile() && isMarkdown(e.name)).sort((a, b) => a.name.localeCompare(b.name))
  const items: NoteFileItem[] = []
  for (const d of dirs) {
    const childPath = join(dir, d.name)
    // 对 junction / 符号链接补一次 stat（Dirent.isDirectory 对链接恒 false，见 6.6 第 25 条）
    let isDir = true
    try {
      const s = await stat(childPath)
      isDir = s.isDirectory()
    } catch {
      continue
    }
    if (!isDir) continue
    const children = await scanDir(childPath, depth + 1)
    if (children.length === 0) continue // 空目录不展示
    items.push({ path: relative(dir, childPath).split(sep).join('/'), name: d.name, isDir: true, children })
  }
  for (const f of files) {
    items.push({ path: f.name, name: f.name, isDir: false })
  }
  return items
}

/**
 * 笔记 IPC：打开本地文件夹 / 读写 Markdown 文件。
 *
 * 改造后的笔记不再存储在 electron-store 里，而是直接对应本地 `.md` 文件。
 * 侧边栏展示文件树，编辑页读写磁盘文件，保存 = 写回原文件。
 */
export function registerNotesIpc(ctx: IpcContext): void {
  // ---------- 旧版笔记 CRUD（仅保留用于数据传输兼容） ----------
  ipcMain.handle('notes:list', () => storage.listNotes())
  ipcMain.handle('notes:save', (_e, note) => storage.saveNote(note))
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

  // ---------- 新版：本地文件操作 ----------

  /**
   * 打开本地文件夹：弹系统文件夹选择框，扫描其中的 Markdown 文件树。
   * 返回 { root, items } —— root 是绝对路径（供后续读写），items 是树形结构。
   */
  ipcMain.handle('notes:openFolder', async (): Promise<{ root: string; items: NoteFileItem[] } | null> => {
    const window = ctx.win()
    if (!window || window.isDestroyed()) return null
    if (window.isMinimized()) window.restore()
    window.setAlwaysOnTop(true)
    window.focus()
    let result: Electron.OpenDialogReturnValue
    try {
      result = await dialog.showOpenDialog(window, {
        title: '选择笔记文件夹',
        properties: ['openDirectory']
      })
    } finally {
      window.setAlwaysOnTop(false)
    }
    if (result.canceled || result.filePaths.length === 0) return null
    const root = result.filePaths[0]
    const items = await scanDir(root)
    return { root, items }
  })

  /**
   * 打开单个本地文件：弹系统文件框选一个 Markdown 文件，读取内容返回。
   */
  ipcMain.handle('notes:openFile', async (): Promise<NoteFileContent | null> => {
    const window = ctx.win()
    if (!window || window.isDestroyed()) return null
    if (window.isMinimized()) window.restore()
    window.setAlwaysOnTop(true)
    window.focus()
    let result: Electron.OpenDialogReturnValue
    try {
      result = await dialog.showOpenDialog(window, {
        title: '打开笔记文件',
        properties: ['openFile'],
        filters: [
          { name: 'Markdown', extensions: ['md', 'markdown', 'mdown', 'mdx'] },
          { name: '全部文件', extensions: ['*'] }
        ]
      })
    } finally {
      window.setAlwaysOnTop(false)
    }
    if (result.canceled || result.filePaths.length === 0) return null
    const filePath = result.filePaths[0]
    try {
      const buf = await readFile(filePath)
      if (buf.length > MAX_FILE_SIZE) {
        throw new Error('文件过大（超过 10MB），不支持打开')
      }
      const s = await stat(filePath)
      return { path: filePath, content: buf.toString('utf8'), mtime: s.mtimeMs }
    } catch (e) {
      throw new Error(`读取文件失败：${e instanceof Error ? e.message : String(e)}`)
    }
  })

  /**
   * 读取指定路径的文件内容（从侧边栏文件树点击打开时调用）。
   * filePath 是相对于文件夹根的相对路径，root 是文件夹绝对路径。
   */
  ipcMain.handle('notes:readFile', async (_e, root: string, filePath: string): Promise<NoteFileContent> => {
    // root 为空时 filePath 是绝对路径（直接打开的单个文件）；否则 filePath 是相对路径
    const fullPath = root ? join(root, filePath) : filePath
    try {
      const buf = await readFile(fullPath)
      if (buf.length > MAX_FILE_SIZE) {
        throw new Error('文件过大（超过 10MB），不支持打开')
      }
      const s = await stat(fullPath)
      return { path: fullPath, content: buf.toString('utf8'), mtime: s.mtimeMs }
    } catch (e) {
      // 「文件不在了」单独说清楚：渲染端据此提示「已被删除 / 移动」，
      // 而不是抛一句看不懂的 Node ENOENT（原来的报错还会把完整路径吞掉）。
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(`文件不存在：${fullPath}`)
      }
      throw new Error(`读取文件失败：${e instanceof Error ? e.message : String(e)}`)
    }
  })

  /**
   * 保存内容到文件（写回磁盘）。
   * filePath 是绝对路径（从标签页的 noteFilePath 字段取）。
   */
  ipcMain.handle('notes:saveFile', async (_e, filePath: string, content: string): Promise<{ mtime: number }> => {
    try {
      await writeFile(filePath, content, 'utf8')
      const s = await stat(filePath)
      return { mtime: s.mtimeMs }
    } catch (e) {
      throw new Error(`保存文件失败：${e instanceof Error ? e.message : String(e)}`)
    }
  })

  /**
   * 新建笔记文件：在指定文件夹下创建一个新的 .md 文件并返回路径。
   * root 为空时弹保存框让用户选位置；非空时在文件夹下新建。
   */
  ipcMain.handle('notes:newFile', async (_e, root: string, dirPath: string): Promise<NoteFileContent> => {
    const name = `untitled-${Date.now()}.md`
    const fullPath = root ? join(root, dirPath || '.', name) : name

    if (!root) {
      // 没有打开文件夹时弹保存框
      const window = ctx.win()
      if (!window || window.isDestroyed()) throw new Error('窗口不可用')
      if (window.isMinimized()) window.restore()
      window.setAlwaysOnTop(true)
      window.focus()
      let result: Electron.SaveDialogReturnValue
      try {
        result = await dialog.showSaveDialog(window, {
          title: '新建笔记',
          defaultPath: name,
          filters: [{ name: 'Markdown', extensions: ['md'] }]
        })
      } finally {
        window.setAlwaysOnTop(false)
      }
      if (result.canceled || !result.filePath) throw new Error('用户取消')
      const savePath = result.filePath
      await writeFile(savePath, '', 'utf8')
      const s = await stat(savePath)
      return { path: savePath, content: '', mtime: s.mtimeMs }
    }

    try {
      await writeFile(fullPath, '', 'utf8')
      const s = await stat(fullPath)
      return { path: fullPath, content: '', mtime: s.mtimeMs }
    } catch (e) {
      throw new Error(`新建文件失败：${e instanceof Error ? e.message : String(e)}`)
    }
  })

  /**
   * 刷新文件夹：重新扫描已打开的文件夹，返回更新后的文件树。
   */
  ipcMain.handle('notes:refreshFolder', async (_e, root: string): Promise<NoteFileItem[]> => {
    return scanDir(root)
  })

  /**
   * 重命名文件 / 移动文件（在已打开的文件夹内）。
   */
  ipcMain.handle('notes:renameFile', async (_e, root: string, oldPath: string, newName: string): Promise<string> => {
    const oldFull = join(root, oldPath)
    const dir = oldFull.includes(sep) ? oldFull.slice(0, oldFull.lastIndexOf(sep)) : root
    const newFull = join(dir, newName)
    const { rename } = await import('node:fs/promises')
    try {
      await rename(oldFull, newFull)
      return relative(root, newFull).split(sep).join('/')
    } catch (e) {
      throw new Error(`重命名失败：${e instanceof Error ? e.message : String(e)}`)
    }
  })

  /**
   * 读取上次的笔记会话（文件夹 + 打开的文件），供启动时恢复。
   */
  ipcMain.handle('notes:session:get', () => storage.getNoteSession())

  /**
   * 保存笔记会话。渲染端只传变化的那一部分（folder 或 files）。
   */
  ipcMain.handle(
    'notes:session:save',
    (_e, patch: { folder?: string | null; files?: string[] }) => storage.saveNoteSession(patch)
  )

  /**
   * 删除文件（从已打开的文件夹中移除）。
   */
  ipcMain.handle('notes:deleteFile', async (_e, root: string, filePath: string): Promise<void> => {
    // root 为空时 filePath 是绝对路径（直接打开的单个文件），与 readFile 保持一致
    const fullPath = root ? join(root, filePath) : filePath
    const { unlink } = await import('node:fs/promises')
    try {
      await unlink(fullPath)
    } catch (e) {
      // 文件本来就不在了（被其它程序删掉 / 重复删除）＝ 用户想要的「删掉」已经达成，
      // 不该报错 —— 否则界面上会留下一个删不掉、还报「删除失败」的幽灵条目。
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return
      throw new Error(`删除文件失败：${e instanceof Error ? e.message : String(e)}`)
    }
  })

}
