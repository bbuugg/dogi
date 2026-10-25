/**
 * 应用日志的**内置命名空间清单**：server 侧各功能模块自报家门。
 *
 * 为什么集中一份而不是散在各功能文件顶部：应用日志的写入点（`appLog.info('ssh', …)`）
 * 大多在 `apps/server/src/server/<功能>/` 下，而那些模块是被 `background.ts` **动态
 * import** 拉起的（隧道自启、任务巡检…）—— 若把 `registerNamespace` 写在各自文件里，
 * 「某个模块这轮没被 import」就看不到它的 Tab，即使它曾经记过日志。集中注册保证
 * **启动即全部可见**，且新增功能只需在这里加一行（这就是「自动注册」的落点）。
 *
 * ⚠️ 加了新命名空间要**同时**在这里注册 + 在业务代码里 `appLog.xxx('<id>', …)`；
 * 只写日志不注册也不会丢（`appLog` 内部会自动兜底登记），只是 Tab 名会退化成 id、
 * 且排在最后。
 */
import { registerNamespace } from '@fizz/workspace'

/** 内置命名空间。`order` 只给需要钉住位置的项，其余按注册顺序排在后面 */
export function registerBuiltinNamespaces(): void {
  registerNamespace({ id: 'app', label: '应用', order: 0 })
  registerNamespace({ id: 'workspace', label: '工作区', order: 10 })
  registerNamespace({ id: 'chat', label: '对话', order: 20 })
  registerNamespace({ id: 'agent', label: 'Agent', order: 30 })
  registerNamespace({ id: 'task', label: '任务', order: 40 })
  registerNamespace({ id: 'container', label: '容器', order: 50 })
  registerNamespace({ id: 'ssh', label: 'SSH', order: 60 })
  registerNamespace({ id: 'terminal', label: '终端', order: 70 })
  registerNamespace({ id: 'tunnel', label: '隧道', order: 80 })
  registerNamespace({ id: 'sftp', label: 'SFTP', order: 90 })
  registerNamespace({ id: 'git', label: 'Git', order: 100 })
  registerNamespace({ id: 'plugin', label: '插件', order: 110 })
  registerNamespace({ id: 'mcp', label: 'MCP', order: 120 })
  registerNamespace({ id: 'browser', label: '浏览器', order: 130 })
  registerNamespace({ id: 'auth', label: '鉴权', order: 140 })
  registerNamespace({ id: 'system', label: '系统', order: 150 })
}
