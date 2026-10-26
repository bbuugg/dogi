/**
 * 宿主注册**必须先于一切 UI / store 模块求值**（与 `apps/mobile/src/bootstrap.ts` 同因同果）。
 *
 * ESM 里 import 先于模块体执行：`main.tsx` 里就算把 `setAgentHost()` 写在实际代码最前面，
 * 只要它上面还有 `import '@fizz/agent-kit'`，agent-kit 的 store 就已经在**模块求值**时
 * 建好、`connection` 初值也当场从宿主读过了 —— 那一刻宿主还没注入，读的是浏览器兜底
 * （`fizz.web.connection`）。
 *
 * 所以拆成独立模块、由 `main.tsx` **第一行 import**：这里的模块体先跑完，后面才轮到
 * agent-kit 求值。
 */
import { setAgentHost } from '@fizz/agent-client/host'
import { extensionHost } from './host'

setAgentHost(extensionHost)
