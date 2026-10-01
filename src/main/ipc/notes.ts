import { dialog, ipcMain } from 'electron'
import { readFile, writeFile, stat, readdir } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { storage } from '../services/storage'
import { sameNoteRoot } from '@shared/note-folders'
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
 * 笔记 IPC：管理多个本地笔记目录 / 读写 Markdown 文件。
 *
 * 侧边栏可以同时打开多个目录（同一目录只出现一次，父子不互斥），每个目录一棵文件树；
 * 编辑页读写磁盘文件，保存 = 写回原文件。打开的目录列表由渲染端随会话落盘（noteSession）。
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
   * 打开笔记目录：弹系统文件夹选择框（可多选），逐个扫描其中的 Markdown 文件树。
   * 返回 { roots, trees } —— roots 是绝对路径（供后续读写），trees 按根路径给树。
   * 「是否已在侧边栏」的去重由渲染端判断（store 才是当前打开状态的真源），
   * 这里只保证一次选择内部不重复、路径是 resolve 过的规范形态。
   */
  ipcMain.handle(
    'notes:openFolder',
    async (): Promise<{ roots: string[]; trees: Record<string, NoteFileItem[]> } | null> => {
      let picked: string[]
      // 探针旁路（同 sftp:uploadDir 的 DOGI_SFTP_UPLOAD_DIR 约定，仅验证脚本设置，
      // 正常运行不设）：原生目录选择框无法自动化。多个目录用 `|` 分隔。
      const bypass = process.env.DOGI_NOTES_OPEN_DIRS
      if (bypass) {
        picked = []
        for (const part of bypass.split('|')) {
          const p = resolve(part.trim())
          if (!p || picked.some((x) => sameNoteRoot(x, p))) continue
          picked.push(p)
        }
      } else {
        const window = ctx.win()
        if (!window || window.isDestroyed()) return null
        if (window.isMinimized()) window.restore()
        window.setAlwaysOnTop(true)
        window.focus()
        let result: Electron.OpenDialogReturnValue
        try {
          result = await dialog.showOpenDialog(window, {
            title: '选择笔记目录（可多选）',
            properties: ['openDirectory', 'multiSelections']
          })
        } finally {
          window.setAlwaysOnTop(false)
        }
        if (result.canceled || result.filePaths.length === 0) return null
        picked = result.filePaths.map((p) => resolve(p))
      }
      const roots: string[] = []
      for (const p of picked) {
        if (!roots.some((x) => sameNoteRoot(x, p))) roots.push(p)
      }
      const trees: Record<string, NoteFileItem[]> = {}
      for (const root of roots) {
        trees[root] = await scanDir(root)
      }
      return { roots, trees }
    }
  )

  /**
   * 读取指定路径的文件内容（从侧边栏文件树点击打开时调用）。
   * filePath 是相对于所属目录根的相对路径，root 是目录绝对路径；
   * root 传空时 filePath 视为绝对路径（编辑页按标签里的绝对路径重读用）。
   */
  ipcMain.handle('notes:readFile', async (_e, root: string, filePath: string): Promise<NoteFileContent> => {
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
   * 新建笔记文件：在指定目录下创建一个新的 .md 文件并返回绝对路径。
   * dirPath 是相对该目录的子目录路径（空串 = 直接在根下）。
   */
  ipcMain.handle('notes:newFile', async (_e, root: string, dirPath: string): Promise<NoteFileContent> => {
    if (!root) throw new Error('未打开笔记目录')
    const name = `untitled-${Date.now()}.md`
    const fullPath = join(root, dirPath || '.', name)
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
   * 保存笔记会话。渲染端只传变化的那一部分（folders 或 files）。
   */
  ipcMain.handle(
    'notes:session:save',
    (_e, patch: { folders?: string[]; files?: string[] }) => storage.saveNoteSession(patch)
  )

  /**
   * 删除文件（从所属目录中删除磁盘文件）。
   */
  ipcMain.handle('notes:deleteFile', async (_e, root: string, filePath: string): Promise<void> => {
    // root 为空时 filePath 是绝对路径，与 readFile 保持一致
    const fullPath = root ? join(root, filePath) : filePath
    const { rm } = await import('node:fs/promises')
    try {
      // recursive：目录也能删（右键「删除」对子目录同样可用，Windows 上 unlink 目录会 EPERM）；
      // force：文件只读属性 / 仍被占用导致的 EPERM、以及不存在(ENOENT) 一并忽略，
      // 避免在 Windows 上动不动就报「operation not permitted」。
      await rm(fullPath, { recursive: true, force: true })
    } catch (e) {
      throw new Error(`删除文件失败：${e instanceof Error ? e.message : String(e)}`)
    }
  })

}
