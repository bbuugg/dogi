/**
 * 笔记目录的读写服务层。
 *
 * 分工与 `./projects.ts` 一致：route 侧只做「取参数 → 调这里 → catch 后按 status 回
 * JSON」，路径校验与磁盘操作全部收口在本文件。
 *
 * ## 为什么要有「登记过的根」这一层
 *
 * 工作区的文件接口靠 `resolveInside(workspace.path, rel)` 划边界；而笔记读写的是
 * **用户自己挑的任意目录**，背后没有 workspace 可依。于是先把目录登记进
 * `CoreData.notesRoots`（见 `@fizz/workspace` 的 `addNotesRoot`），每个文件操作再从
 * 登记表取出根、同样走 `resolveInside`。**少了这层，这组接口就是「读写服务端任意
 * 路径」的口子** —— 新增接口时务必保持「先 requireRoot、再 inside」这个顺序。
 *
 * ## 只放行 Markdown
 *
 * `assertMarkdown` 卡死扩展名（`.md` / `.markdown`）。这不是通用文件接口，别为了
 * 「顺手也能看看图片 / json」把它放开 —— 那等于把上面那道边界又拆了。
 *
 * ## 不缓存目录
 *
 * 与 `.gitignore` 那套不同，这里**不做任何缓存**：笔记是用户在别的编辑器里也会改的
 * 东西，缓存的代价是「外部新建的文件看不见」，而这恰恰是用户会点「刷新」的原因。
 */
import type { Dirent } from 'node:fs'
import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'
import type {
  NotesCreateResult,
  NotesDirResult,
  NotesEntry,
  NotesFileResult,
  NotesRenameResult,
  NotesRoot
} from '@fizz/contracts/types'
import { resolveInside } from '@fizz/contracts/workspace'
import { describeError } from './lib/http'
import { domain } from './state'

/** 服务层唯一异常类型：route 侧 catch 后按 status 回 JSON 错误 */
export class NotesServiceError extends Error {
  constructor(
    public status: 400 | 403 | 404 | 409 | 500,
    message: string
  ) {
    super(message)
  }
}

/**
 * route 侧的统一错误映射：笔记服务的异常 → `jsonError` 参数。
 *
 * 状态码联合写成 `jsonError` 接受的那一组（而不是 `ReturnType<typeof describeError>`）：
 * `describeError` 只会给 400 / 500，套上去会把 403 / 404 / 409 全压成 400，
 * 客户端就分不出「越界」「不存在」「重名」了。
 */
export function notesError(err: unknown): {
  status: 400 | 401 | 403 | 404 | 409 | 500 | 502
  message: string
} {
  if (err instanceof NotesServiceError) return { status: err.status, message: err.message }
  return describeError(err)
}

/** 单篇笔记的大小上限（笔记是文本，2MB 已经非常宽；超了宁可报错也不截断保存） */
const MAX_NOTE_BYTES = 2 * 1024 * 1024

/** 只认 Markdown */
const MARKDOWN_RE = /\.(md|markdown)$/i

/**
 * 笔记树里跳过的子目录。
 *
 * **刻意不直接套 `DEFAULT_IGNORE_DIRS`**：那套是给「代码仓库」用的，里面有
 * `dist` / `build` / `out` / `target` / `vendor` 这些**用户完全可能拿来当笔记分类名**
 * 的目录 —— 套上去的表现是「我明明有这个名字的文件夹，侧栏里却看不到」，最容易被
 * 当成 bug 报上来。这里只排两类不可能放笔记的：**点开头的目录**（`.git` /
 * `.obsidian` / `.trash`）和 `node_modules`。
 */
const SKIP_DIRS = new Set(['node_modules'])

function shouldSkipDir(name: string): boolean {
  return name.startsWith('.') || SKIP_DIRS.has(name)
}

/** 取登记过的根；没有（或被移除）就是 404 */
function requireRoot(rootId: string): NotesRoot {
  const root = rootId ? domain.getNotesRoot(rootId) : undefined
  if (!root) throw new NotesServiceError(404, '笔记目录不存在（可能已被移除）')
  return root
}

/**
 * 相对路径规范化：统一 `/` 分隔、剥掉开头的 `/`。
 *
 * 刻意**不在这里判越界** —— 前导 `/` 剥掉后交给 `resolveInside`，绝对路径与 `..`
 * 都由它兜住（与工作区文件接口同一条边界，只有一处判定）。
 */
