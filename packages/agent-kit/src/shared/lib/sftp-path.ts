/**
 * 远端 SFTP 路径的归一化与拼接（渲染端）。
 *
 * ⚠️ 与服务端 `apps/server/src/server/ssh/sftp.ts` 里的同名函数是**一份逻辑两处实现**。
 * 之所以不放进 `@fizz/contracts` 共用：服务端那两份是「服务端 SFTP 服务」的一部分
 * （就在那个文件里、被 SftpService 直接调），抽到 contracts 会让一份纯粹的路径工具
 * 反过来依赖一个具体服务的文件位置；而这里的规则非常稳定（就是斜杠那点事），
 * 两处各写一遍、注释互相指着，比为一个 5 行的函数新开一个 contracts 子入口更划算。
 *
 * 规则（两边必须一致）：
 * - 反斜杠转正斜杠；
 * - 折叠重复斜杠；
 * - 补前导斜杠；
 * - 去掉尾部斜杠（根 `/` 除外）；
 * - 空输入 → `/`。
 */

/** 归一化远端路径 */
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
