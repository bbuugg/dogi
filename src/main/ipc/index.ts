import type { BrowserWindow } from 'electron'
import { registerAgentIpc } from './agent'
import { registerAiIpc } from './ai'
import { registerApiIpc } from './api'
import { registerFollowupIpc } from './ask-followup'
import { registerGitIpc } from './git'
import { registerHistoryIpc } from './history'
import { registerBrowserIpc } from './browser'
import { registerClientToolsIpc } from './client-tools'
import { registerHostsIpc } from './hosts'
import { registerLogsIpc } from './logs'
import { registerMcpIpc } from './mcp'
import { registerMonitorIpc } from './monitor'
import { registerNotesIpc } from './notes'
import { registerOpenerIpc } from './opener'
import { registerPluginsIpc } from './plugins'
import { registerRdpIpc } from './rdp'
import { registerScriptsIpc } from './scripts'
import { registerSkillsIpc } from './skills'
import { createIpcContext } from './shared'
import { registerSftpIpc } from './sftp'
import { registerSystemIpc } from './system'
import { registerTerminalIpc } from './terminal'
import { registerTransferIpc } from './transfer'
import { registerUpdaterIpc } from './updater'
import { registerTunnelsIpc } from './tunnels'

export { openExternalSafe } from './shared'

/**
 * 注册全部主进程 IPC（唯一入口，由 main/index.ts 在创建窗口前调用）。
 *
 * 按功能域拆到同目录的各模块，每个模块只依赖自己那部分服务，
 * 通道名前缀与模块名一一对应（`terminal:*` → terminal.ts，`ai:*` → ai.ts …），
 * 找通道直接按前缀找文件。新增功能：加一个 `registerXxxIpc` 并在这里挂上。
 *
 * 需要广播事件或读窗口的模块接收 `ctx`，纯请求-响应型的模块不接收任何参数。
 */
export function registerIpc(win: () => BrowserWindow | null): void {
  const ctx = createIpcContext(win)

  // 主机日志最先注册：隧道自启（registerTunnelsIpc 内同步触发）等早期事件也要能推给渲染端
  registerLogsIpc(ctx)
  registerTerminalIpc(ctx)
  // 终端命令历史：纯请求-响应 + 一个 fire-and-forget 的 add，不需要 ctx
  registerHistoryIpc()
  registerMonitorIpc(ctx)
  registerHostsIpc()
  registerScriptsIpc()
  registerNotesIpc(ctx)
  registerApiIpc(ctx)
  registerAiIpc()
  registerAgentIpc(ctx)
  // 客户端工具（渲染端注册、渲染端执行）：broker 广播依赖 ctx
  registerClientToolsIpc(ctx)
  // ask_followup_question 提问卡：两个 AI 界面共用一组通道，得在它们之后注册（共用一个 broker）
  registerFollowupIpc(ctx)
  registerMcpIpc()
  registerSkillsIpc()
  registerSftpIpc(ctx)
  // 远程桌面：本地 RDP 桥（rdp:open / rdp:close）
  registerRdpIpc()
  // SSH 隧道：状态变化经 ctx.broadcast 推给渲染端
  registerTunnelsIpc(ctx)
  registerPluginsIpc()
  registerOpenerIpc()
  registerSystemIpc(ctx)
  registerTransferIpc(ctx)
  registerGitIpc()
  // 自动更新（静默检查在主进程启动后自跑；这里只是给渲染端「查状态 / 手动查 / 装更新」）
  registerUpdaterIpc(ctx)
  // 浏览器会话（Agent 的 browser_* 工具与内嵌面板）：帧 / 状态事件经 ctx.broadcast 推给渲染端
  registerBrowserIpc(ctx)
}
