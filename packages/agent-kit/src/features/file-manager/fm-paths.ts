/**
 * 文件管理器的**纯路径工具**（零 React、零 IO）。
 *
 * 单独拆一个文件不是为了好看：这些函数要能被 vitest 直接测（`use-file-manager.ts`
 * 一导进来就带着 React 与 `@fizz/agent-client`），而它们又刚好是**最容易出错**的地方 ——
 * 同一份逻辑要同时伺候 `C:\a\b` 与 `/a/b` 两种路径，写错一个分隔符就是「拖到文件夹上
 * 什么都没发生」或「把目录挪进它自己里面」。
 *
 * ⚠️ 所有判断都**只做字符串层面**的推断，不碰文件系统：解析不了的一律返回保守结果
 * （比如 `dirOf` 看不出分隔符就把原串当目录），让服务端去给准确答案。
 */

/**
 * 拼一段子路径（保持原路径的分隔符风格）。
 *
 * 不能无脑用 `/`：Windows 的 `C:\a` 拼成 `C:\a/b` 也能被服务端的 `path.join` 认，
 * 但**回显**给用户的面包屑就花了。按已有路径里出现的分隔符决定，根路径（`C:\`、`/`）
 * 已经带结尾分隔符时直接接上。
 */
export function joinFsPath(dir: string, name: string): string {
  if (dir.endsWith('/') || dir.endsWith('\\')) return `${dir}${name}`
  return `${dir}${dir.includes('\\') && !dir.includes('/') ? '\\' : '/'}${name}`
}

/** 把完整路径拆成面包屑（Windows 盘符 / POSIX 根都要能拆） */
export function breadcrumbOf(path: string): { label: string; path: string }[] {
  if (!path) return []
  // Windows：`C:\a\b` → 段 `C:` / `a` / `b`，逐段拼回时用 `\` 分隔
  const win = /^[a-zA-Z]:/.test(path)
  const sep = win ? '\\' : '/'
  const parts = path.split(/[\\/]/).filter(Boolean)
  const crumbs: { label: string; path: string }[] = []
  let acc = win ? '' : '/'
  parts.forEach((part, i) => {
    if (win && i === 0) {
      acc = `${part}\\`
      crumbs.push({ label: part, path: acc })
      return
    }
    acc = acc.endsWith(sep) ? `${acc}${part}` : `${acc}${sep}${part}`
    crumbs.push({ label: part, path: acc })
  })
  return crumbs
}

/** 去掉末尾分隔符（根路径 `C:\` → `C:`、`/` 原样保留）—— 只用于比较，不改真路径 */
export function trimSep(path: string): string {
  return path.length > 1 ? path.replace(/[\\/]+$/, '') : path
}

/** 路径所在的目录（`C:\a\b` → `C:\a`；`C:\a` → `C:\`；`/a` → `/`） */
export function dirOf(path: string): string {
  const at = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  if (at < 0) return path
  // 分隔符在 0 位：POSIX 根
  if (at === 0) return path.slice(0, 1)
  const head = path.slice(0, at)
  // `C:\a` 的目录是 `C:\`（带上那根分隔符，否则变成相对盘符 `C:`）
  return /^[a-zA-Z]:$/.test(head) ? path.slice(0, at + 1) : head
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * `candidate` 是不是落在 `dir` 里面（**含相等**）。
 *
 * 拖拽移动要挡两件事：把目录拖进它自己、拖进它自己的子目录 —— 两者服务端都会抛
 * `ConflictError`，但在**开始拖的那一刻**就能判断，界面宁可不让落点高亮，也别让用户
 * 拖过去再吃一个报错。
 *
 * 注意参数顺序（与 `node:path` 的 `relative` 相反）：第一个是**容器**，第二个是待判定的。
 */
export function isInsideDir(dir: string, candidate: string): boolean {
  const base = trimSep(dir)
  if (trimSep(candidate) === base) return true
  if (base === '') return false
  return new RegExp(`^${escapeRegExp(base)}[\\\\/]`).test(candidate)
}

/** 路径最后一段（文件名 / 目录名） */
export function nameOf(path: string): string {
  const at = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return at < 0 ? path : path.slice(at + 1)
}
