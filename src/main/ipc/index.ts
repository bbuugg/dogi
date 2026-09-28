import type { BrowserWindow } from 'electron'
import { registerAgentIpc } from './agent'
import { registerAiIpc } from './ai'
import { registerApiIpc } from './api'
import { registerFollowupIpc } from './ask-followup'
import { registerAutomationIpc } from './automation'
import { registerGitIpc } from './git'
import { registerBrowserIpc } from './browser'
import { registerHostsIpc } from './hosts'
import { registerLogsIpc } from './logs'
import { registerMcpIpc } from './mcp'
import { registerMonitorIpc } from './monitor'
import { registerNotesIpc } from './notes'
import { registerOpenerIpc } from './opener'
import { registerPluginsIpc } from './plugins'
import { registerScriptsIpc } from './scripts'
import { registerSkillsIpc } from './skills'
import { createIpcContext } from './shared'
import { registerSftpIpc } from './sftp'
import { registerSystemIpc } from './system'
import { registerTerminalIpc } from './terminal'
import { registerTransferIpc } from './transfer'
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
  registerMonitorIpc(ctx)
  registerHostsIpc()
  registerScriptsIpc()
  registerNotesIpc(ctx)
  registerAutomationIpc()
  registerApiIpc(ctx)
  registerAiIpc(ctx)
  registerAgentIpc(ctx)
  // ask_followup_question 提问卡：两个 AI 界面共用一组通道，得在它们之后注册（共用一个 broker）
  registerFollowupIpc(ctx)
  registerMcpIpc()
  registerSkillsIpc()
  registerSftpIpc(ctx)
  // SSH 隧道：状态变化经 ctx.broadcast 推给渲染端
  registerTunnelsIpc(ctx)
  registerPluginsIpc()
  registerOpenerIpc()
  registerSystemIpc(ctx)
  registerTransferIpc(ctx)
  registerGitIpc()
  // 浏览器自动化：帧 / 状态 / 录制事件都经 ctx.broadcast 推给渲染端
  registerBrowserIpc(ctx)
}
