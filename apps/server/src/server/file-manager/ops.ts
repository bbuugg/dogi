/**
 * 文件管理器的**改动**动作（新建 / 改名 / 复制 / 移动 / 删除 / 还原 / 写文本 / 压缩 / 解压）。
 *
 * ## 三条贯穿全文件的规矩
 *
 * 1. **绝不静默覆盖**：目标已存在时抛 `ConflictError`（路由映射成 409），由界面问用户。
 *    覆盖是不可逆的，而「我以为它是另存一份」是最常见的手滑。
 * 2. **一次一个路径**：复制 / 移动 / 删除 / 还原都是单条，批量由客户端循环发 ——
 *    进度条才有「第 3 / 共 12 项」可言，也不会让一个长拷贝挂死在一个请求上。
 * 3. **回收站自己不可删**：`isInsideTrash` 的判定集中在这里，界面不需要知道回收站长什么样。
 */
import { promises as fs } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import type { FmOpInput, FmOpResult } from '@fizz/contracts/agent-api'
import { zipPaths } from '@/lib/server/lib/zip'
import { extractArchive } from './archive'
import { assertEntryName, baseNameOf, isInsideTrash, normalizeTarget } from './paths'
import { deleteTrashItem, emptyTrash, moveToTrash, restoreFromTrash } from './trash'

/**
 * 「目标已存在」/「同名冲突」专用的错误。
 *
 * 单独一类而不是靠消息正则：路由要把它映射成 **409**（客户端据此弹「覆盖 / 换名」），
 * 而 `describeError` 里那套「不存在 / 已经存在」的关键词判定只会给 400 —— 400 与 409
 * 在界面上是两种提示，别混。
 */
export class ConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConflictError'
  }
}

async function exists(abs: string): Promise<boolean> {
  try {
    await fs.lstat(abs)
    return true
  } catch {
    return false
  }
}

/** `to` 是不是落在 `root` 里面（复制 / 移动时要挡住「拷进自己」这种死循环） */
function isInside(root: string, candidate: string): boolean {
  const withSep = root.endsWith(sep) ? root : root + sep
  return candidate === root || candidate.startsWith(withSep)
}

/**
 * 复制一条路径到目录 `to`（递归）。
 *
 * `fs.cp` 从 Node 16.7 起就有，`verbatimSymlinks: false` 是默认值 —— 链接按**内容**复制，
 * 复制出来的不是指向原处的第二个链接（对「拷一份走」这个用途更符合直觉）。
 */
async function copyPath(from: string, to: string): Promise<string> {
  const target = join(to, baseNameOf(from))
  if (target === from) throw new ConflictError('目标就是它自己')
  if (isInside(from, target)) throw new ConflictError('不能把一个目录复制到它自己里面')
  if (await exists(target)) throw new ConflictError(`目标里已经有同名的「${baseNameOf(from)}」`)
  await fs.mkdir(to, { recursive: true })
  await fs.cp(from, target, { recursive: true, errorOnExist: true, force: false })
  return target
}

/**
 * 移动一条路径到目录 `to`。
 *
 * 先 `rename`（同盘瞬间完成、原子）；`EXDEV` 说明跨盘 / 跨设备 —— 退化成
 * 「复制 + 删源」。跨盘那趟**没有事务性**：复制完整了才删源，中途失败源还在。
 */
async function movePath(from: string, to: string): Promise<string> {
  const target = join(to, baseNameOf(from))
  if (target === from) throw new ConflictError('目标就是它自己')
  if (isInside(from, target)) throw new ConflictError('不能把一个目录移动到它自己里面')
  if (await exists(target)) throw new ConflictError(`目标里已经有同名的「${baseNameOf(from)}」`)
  await fs.mkdir(to, { recursive: true })
  try {
    await fs.rename(from, target)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err
    await fs.cp(from, target, { recursive: true, errorOnExist: true, force: false })
    await fs.rm(from, { recursive: true, force: true })
  }
  return target
}

