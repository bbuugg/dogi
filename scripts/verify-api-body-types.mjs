/**
 * 跑 `scripts/api-body-types.test.ts` —— 接口请求四种请求体形态的验证。
 *
 * 测试体 import 的是**真源码**：
 *   - `src/main/services/api/http.ts`（主进程执行器，真发 HTTP 请求到进程内服务器）
 *   - `src/renderer/src/features/api/api-client.ts`（渲染端纯函数）
 * 两者都只依赖 node: 内置模块与 `@shared/types` 的**类型**导入（类型导入会被擦掉），
 * 所以 `node --experimental-strip-types` 能直接跑，不需要改写 import。
 *
 * 跑：node scripts/verify-api-body-types.mjs
 */
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const child = spawnSync(
  process.execPath,
  ['--experimental-strip-types', join(ROOT, 'scripts/api-body-types.test.ts')],
  {
    cwd: ROOT,
    stdio: 'inherit',
    // WorkBuddy 会往环境里注入 ELECTRON_RUN_AS_NODE / NODE_OPTIONS，剥掉免得干扰子进程
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, NODE_OPTIONS: undefined }
  }
)

process.exit(child.status ?? 1)
