/**
 * 项目服务的纯函数部分:不 import 任何单例 / IO 模块,
 * `lib/server/projects.ts` 与 `scripts/verify-projects.mts` 共用 ——
 * 判定逻辑只写一遍,验证才有意义。
 */
import { resolve, sep } from 'node:path'

const WIN32_RESERVED = new Set([
  'con', 'prn', 'aux', 'nul',
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`)
])

/** 目录名不合法时返回人话原因;合法返回 null(自 fs/dirs 路由迁出,前后端同一套规则) */
export function invalidNameReason(name: string): string | null {
  if (!name) return '文件夹名不能为空'
  if (/[/\\:\0]/.test(name)) return '文件夹名里不能有 / \\ : 这些字符'
  if (name === '.' || name === '..') return '文件夹名不能是 . 或 ..'
  if (process.platform === 'win32') {
    if (WIN32_RESERVED.has(name.toLowerCase())) return `${name} 是 Windows 保留名,换一个`
    if (/[. ]$/.test(name)) return 'Windows 下文件夹名不能用点或空格结尾'
  }
  return null
}

/**
 * `path` 是否在项目根目录之内(含根本身)。
 *
 * 归一化:先 `resolve`(吃掉 `..`、尾分隔符、相对路径),Windows 下再统一小写
 * (NTFS 大小写不敏感)。前缀相同但下一个字符不是分隔符的(`C:\p` vs `C:\p-x`)
 * 不算内 —— 这是「根外路径被误判成根内」的关键防线。
 */
export function isInsideProjectsRoot(path: string, root: string): boolean {
  const norm = (p: string): string => {
    const r = resolve(p)
    return process.platform === 'win32' ? r.toLowerCase() : r
  }
  const p = norm(path)
  const base = norm(root)
  if (p === base) return true
  if (!p.startsWith(base)) return false
  const ch = p[base.length]
  return ch === '\\' || ch === '/'
}

/** worktree 项目的目录容器(相对源项目目录;服务层与 routes 同用这一份) */
export const WORKTREE_DIR = '.worktree'

/**
 * 从 `<父目录>/.worktree/<标识>` 里取出标识;不符合这个形状返回 null。
 * 删除磁盘目录前的路径形状闸(三道闸之一),纯路径判定。
 */
export function worktreeIdentifierOf(worktreePath: string, parentPath: string): string | null {
  const prefix = `${resolve(parentPath, WORKTREE_DIR)}${sep}`
  const resolved = resolve(worktreePath)
  if (!resolved.startsWith(prefix)) return null
  const name = resolved.slice(prefix.length)
  return name && !name.includes(sep) ? name : null
}