function normalizeRel(raw: string | null | undefined): string {
  return (raw ?? '').replace(/\\/g, '/').replace(/^\/+/, '').trim()
}

/** 只放行 Markdown：这组接口不是通用文件读写 */
function assertMarkdown(rel: string): void {
  if (!MARKDOWN_RE.test(rel)) throw new NotesServiceError(400, '只支持 .md / .markdown 文件')
}

/** `resolveInside` 的越界异常 → 403 */
function inside(rootPath: string, rel: string): string {
  try {
    return resolveInside(rootPath, rel)
  } catch {
    throw new NotesServiceError(403, '路径越界：笔记接口只允许访问登记过的目录内部')
  }
}

async function statOrNull(p: string) {
  return fs.stat(p).catch(() => null)
}

/**
 * 列某一层（`dir` 是相对根目录的目录路径，根目录传 `''`）。
 *
 * **只列一层**：笔记根可能是很大的目录，递归扫一遍要等很久；前端展开子目录时再单独
 * 请求那一层（懒加载，见 `features/notes`）。
 */
export async function listNotesDir(rootId: string, dir: string): Promise<NotesDirResult> {
  const root = requireRoot(rootId)
  const rel = normalizeRel(dir)
  const abs = inside(root.path, rel)

  const st = await statOrNull(abs)
  if (!st?.isDirectory()) throw new NotesServiceError(404, '目录不存在')

  let dirents: Dirent[]
  try {
    dirents = await fs.readdir(abs, { withFileTypes: true })
  } catch (err) {
    // 权限不足等：说清楚是「读不了」，别伪装成「空目录」
    throw new NotesServiceError(403, `无法读取目录：${(err as Error).message}`)
  }

  const entries: NotesEntry[] = []
  for (const d of dirents) {
    const name = d.name
    const childRel = rel ? `${rel}/${name}` : name
    if (d.isDirectory()) {
      if (shouldSkipDir(name)) continue
      const childStat = await statOrNull(join(abs, name))
      entries.push({ path: childRel, name, type: 'dir', mtime: childStat?.mtimeMs ?? 0, size: 0 })
    } else if (d.isFile() && MARKDOWN_RE.test(name)) {
      const childStat = await statOrNull(join(abs, name))
      entries.push({
        path: childRel,
        name,
        type: 'file',
        mtime: childStat?.mtimeMs ?? 0,
        size: childStat?.size ?? 0
      })
    }
  }

  // 目录在前，各自按名字排序（与文件面板的树同一观感）
  entries.sort((a, b) =>
    a.type === b.type ? a.name.localeCompare(b.name, 'zh') : a.type === 'dir' ? -1 : 1
  )
  return { dir: rel, entries }
}

/** 读一篇笔记 */
export async function readNote(rootId: string, path: string): Promise<NotesFileResult> {
  const root = requireRoot(rootId)
  const rel = normalizeRel(path)
  if (!rel) throw new NotesServiceError(400, '缺少 path')
  assertMarkdown(rel)

  const abs = inside(root.path, rel)
  const st = await statOrNull(abs)
  if (!st?.isFile()) throw new NotesServiceError(404, '笔记不存在')
  if (st.size > MAX_NOTE_BYTES) {
    throw new NotesServiceError(400, `笔记过大（超过 ${Math.round(MAX_NOTE_BYTES / 1024 / 1024)}MB）`)
  }

  const buf = await fs.readFile(abs)
  // 含 NUL 字节 = 不是文本：直接说清楚，别把乱码塞进编辑器让用户以为笔记坏了
  if (buf.includes(0)) throw new NotesServiceError(400, '这不是文本文件')
  return { path: rel, content: buf.toString('utf8') }
}

/** 把一篇笔记整体覆盖写成 `content`（文件不存在就创建） */
export async function writeNote(rootId: string, path: string, content: string): Promise<void> {
  const root = requireRoot(rootId)
  const rel = normalizeRel(path)
  if (!rel) throw new NotesServiceError(400, '缺少 path')
  assertMarkdown(rel)
  if (typeof content !== 'string') throw new NotesServiceError(400, '缺少 content')
  if (Buffer.byteLength(content, 'utf8') > MAX_NOTE_BYTES) {
    throw new NotesServiceError(400, '内容过大，已拒绝写入')
  }

  const abs = inside(root.path, rel)
  // 上级目录被删掉了就补建：笔记是「随手记」，不该因为目录没了就存不进去
  await fs.mkdir(dirname(abs), { recursive: true })
  await fs.writeFile(abs, content, 'utf8')
}

