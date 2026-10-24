/**
 * 容器型项目的 slug 生成 —— **零依赖**，好让 vitest 直接跑（无需 alias / 构建）。
 *
 * slug 同时是三个东西的身份：
 *  1. 项目目录名（`<容器项目根>/<slug>`）；
 *  2. 容器名后缀（`fizz-proj-<slug>`）；
 *  3. 公网子域标签（`https://<slug>.<域名>`）。
 *
 * 所以它必须是**合法子域标签**：只含 `[a-z0-9]`、长度 ≤ 63、**不以数字开头**
 * （子域首字符不能是数字）。随机性即凭证：slug 不可猜 → 公网 URL 不做鉴权的前提。
 */
import { randomBytes } from 'node:crypto'

/** 非首字符可选字符集：小写字母 + 数字 */
const ALNUM = 'abcdefghijklmnopqrstuvwxyz0123456789'
/** 首字符字符集：只字母（子域标签不能以数字开头） */
const LETTERS = 'abcdefghijklmnopqrstuvwxyz'
/** slug 长度 */
const SLUG_LEN = 12

/**
 * 生成一个 slug：**恒 12 位**、首位字母、其余 `[a-z0-9]`。
 *
 * 为什么不用「`randomBytes().toString('base64url')` 再过滤非字母数字」那条路：
 * base64url 的 16 个字符里 `-` / `_` 会被滤掉，**过滤后长度不再是 12**（少则 14、
 * 多则 15），于是「定长」这条不成立。这里改成按字节逐位映射到目标字符集 ——
 * 长度恒为 12、字符集可控。熵约 62 bit（26 × 36¹¹），实际重试几乎不发生。
 */
export function generateSlug(): string {
  const bytes = randomBytes(SLUG_LEN)
  let out = LETTERS[bytes[0] % LETTERS.length]
  for (let i = 1; i < SLUG_LEN; i++) out += ALNUM[bytes[i] % ALNUM.length]
  return out
}

/**
 * 挑一个不在 `taken` 里的 slug（`taken` = 已登记工作区路径 basename 与根下已有目录名
 * 的并集）。
 *
 * 撞了就重来：slug 空间 ~2^61，正常安装下第一次必中。重试 1000 次仍冲突 = 调用方
 * 给的 `taken` 不正常（比如它是个「生成器」每次返回同一个值），直接抛错而不是死循环。
 */
export function uniqueSlug(taken: Iterable<string>): string {
  const set = taken instanceof Set ? taken : new Set(taken)
  for (let i = 0; i < 1000; i++) {
    const s = generateSlug()
    if (!set.has(s)) return s
  }
  throw new Error('无法生成唯一 slug：已占用集合异常（重试 1000 次仍冲突）')
}
