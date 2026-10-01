/**
 * 工作区文件系统（渲染端文件树 / 编辑器用）。
 *
 * 与 Agent 工具共用同一套安全边界与忽略规则：
 * - 所有路径都经 `resolveInside` 校验，落盘范围限定在工作区根目录之内（`..` / 绝对路径直接抛错）；
 * - 列表吃 `.gitignore` 与默认忽略目录，避免把 node_modules / dist 这种上万条目的目录塞进树里。
 */
import { promises as fs } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { createIgnoreChecker, relPathOf, resolveInside } from './agent-core'
import type { AgentFsEntry, AgentFsFile, AgentWorkspace } from '@shared/types'

/** 超过这个大小就不往编辑器里读（Monaco 会卡死），提示用户改用别的方式看 */
const MAX_READ_BYTES = 2 * 1024 * 1024

/** 单个目录最多返回多少条目（防御性上限，正常目录远达不到） */
const MAX_ENTRIES = 2000

/** 列出工作区某个目录的直接子项（懒加载：点开一层读一层，不预扫整棵树） */
export async function listWorkspaceDir(
  workspace: AgentWorkspace,
  dir = ''
): Promise<AgentFsEntry[]> {
  const root = workspace.path
  const abs = resolveInside(root, dir)
  const ignore = await createIgnoreChecker(root)
  const dirents = await fs.readdir(abs, { withFileTypes: true })

  const entries: AgentFsEntry[] = []
  for (const d of dirents) {
    // 符号链接 / 设备文件等既不是 file 也不是 dir，直接跳过（跟随链接会破坏越界校验）
    const isDir = d.isDirectory()
    if (!isDir && !d.isFile()) continue
    const rel = relPathOf(root, join(abs, d.name))
    if (ignore(rel, isDir)) continue
    entries.push({ name: d.name, path: rel, type: isDir ? 'dir' : 'file' })
    if (entries.length >= MAX_ENTRIES) break
  }

  // 目录在前，同类按名字排（localeCompare 对中文 / 大小写混排的顺序更自然）
  entries.sort((a, b) =>
    a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1
  )
  return entries
}

/** 读取工作区内的文本文件 */
export async function readWorkspaceFile(
  workspace: AgentWorkspace,
  path: string
): Promise<AgentFsFile> {
  const abs = resolveInside(workspace.path, path)
  const stat = await fs.stat(abs)
  if (!stat.isFile()) throw new Error('这不是一个文件')
  if (stat.size > MAX_READ_BYTES) {
    throw new Error(
      `文件过大（${(stat.size / 1024 / 1024).toFixed(1)} MB），暂不支持在编辑器里打开`
    )
  }
  const buf = await fs.readFile(abs)
  // 二进制检测：出现 NUL 字节就当二进制，否则 Monaco 里是一屏乱码
  if (buf.includes(0)) throw new Error('这是二进制文件，无法以文本方式打开')
  return { path, content: buf.toString('utf8'), size: stat.size }
}

/** 保存文本文件（整体覆盖写入） */
export async function writeWorkspaceFile(
  workspace: AgentWorkspace,
  path: string,
  content: string
): Promise<void> {
  const abs = resolveInside(workspace.path, path)
  await fs.writeFile(abs, content, 'utf8')
}

// ── 以下为文件视图右键菜单（触屏长按）用的写操作 ─────────────────────────
// 与上面三个只读/写入接口共用 resolveInside 边界；删除语义与 Agent 的 delete_file 工具
// 保持一致（目录递归删），两处改一处时记得同步。

/** 路径是否存在（用 lstat：断链的符号链接也算存在，删除它才有意义） */
async function pathExists(abs: string): Promise<boolean> {
  try {
    await fs.lstat(abs)
    return true
  } catch {
    return false
  }
}

/** 名字合法性（新建 / 重命名用）：不许空、不许带路径分隔符，`.` / `..` 也不行 */
function assertEntryName(name: string): string {
  const n = name.trim()
  if (!n) throw new Error('名字不能为空')
  if (n === '.' || n === '..') throw new Error(`不能用作名字：${name}`)
  if (/[\\/]/.test(n)) throw new Error('名字里不能带路径分隔符（/ 或 \\）')
  return n
}

/** 「名 / 扩展名」拆分，仅用于副本命名；点开头的文件（.gitignore）不算有扩展名 */
function splitExt(name: string, isDir: boolean): [string, string] {
  if (isDir) return [name, '']
  const i = name.lastIndexOf('.')
  return i > 0 ? [name.slice(0, i), name.slice(i)] : [name, '']
}

/**
 * 目标已存在时挑一个不撞车的名字：`name 副本.ext` → `name 副本 2.ext` …
 *
 * 复制刻意**不覆盖**已存在的文件：这一列是手滑点错最常发生的地方，安静地盖掉用户的
 * 文件比多一个「副本」严重得多。
 */