/**
 * 在 `dir` 下新建一篇空笔记，名字自动避让：`未命名.md` → `未命名 2.md` → …
 *
 * 名字由**服务端**取，不让客户端算：客户端算完再写会撞上「算的间隙里别人建了同名」，
 * 而 `wx` 是原子的「不存在才创建」，循环重试即可，两个端同时点也不会互相覆盖。
 */
export async function createNote(rootId: string, dir: string): Promise<NotesCreateResult> {
  const root = requireRoot(rootId)
  const rel = normalizeRel(dir)
  const absDir = inside(root.path, rel)

  const st = await statOrNull(absDir)
  if (!st?.isDirectory()) throw new NotesServiceError(404, '目录不存在')

  for (let i = 1; i <= 999; i++) {
    const name = i === 1 ? '未命名.md' : `未命名 ${i}.md`
    const created = await fs
      .writeFile(join(absDir, name), '', { encoding: 'utf8', flag: 'wx' })
      .then(() => true)
      .catch((err: NodeJS.ErrnoException) => {
        if (err.code === 'EEXIST') return false
        throw err
      })
    if (created) return { path: rel ? `${rel}/${name}` : name }
  }
  throw new NotesServiceError(409, '这个目录里叫「未命名」的笔记太多了，先整理一下吧')
}

/**
 * 重命名：**只换文件名，不换目录**（跨目录移动是另一件事，这版不做）。
 *
 * 同名时返回 409 而不是覆盖 —— 覆盖别人的笔记是不可逆的，宁可不做。
 */
export async function renameNote(
  rootId: string,
  path: string,
  name: string
): Promise<NotesRenameResult> {
  const root = requireRoot(rootId)
  const rel = normalizeRel(path)
  if (!rel) throw new NotesServiceError(400, '缺少 path')
  assertMarkdown(rel)

  const next = markdownFileName(name)
  const abs = inside(root.path, rel)
  const st = await statOrNull(abs)
  if (!st?.isFile()) throw new NotesServiceError(404, '笔记不存在')

  const slash = rel.lastIndexOf('/')
  const dirRel = slash >= 0 ? rel.slice(0, slash) : ''
  const targetRel = dirRel ? `${dirRel}/${next}` : next
  if (targetRel === rel) return { path: rel }

  const targetAbs = inside(root.path, targetRel)
  if (await statOrNull(targetAbs)) {
    throw new NotesServiceError(409, `已经有一篇叫「${next}」的笔记了`)
  }
  await fs.rename(abs, targetAbs)
  return { path: targetRel }
}

/** 删除一篇笔记（**真删**，没有回收站 —— 界面上必须二次确认） */
export async function deleteNote(rootId: string, path: string): Promise<void> {
  const root = requireRoot(rootId)
  const rel = normalizeRel(path)
  if (!rel) throw new NotesServiceError(400, '缺少 path')
  assertMarkdown(rel)

  const abs = inside(root.path, rel)
  const st = await statOrNull(abs)
  if (!st?.isFile()) throw new NotesServiceError(404, '笔记不存在')
  await fs.unlink(abs)
}

/** Windows / POSIX 都不允许出现在文件名里的字符（与 `projects.ts` 的目录名规则同源） */
const ILLEGAL_NAME_CHARS = /[\\/:*?"<>|]/g

/**
 * 把用户输入的名字收拾成**单层**的 Markdown 文件名。
 *
 * 粘了整条路径进来时取最后一段（比报错友好，用户多半是复制路径手滑）；
 * 非法字符剔除；没写扩展名就补 `.md`。
 */
function markdownFileName(raw: string): string {
  const last = (raw ?? '').replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? ''
  const cleaned = last.replace(ILLEGAL_NAME_CHARS, '').replace(/^\.+/, '').trim()
  const named = MARKDOWN_RE.test(cleaned) ? cleaned : `${cleaned}.md`
  if (named === '.md') throw new NotesServiceError(400, '文件名不能为空')
  return named
}
