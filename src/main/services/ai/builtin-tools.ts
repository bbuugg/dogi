/**
 * 内置 AI 工具的统一注册入口。
 *
 * 各工具模块只**导出定义**（`AiToolDef[]`），注册集中在这里、只做一次
 * （agentService 初始化时调用；重复调用幂等）。新增内置工具：
 * 在对应模块导出定义，到这里加一行 —— 别在工具模块 import 时偷偷注册，
 * 那会让「谁注册了什么」无从查起。
 */
import { toolRegistry } from './tool-registry'
import { buildTerminalToolDefs } from './terminal-tools'
import { buildWorkspaceToolDefs } from './agent-core/tools'
import { buildReadSkillDef } from './agent-core/skills'
import { buildReadToolOutputDef } from './artifact-tools'
import { buildAskFollowupDef } from './ask-followup'
import { buildBrowserToolDefs } from '../browser/agent'
import { storage } from '../storage'
import type { BrowserChannel } from '@shared/types'

let registered = false

export function ensureBuiltinToolsRegistered(): void {
  if (registered) return
  registered = true
  toolRegistry.registerAll([
    ...buildTerminalToolDefs(),
    ...buildWorkspaceToolDefs(),
    buildReadSkillDef(),
    // 读回被截断的长输出：终端侧与工作区侧共用一个入口（scope: 'both'）
    buildReadToolOutputDef(),
    buildAskFollowupDef(),
    // 浏览器来源偏好用函数注入：注册只发生一次，偏好随时可改、执行时现取
    //（browser/agent.ts 保持与 Electron 解耦，探针可脱离应用单跑）
    ...buildBrowserToolDefs({
      channel: () => (storage.getPreferences().browserChannel ?? 'auto') as BrowserChannel
    })
  ])
}
