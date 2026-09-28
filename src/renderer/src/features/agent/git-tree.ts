import type { GitChange } from '@shared/types'

/** 手写树（源代码管理列表）每加深一级的缩进（px） */
export const INDENT = 12

/** 树的行模型：目录（可继续展开）、文件（展开看 diff）、目录条目（git 的 `dir/` 一行） */
export type RowNode =
  | {
      kind: 'dir'
      path: string
      name: string
      children: RowNode[]
      /** 该目录下所有变更条目的路径（含子目录）：供目录行「整目录暂存 / 回退」用 */
      paths: string[]
    }
  | { kind: 'file'; change: GitChange; letter: string; name: string }
  /**
   * git 的**目录条目**本身：路径带尾斜杠（`nested/`）。
   *
   * 未跟踪的嵌套仓库（内嵌 `.git`）、链接目录这类东西，git 即使 `-uall` 也不往里走，
   * 只给一行 `?? nested/` —— 展开没有意义（没有可列的文件），它等价于「未跟踪的目录」，
   * 可以整体暂存 / 回退。
   */
  | { kind: 'dirEntry'; change: GitChange; name: string }

/**
 * 把一组变更按路径折成目录树（纯数据，渲染见 GitPanel 的 renderRows）。
 *
 * 为什么要折：主进程用 `git status -uall` 把未跟踪目录摊成「每个文件一行」，
 * 新建一个目录往往一次带出十几条同前缀路径 —— 不折就是一大片平铺的完整路径。
 *
 * ⚠️ 目录 / 文件的显示名统一取**路径末段**（`name`），完整路径留在 `path` 里给 tooltip。
 * 名字在建树时一次算好，不要到渲染时再 `slice(lastIndexOf('/') + 1)` 现切：
 * 多级目录下那种算术很容易看错层级（二级目录名显示异常就是这么来的）。
 */
export function buildRows(files: Array<{ change: GitChange; letter: string }>): RowNode[] {
  interface Row {
    change: GitChange
    letter: string
    name: string
    /** git 的目录条目（路径带尾斜杠） */
    dirEntry: boolean
  }
  interface Dir {
    /** 从仓库根起的完整目录路径 */
    path: string
    /** 本段目录名（显示用） */
    name: string
    dirs: Map<string, Dir>
    files: Row[]
  }
  const root: Dir = { path: '', name: '', dirs: new Map(), files: [] }
  for (const f of files) {
    // ⚠️ git 的目录条目路径带尾斜杠（`nested/`）：尾段是空串，直接当文件名会渲染出一个
    // 没有名字的行（用户报告「更改区里有一个没有文件名的文件，前面是问号」）。先剥掉它。
    const dirEntry = f.change.path.endsWith('/')
    const segs = f.change.path.split('/')
    if (dirEntry) segs.pop()
    const name = segs.pop() ?? f.change.path
    let cur = root
    let prefix = ''
    for (const seg of segs) {
      prefix = prefix ? `${prefix}/${seg}` : seg
      let child = cur.dirs.get(seg)
      if (!child) {
        child = { path: prefix, name: seg, dirs: new Map(), files: [] }
        cur.dirs.set(seg, child)
      }
      cur = child
    }
    cur.files.push({ ...f, name, dirEntry })
  }
  /** 该目录下所有变更条目的路径（递归含子目录），给目录行的「整目录暂存 / 回退」用 */
  const collectPaths = (node: Dir): string[] => [
    ...node.files.map((f) => f.change.path),
    ...[...node.dirs.values()].flatMap(collectPaths)
  ]
  const toRows = (node: Dir): RowNode[] => [
    // 目录在前、文件在后（顺序即 git 输出顺序，路径已排好序）
    ...[...node.dirs.values()].map(
      (dir): RowNode => ({
        kind: 'dir',
        path: dir.path,
        name: dir.name,
        children: toRows(dir),
        paths: collectPaths(dir)
      })
    ),
    ...node.files.map(
      (f): RowNode =>
        f.dirEntry
          ? { kind: 'dirEntry', change: f.change, name: f.name }
          : { kind: 'file', change: f.change, letter: f.letter, name: f.name }
    )
  ]
  return toRows(root)
}
