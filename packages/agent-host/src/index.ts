/**
 * `@fizz/agent-host`：桌面侧 Agent 宿主（Node / Electron，无 React）。
 *
 * 两个宿主共用：
 * - `manager`：把共享的 `@fizz/server` 装进**进程内**（根应用与 apps/desktop 都用它）；
 * - `transport-ipc` / `preload`：`apps/desktop` 渲染端 ↔ 主进程的传输桥
 *   （根应用不用它 —— 根应用的渲染端走自己的 `src/main/ipc/agent.ts` relay）。
 *
 * `./env` 是副作用模块，**必须先于任何 `@fizz/server` 导入求值**，所以单独一个入口
 * （`@fizz/agent-host/env`），由 manager 内部第一时间 import。
 */
export {
  BackendUnavailableError,
  backendManager,
  type BackendStatus
} from './manager'
export { registerAgentTransportIpc } from './transport-ipc'
/**
 * 本机文档（「用本应用打开 .md」）里需要 `apps/desktop` 主进程直接调的两件事：
 * 处理系统事件时**放行**路径（双击关联的 argv / 二次实例 / macOS `open-file`），
 * 以及菜单 / `Ctrl+O` 那条入口要弹的对话框。
 *
 * 读 / 写走 IPC（`AGENT_IPC.localFileRead` / `localFileWrite`），渲染端碰不到；
 * `isAllowedLocalDocument` 只在 `./local-files` 内部用，**不往外出** —— 它不是给别的
 * 模块做「自己判断该不该放行」用的（那样迟早会有人绕开闸）。
 */
export { allowLocalDocument, promptLocalMarkdownFile } from './local-files'
export { isAllowedExternalUrl, openExternalUrl } from './external-link'
export { createAgentTransportBridge } from './preload'
export { killAllPtySessions } from './pty'
export {
  startRemoteAccess,
  stopRemoteAccess,
  getRemoteAccessInfo,
  generateRemotePassword,
  type RemoteAccessInfo
} from './remote-access'
export * from './channels'
