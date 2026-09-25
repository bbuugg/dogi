/**
 * SFTP 远端路径工具（主进程服务与渲染端共用）。
 *
 * 远端一律按 posix 处理，且**必须归一化**：`//data`、`/data/` 这类写法服务端多数能接受，
 * 但会把路径栏显示成双斜杠（用户报过「/ 后面多了一个 /」），从 readdir 拼出来的子路径
 * 也会跟着带上，越点越乱。所有「拼路径」与「用户输入路径」都过这两个函数。
 */

/** 归一化：反斜杠转正斜杠、折叠重复斜杠、补前导斜杠、去掉尾部斜杠（根目录除外） */
export function normalizeSftpPath(input: string): string {
  const raw = String(input ?? '').trim()
  if (!raw) return '/'
  let p = raw.replace(/\\/g, '/').replace(/\/{2,}/g, '/')
  if (!p.startsWith('/')) p = '/' + p
  if (p.length > 1) p = p.replace(/\/+$/, '')
  return p || '/'
}

/** 在目录下拼一项（根目录不会再拼出双斜杠：`/` + `name` → `/name`） */
export function joinSftpPath(dir: string, name: string): string {
  const base = normalizeSftpPath(dir)
  return base === '/' ? `/${name}` : `${base}/${name}`
}