async function pickCopyTarget(dest: string, isDir: boolean): Promise<string> {
  const [base, ext] = splitExt(basename(dest), isDir)
  const dir = dirname(dest)
  let candidate = join(dir, `${base} 副本${ext}`)
  for (let i = 2; i < 1000; i++) {
    if (!(await pathExists(candidate))) return candidate
    candidate = join(dir, `${base} 副本 ${i}${ext}`)
  }
  throw new Error('同名副本太多了，重命名后再试')
}

/** 删除文件 / 目录（目录递归删除，与 Agent 的 delete_file 工具同一套语义） */
export async function deleteWorkspacePath(
  workspace: AgentWorkspace,
  path: string
): Promise<void> {
  // 根目录删掉等于把整个工作区抹了，必须先挡掉（渲染端也不会给这个菜单，这里是兜底）
  if (!path) throw new Error('工作区根目录不能删除')
  const abs = resolveInside(workspace.path, path)
  const stat = await fs.lstat(abs)
  if (stat.isDirectory()) await fs.rm(abs, { recursive: true, force: true })
  else await fs.unlink(abs)
}

/** 重命名（只改名字、不换目录）。目标已存在则拒绝，绝不覆盖 */
export async function renameWorkspacePath(
  workspace: AgentWorkspace,
  path: string,
  name: string
): Promise<AgentFsEntry> {
  if (!path) throw new Error('工作区根目录不能重命名')
  const abs = resolveInside(workspace.path, path)
  const nextName = assertEntryName(name)
  const dest = join(dirname(abs), nextName)
  const entryOf = async (target: string): Promise<AgentFsEntry> => ({
    name: basename(target),
    path: relPathOf(workspace.path, target),
    type: (await fs.lstat(target)).isDirectory() ? 'dir' : 'file'
  })
  // 名字没变：直接返回，别拿「已存在同名项」挡回去
  if (dest === abs) return entryOf(abs)
  if (await pathExists(dest)) throw new Error(`已存在同名项：${nextName}`)
  await fs.rename(abs, dest)
  return entryOf(dest)
}

/** 新建文件 / 目录（父目录不存在会自动补出来）；已存在则拒绝，不覆盖 */
export async function createWorkspacePath(
  workspace: AgentWorkspace,
  dir: string,
  name: string,
  type: 'file' | 'dir'
): Promise<AgentFsEntry> {
  const finalName = assertEntryName(name)
  const abs = join(resolveInside(workspace.path, dir), finalName)
  if (await pathExists(abs)) throw new Error(`已存在同名项：${finalName}`)
  await fs.mkdir(dirname(abs), { recursive: true })
  if (type === 'dir') await fs.mkdir(abs)
  else await fs.writeFile(abs, '', 'utf8')
  return { name: finalName, path: relPathOf(workspace.path, abs), type }
}

/**
 * 复制 / 移动工作区内的文件或目录。
 *
 * - `mode: 'copy'` 目标同名时自动加「副本」后缀（见 pickCopyTarget）；
 * - `mode: 'move'` 目标同名时**直接报错** —— 静默改名会让用户以为「移过去了」；
 * - 目录不能移进 / 复制进它自己的子目录（源会被一起卷进去）。
 */
export async function copyWorkspacePath(
  workspace: AgentWorkspace,
  from: string,
  toDir: string,
  mode: 'copy' | 'move'
): Promise<AgentFsEntry> {
  if (!from) throw new Error('工作区根目录不能复制或移动')
  const src = resolveInside(workspace.path, from)
  const stat = await fs.lstat(src)
  const isDir = stat.isDirectory()
  if (!isDir && !stat.isFile()) {
    throw new Error('不支持的类型（符号链接 / 设备文件等）')
  }
  const destDir = resolveInside(workspace.path, toDir)
  if (isDir) {
    const rel = relPathOf(workspace.path, destDir)
    if (rel === from || rel.startsWith(`${from}/`)) {
      throw new Error('不能把目录放进它自己的子目录里')
    }
  }

  let dest: string
  if (mode === 'copy') {
    dest = join(destDir, basename(src))
    // 原名空着就照用（**先问一句**：不能一上来就推副本名，否则复制到哪儿都变成「副本」）；
    // 撞名了才加后缀，且后缀永远挂在原名上（a.txt → a 副本.txt → a 副本 2.txt）
    if (await pathExists(dest)) dest = await pickCopyTarget(dest, isDir)
    await fs.cp(src, dest, { recursive: true })
  } else {
    dest = join(destDir, basename(src))
    if (src === dest) throw new Error('目标目录就是它现在所在的位置')
    if (await pathExists(dest)) throw new Error(`目标已存在同名项：${basename(dest)}`)
    try {
      await fs.rename(src, dest)
    } catch (err) {
      // 跨设备（不同盘 / 挂载点）rename 会 EXDEV：先复制再删源
      if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err
      await fs.cp(src, dest, { recursive: true })
      await fs.rm(src, { recursive: true, force: true })
    }
  }
  return { name: basename(dest), path: relPathOf(workspace.path, dest), type: isDir ? 'dir' : 'file' }
}
