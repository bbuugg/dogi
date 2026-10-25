/**
 * 文件管理器的路径工具：**只有归一化与底线校验，没有根目录围栏**。
 *
 * ## 为什么这里没有 `resolveInside`
 *
 * 工作区那一套（`@fizz/contracts/workspace` 的 `resolveInside`）把一切路径夹在工作区根
 * 里面，那是给 Agent 工具用的「越界就 403」。文件管理器是**用户自己的手**——他要翻
 * `~/.ssh`、要删 `/tmp/xxx`、要在 D 盘建目录，夹住就等于这个功能废掉。
 *
 * 所以这里只做三件事：
 * 1. **归一化**（`~` 展开、相对路径按主目录解析、`C:` → `C:\`）；
 * 2. 校验**单层名字**（新建 / 重命名时）——防止有人用 `../x` 当文件名；
 * 3. 标出回收站自己的位置（`isInsideTrash`），因为回收站是**程序自己管的目录**，
 *    用户在里面删东西会把这个功能的元数据搞坏。
 *
 * 鉴权在外层（`/api/*` 全要 JWT），这一层不再是安全边界 —— 它就是「用户登录后的手」。
 */
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path'
import { resolveDataDir } from '@fizz/workspace'

/** 服务端用户的 home 目录（每次现取：测试里会改 `HOME` / `USERPROFILE`） */
export function homeDir(): string {
  return homedir()
}

/**
 * 把界面上来的路径串归一化成**绝对路径**。
 *
 * - 空串 / 缺省 → 主目录（文件管理器打开时的落点）；
 * - `~` / `~/x`（Windows 也接受 `~\x`）→ 主目录 / 主目录下的 x；
 * - Windows 上裸盘符 `C:` 补成 `C:\`（`resolve('C:')` 会给出**当前盘的工作目录**，
 *   那不是用户点盘符时想要的东西）；
 * - 其余按 `resolve` 处理（相对路径以服务端进程的 cwd 为基准，界面上不该出现，
 *   但 API 直接调时可能出现，给个确定行为）。
 */
export function normalizeTarget(input: string | null | undefined): string {
  const raw = (input ?? '').trim()
  if (!raw) return homeDir()
  if (raw === '~') return homeDir()
  if (raw.startsWith('~/') || raw.startsWith('~\\')) return resolve(homeDir(), raw.slice(2))
  // 裸盘符：`C:` / `c:`（后面不能再跟分隔符，否则是正常路径）
  if (/^[a-zA-Z]:$/.test(raw)) return `${raw}\\`
  return normalize(isAbsolute(raw) ? raw : resolve(raw))
}

/**
 * 校验「单层名字」（新建文件 / 文件夹、重命名用）。
 *
 * 允许中文、空格、点（`a.txt` 合法），拒绝：空、`.`、`..`、含路径分隔符、含 Windows
 * 非法字符 `<>:"|?*`、含 NUL。**服务端必须再校验一遍** —— 前端拦不住的。
 */
export function assertEntryName(name: string | null | undefined): string {
  const value = (name ?? '').trim()
  if (!value) throw new Error('名字不能为空')
  if (value === '.' || value === '..') throw new Error('名字不能是 `.` 或 `..`')
  if (/[\\/]/.test(value)) throw new Error('名字里不能带路径分隔符')
  // Windows 上这些字符连创建都创建不出来；POSIX 上允许但会让人以为是路径
  if (/[<>:"|?*\u0000-\u001f]/.test(value)) throw new Error('名字里不能带 < > : " | ? * 这些字符')
  return value
}

/** 回收站根目录（数据目录下；`FIZZ_DATA_DIR` 决定它到底在哪） */
export function trashRoot(): string {
  return join(resolveDataDir(), 'file-manager-trash')
}

/** 这个路径是不是落在回收站里面（回收站自己不可删 / 不可 trash） */
export function isInsideTrash(abs: string): boolean {
  const root = trashRoot()
  return abs === root || abs.startsWith(root.endsWith(sep) ? root : root + sep)
}

/**
 * 上级目录；已经在根（`/`、`C:\`）时返回 null。
 *
 * `dirname('/') === '/'`、`dirname('C:\\') === 'C:\\'` —— 判「有没有变」就够了，
 * 不用自己拆盘符。
 */
export function parentOf(abs: string): string | null {
  const up = dirname(abs)
  return up === abs ? null : up
}

/** 人类可读的名字（找不到就返回空串，用于提示语与下载文件名） */
export function baseNameOf(abs: string): string {
  const name = basename(abs)
  // `C:\` 的 basename 是空串，退化成盘符本身（`C:`），免得界面上出现空名字
  return name || abs.replace(/[\\/]+$/, '') || abs
}

/**
 * 同目录下取一个不冲突的名字：`a.txt` → `a (1).txt` → `a (2).txt`…
 *
 * `taken` 由调用方给（异步判断存在性的活儿不放在纯函数里），这样回收站还原、跨目录
 * 复制、解压三处都能按同一套规则避让重名。
 */
export function uniqueName(name: string, taken: (candidate: string) => boolean): string {
  if (!taken(name)) return name
  const dot = name.lastIndexOf('.')
  // 点开头的隐藏文件（`.env`）没有扩展名可拆
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  for (let i = 1; i < 1000; i++) {
    const candidate = `${stem} (${i})${ext}`
    if (!taken(candidate)) return candidate
  }
  throw new Error('同名文件太多，换一个名字再试')
}
