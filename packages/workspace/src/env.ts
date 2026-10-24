/**
 * `.env` 文件加载：**薄封装 `dotenv`**，解析语法不再自己维护。
 *
 * 为什么还需要这一层（而不是各处直接 `config()`）：
 * - **候选目录**：本项目按「cwd → 上层目录」的顺序找，只认**第一个存在的文件**；
 *   dotenv 传 `path: []` 数组是「多个文件合并」的语义，和我们要的「先命中者生效」不同；
 * - **`FIZZ_SKIP_ENV_FILE=1`**：端到端验证靠它屏蔽开发者本地 `.env`，dotenv 没有等价开关；
 * - **回填明细**：server 启动日志要打「补齐了哪几项」，得知道哪些键是真的写进去的。
 *
 * 两条规矩由 dotenv 的默认行为保证（与旧的手写解析器一致）：
 * - **真实环境变量优先**：`override` 默认 false，`.env` 只补「还没设」的变量；
 * - 只认 `KEY=VALUE`（`#` 注释、可选引号、`export ` 前缀），**不做变量展开**。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { config } from 'dotenv'

/** `.env` 的加载结果：路径 + 实际补齐了哪些变量（便于启动时如实打印来源） */
export interface EnvFileResult {
  file: string
  keys: string[]
}

/**
 * 从 `.env` 里补齐环境变量。
 *
 * @param dirs 候选目录，按优先级排列（通常：cwd → 产物目录 → 仓库根）
 * @returns 实际读到的文件与被填入的变量名（没读到返回 null）
 */
export function loadEnvFile(dirs: string[]): EnvFileResult | null {
  // 显式关闭：端到端验证要起真实 server，本地 .env 里的值不能混进来影响断言
  if (process.env.FIZZ_SKIP_ENV_FILE === '1') return null
  const file = dirs.map((dir) => join(dir, '.env')).find((candidate) => existsSync(candidate))
  if (!file) return null
  const existed = new Set(Object.keys(process.env))
  const { parsed, error } = config({ path: file, quiet: true })
  if (error || !parsed) return null
  // `parsed` 是文件里的全部键；真正被写进去的只有原本没设过的那些
  const keys = Object.keys(parsed).filter((key) => !existed.has(key))
  return { file, keys }
}
