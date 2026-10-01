/**
 * 笔记目录（根）的路径比较工具。主进程与渲染端必须对「是不是同一个目录」算出同一个
 * 结论：打开时去重（同一目录在侧边栏只出现一次）、会话恢复时判断「文件属于哪个根」，
 * 都靠这里。只做字符串形态判断，不访问磁盘。
 */

/** Windows / macOS 默认文件系统大小写不敏感（Linux 敏感） */
function caseInsensitiveFs(): boolean {
  // 主进程 / preload 有 process；渲染端主世界没有（contextIsolation 下 process 只存在于
  // preload 的隔离世界），用 navigator.platform 兜底（Win32 / MacIntel / Linux …）
  if (typeof process !== 'undefined' && (process.platform === 'win32' || process.platform === 'darwin')) {
    return true
  }
  if (typeof navigator !== 'undefined') {
    return /(^win|mac)/i.test(navigator.platform)
  }
  return false
}

/** 统一成正斜杠、去掉尾部分隔符，（大小写不敏感文件系统上）转小写 —— 仅用于比较 */
function normForCompare(p: string): string {
  const unified = p.replace(/[\\/]+$/, '').replace(/\\/g, '/')
  return caseInsensitiveFs() ? unified.toLowerCase() : unified
}

/** 两个目录是否同一个（同一目录只允许在侧边栏出现一次） */
export function sameNoteRoot(a: string, b: string): boolean {
  return normForCompare(a) === normForCompare(b)
}

/** abs 是否是 root 本身或 root 之下的路径（父子目录同时打开时，两棵树都会含同一文件） */
export function isUnderNoteRoot(abs: string, root: string): boolean {
  const r = normForCompare(root)
  const a = normForCompare(abs)
  return a === r || a.startsWith(`${r}/`)
}
