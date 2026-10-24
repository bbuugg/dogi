/**
 * 宿主注册**必须先于一切 UI / store 模块求值**。
 *
 * ESM 里 import 先于模块体执行：main.tsx 里 `setAgentHost()` 虽然写在 `createRoot()`
 * 之前，但 `import '@fizz/agent-kit'`（store 在模块求值时就建好、`connection:
 * loadConnection()` 当场执行）已经在 main 的模块体运行**之前**求值完了 —— 那一刻宿主
 * 还没注入，`loadConnection()` 落到浏览器兜底、读 `fizz.web.connection`。
 *
 * hosted `/m` 与 web 同源部署时这个坑是实打实的：手机用过 web 响应式版，
 * `fizz.web.connection` 里有有效 token → 页面「看起来已登录」（HTTP 全通），而
 * 终端 / 工作台 / `/api/state` 走宿主读 `fizz.mobile.connection`（空）——
 * 开终端直接抛「未连接服务端」（实测 2026-10）。
 *
 * 所以拆成独立模块、由 main.tsx **第一行 import**：模块体（setAgentHost）先于任何
 * agent-kit 模块执行，store 初值从宿主（`fizz.mobile.connection`）读，
 * `hydrateConnection` 只兜「宿主注入后又有变化」的边角。
 */
import { setAgentHost } from '@fizz/agent-client/host'
import { mobileHost } from './host'

setAgentHost(mobileHost)
