/**
 * 共享后端的环境准备：**必须在 `@fizz/server` 被导入之前执行**。
 *
 * 为什么单独一个模块、而不是写在 manager.ts 里：`apps/server/src/state.ts` 在**模块初始化
 * 阶段**就读 `FIZZ_DATA_DIR` 并 `await JsonStore.open()`（顶层 await）。ESM 的 import 会被
 * 提升、按「import 语句出现的顺序」求值，所以只能靠「先 import 这个模块」来保证环境变量
 * 已经写好 —— 写在同一个文件里的普通语句会被 server 模块的求值抢先。
 *
 * 数据目录与外部部署的那份统一：桌面复用 `~/.fizz-server`（Next.js / 手动
 * `npm run server` 同一份），这样任意一端写的数据在另一端都可见。实际目录由
 * `resolveDataDir()` 解析（`FIZZ_DATA_DIR` 优先，缺省 `~/.fizz-server`）。
 */
import { join } from 'node:path'
import { homedir } from 'node:os'

// 与 Next.js 根入口保持一致：不在桌面端另开目录，避免数据割裂。
// 仅在未显式设置时才兜底（保留 FIZZ_DATA_DIR 的覆盖能力）。
if (!process.env.FIZZ_DATA_DIR?.trim()) {
  process.env.FIZZ_DATA_DIR = join(homedir(), '.fizz-server')
}