/** 批量重命名：`base (1).ext`、`base (2).ext`…（保留各自的扩展名） */
async function batchRename(paths: string[], base: string): Promise<string[]> {
  const cleaned = assertEntryName(base)
  const out: string[] = []
  for (let i = 0; i < paths.length; i++) {
    const from = normalizeTarget(paths[i])
    const name = baseNameOf(from)
    const dot = name.lastIndexOf('.')
    // 点开头的隐藏文件（`.env`）不拆扩展名
    const ext = dot > 0 ? name.slice(dot) : ''
    const target = join(dirname(from), `${cleaned} (${i + 1})${ext}`)
    if (await exists(target)) throw new ConflictError(`「${cleaned} (${i + 1})${ext}」已存在`)
    await fs.rename(from, target)
    out.push(target)
  }
  return out
}

/** 执行一条改动动作 */
export async function runOp(input: FmOpInput): Promise<FmOpResult> {
  switch (input.op) {
    case 'mkdir': {
      const name = assertEntryName(input.name)
      const parent = normalizeTarget(input.parent)
      const target = join(parent, name)
      if (await exists(target)) throw new ConflictError(`「${name}」已存在`)
      await fs.mkdir(target)
      return { paths: [target] }
    }
    case 'create': {
      const name = assertEntryName(input.name)
      const parent = normalizeTarget(input.parent)
      const target = join(parent, name)
      // `wx`：不存在才建。比先 stat 再写少一个竞态窗口
      await fs.writeFile(target, '', { flag: 'wx' }).catch((err: NodeJS.ErrnoException) => {
        if (err.code === 'EEXIST') throw new ConflictError(`「${name}」已存在`)
        throw err
      })
      return { paths: [target] }
    }
    case 'rename': {
      const from = normalizeTarget(input.path)
      const name = assertEntryName(input.name)
      if (isInsideTrash(from)) throw new Error('回收站里的条目不支持改名')
      const target = join(dirname(from), name)
      if (target === from) return { paths: [from] }
      if (await exists(target)) throw new ConflictError(`「${name}」已存在`)
      await fs.rename(from, target)
      return { paths: [target] }
    }
    case 'batchRename':
      return { paths: await batchRename(input.paths, input.base) }
    case 'copy': {
      const from = normalizeTarget(input.path)
      if (isInsideTrash(from)) throw new Error('回收站里的条目请先还原再复制')
      return { paths: [await copyPath(from, normalizeTarget(input.to))] }
    }
    case 'move': {
      const from = normalizeTarget(input.path)
      if (isInsideTrash(from)) throw new Error('回收站里的条目请先还原再移动')
      return { paths: [await movePath(from, normalizeTarget(input.to))] }
    }
    case 'trash': {
      const target = normalizeTarget(input.path)
      await moveToTrash(target)
      return {}
    }
    case 'delete': {
      const target = normalizeTarget(input.path)
      if (isInsideTrash(target)) throw new Error('回收站里的条目请用「清空 / 彻底删除」')
      await fs.rm(target, { recursive: true, force: false })
      return {}
    }
    case 'restore':
      return { paths: [await restoreFromTrash(input.id)] }
    case 'deleteTrash':
      await deleteTrashItem(input.id)
      return {}
    case 'emptyTrash':
      await emptyTrash()
      return {}
    case 'write': {
      const target = normalizeTarget(input.path)
      await fs.writeFile(target, input.content, 'utf8')
      return { paths: [target] }
    }
    case 'compress': {
      const to = normalizeTarget(input.to)
      if (await exists(to)) throw new ConflictError(`「${baseNameOf(to)}」已存在`)
      const sources = input.paths.map((p) => normalizeTarget(p))
      if (!sources.length) throw new Error('没有选中要压缩的东西')
      const { buffer, skipped } = await zipPaths(sources)
      await fs.mkdir(dirname(to), { recursive: true })
      await fs.writeFile(to, buffer)
      return { paths: [to], ...(skipped ? { skipped } : {}) }
    }
    case 'extract': {
      const from = normalizeTarget(input.path)
      const to = normalizeTarget(input.to)
      if (isInside(from, to)) throw new Error('不能解压到压缩包自己里面')
      const count = await extractArchive(from, to)
      return { paths: [to], message: `已解出 ${count} 个文件` }
    }
    default: {
      // 穷尽性检查：`FmOpInput` 加了新成员而这里没跟上时，tsc 会在这行报错
      const never: never = input
      throw new Error(`未知动作：${JSON.stringify(never)}`)
    }
  }
}
