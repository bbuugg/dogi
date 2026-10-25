/**
 * 文件管理器自己的**回收站**（不碰系统回收站）。
 *
 * ## 为什么不复用系统回收站
 *
 * Windows 的回收站要走 COM / `$Recycle.Bin` 的私有格式，Linux 是 `~/.local/share/Trash`
 * 的 `.trashinfo`，macOS 是 `~/.Trash` —— 三套规则、三份坑，而且**跨盘删除**各有各的限制。
 * 这里要的只是「删错了能拿回来」，所以自己在数据目录下开一个：
 *
 * ```
 * <dataDir>/file-manager-trash/<id>/meta.json    删除时的元数据（原路径、时间、类型）
 * <dataDir>/file-manager-trash/<id>/data/<name>  被删的东西本体
 * ```
 *
 * `id` 是随机 uuid：同名的 `a.txt` 删两次不会互相顶掉。还原时按 `meta.json` 里的
 * 原路径放回去；原位已有同名文件就加 ` (1)` 后缀，**绝不覆盖**用户后来放的东西
 * （那才是真的丢数据）。
 */
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'
import type { FmTrashItem } from '@fizz/contracts/agent-api'
import { baseNameOf, isInsideTrash, trashRoot } from './paths'

/** `meta.json` 的形状（只在本模块内用，不对浏览器暴露） */
interface TrashMeta {
  id: string
  name: string
  originalPath: string
  deletedAt: number
  isDir: boolean
  size: number
}

function itemDir(id: string): string {
  return join(trashRoot(), id)
}

function metaPath(id: string): string {
  return join(itemDir(id), 'meta.json')
}

function payloadOf(id: string, name: string): string {
  return join(itemDir(id), 'data', name)
}

async function exists(abs: string): Promise<boolean> {
  try {
    await fs.lstat(abs)
    return true
  } catch {
    return false
  }
}

/**
 * 把一条路径移进回收站，返回回收站条目 id。
 *
 * 先 `rename`（同盘瞬间完成），`EXDEV`（跨盘 / 跨设备）才退化成「复制 + 删源」——
 * 与 `ops.ts` 的 `movePath` 同一套判断，只是这里没有进度可报（单条），失败直接抛给界面。
 */
export async function moveToTrash(abs: string): Promise<string> {
  if (isInsideTrash(abs)) throw new Error('不能把回收站自己删掉')
  const stat = await fs.lstat(abs)
  const isDir = stat.isDirectory()
  const name = baseNameOf(abs)
  const id = randomUUID()
  const dataDir = join(itemDir(id), 'data')
  await fs.mkdir(dataDir, { recursive: true })

  const dest = payloadOf(id, name)
  try {
    await fs.rename(abs, dest)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err
    await fs.cp(abs, dest, { recursive: true, force: false, errorOnExist: true })
    await fs.rm(abs, { recursive: true, force: true })
  }

  const meta: TrashMeta = {
    id,
    name,
    originalPath: abs,
    deletedAt: Date.now(),
    isDir,
    size: isDir ? 0 : Number(stat.size) || 0
  }
  await fs.writeFile(metaPath(id), JSON.stringify(meta, null, 2), 'utf8')
  return id
}

/** 回收站清单（新的在前） */
export async function listTrash(): Promise<FmTrashItem[]> {
  const root = trashRoot()
  let ids: string[]
  try {
    const dirents = await fs.readdir(root, { withFileTypes: true })
    ids = dirents.filter((d) => d.isDirectory()).map((d) => d.name)
  } catch {
    // 目录还不存在 = 一次都没删过
    return []
  }
  const items: FmTrashItem[] = []
  for (const id of ids) {
    const meta = await fs
      .readFile(metaPath(id), 'utf8')
      .then((text) => JSON.parse(text) as TrashMeta)
      .catch(() => null)
    // 元数据坏了（手删 / 断电）就跳过：列出来也没法还原，反而挡住别人
    if (!meta) continue
    items.push({
      id,
      name: meta.name,
      originalPath: meta.originalPath,
      deletedAt: meta.deletedAt,
      isDir: meta.isDir,
      size: meta.size
    })
  }
  items.sort((a, b) => b.deletedAt - a.deletedAt)
  return items
}

/** 同目录下第一个没被占用的 `a (n).ext`（`n` 从 1 起） */
async function freeNameIn(dir: string, name: string): Promise<string> {
  const dot = name.lastIndexOf('.')
  // 点开头的隐藏文件（`.env`）没有扩展名可拆
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  for (let i = 1; i <= 999; i++) {
    const candidate = join(dir, `${stem} (${i})${ext}`)
    if (!(await exists(candidate))) return candidate
  }
  throw new Error('原位置同名文件太多，请手动移动')
}

/**
 * 还原一项：放回原路径；原位已有同名东西就加 ` (1)` 后缀。
 *
 * 返回**最终**落地的绝对路径（加了后缀时与 `originalPath` 不同，界面刷新后选中它）。
 */
export async function restoreFromTrash(id: string): Promise<string> {
  const meta = JSON.parse(await fs.readFile(metaPath(id), 'utf8')) as TrashMeta
  const from = payloadOf(id, meta.name)
  const dir = dirname(meta.originalPath)
  await fs.mkdir(dir, { recursive: true })
  const dest = (await exists(meta.originalPath))
    ? await freeNameIn(dir, meta.name)
    : meta.originalPath

  try {
    await fs.rename(from, dest)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err
    await fs.cp(from, dest, { recursive: true, force: false, errorOnExist: true })
    await fs.rm(from, { recursive: true, force: true })
  }
  // 本体已经搬走，整个条目目录一起清掉（meta 也跟着走）
  await fs.rm(itemDir(id), { recursive: true, force: true })
  return dest
}

/** 彻底删掉回收站里的某一项 */
export async function deleteTrashItem(id: string): Promise<void> {
  await fs.rm(itemDir(id), { recursive: true, force: true })
}

/** 清空回收站（连目录一起删；下次 `moveToTrash` 会重新建） */
export async function emptyTrash(): Promise<void> {
  await fs.rm(trashRoot(), { recursive: true, force: true })
}
