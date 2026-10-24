/**
 * confirm 模式审批的等待体工厂:聊天(`chat-turn.ts`)与项目管理助手(`assistant-turn.ts`)
 * 共用同一套「confirm 帧 → 挂起等答复 → confirm-resolved 帧」的机制,保证两边在界面上的
 * 审批卡行为完全一致。挂起的审批全部进 `state.ts` 的 `pendingConfirms`(共享注册表),
 * 所以答复端点(POST /api/chat/confirm)与断线接回(GET /api/chat/stream?requestId=)
 * 对两个使用方都天然可用 —— 不需要助手专用的端点。
 *
 * 「始终允许 / 始终拒绝」按 `ownerKey`(普通会话 = conversationId,助手 = 助手会话 id)隔离:
 * - **始终允许**的键是**那行命令本身**(审批卡上显示的原文,精确匹配 —— 换个参数就重新问)。
 *   传了 `approvedCommandsPath`(工作区根目录)时落盘到 `<工作区>/.fizz/workspace.json`
 *   的 `approvedCommands`,跟着项目走、跨会话共享,且每次审批前**现读盘** —— 手改这份
 *   文件删掉某条,下一次调用立刻恢复询问。落盘失败退回内存,重启清零是安全侧的失效。
 * - **始终拒绝**一律只记内存(同样按命令),重启清零 —— 拒绝被遗忘只是多问一次,安全。
 */
import { randomUUID } from 'node:crypto'
import type {
  AgentConfirmInput,
  AgentConfirmOption,
  AgentConfirmRequest,
  ServerEvent
} from '@fizz/contracts/types'
import { appLog } from '@fizz/workspace'
import { emit, type ChatRun } from './chat-run'
import { pendingConfirms } from './state'
import { approvedCommandsOf, rememberApprovedCommand } from './services/workspace-config'

/** confirm 模式审批的缺省超时(没人答复时按拒绝收场;0 = 不超时) */
export const DEFAULT_CONFIRM_TIMEOUT_MS = 10 * 60 * 1000

/**
 * 内置工具审批的四个选项:与 ACP 权限选项**同一套 kind**(allow_once / allow_always /
 * reject_once / reject_always),确认卡渲染同一份 UI。语义差异只在「始终」的落地方式:
 * ACP 的 always 由 agent 自己记,内置的 always 由服务端按**命令**记(见文件头)。
 */
export const BUILTIN_CONFIRM_OPTIONS: AgentConfirmOption[] = [
  { optionId: 'allow_once', name: '允许一次', kind: 'allow_once' },
  { optionId: 'allow_always', name: '始终允许此命令', kind: 'allow_always' },
  { optionId: 'reject_once', name: '拒绝一次', kind: 'reject_once' },
  { optionId: 'reject_always', name: '始终拒绝此命令', kind: 'reject_always' }
]

/**
 * 内存记忆:ownerKey → (命令 → 决定)。存「始终拒绝」与**没有落盘目标时**的
 * 「始终允许」(虚拟工作区 / 项目助手);有落盘目标的允许走 workspace.json,
 * 不进这张表 —— 否则手删文件里的条目后,内存里那份还会继续放行。
 */
const confirmMemory = new Map<string, Map<string, boolean>>()

/** 把某条 run 挂着的所有审批按给定结果放行(整轮结束 / 中止时收尾用) */
export function releaseConfirmsFor(requestId: string, approved: boolean): void {
  for (const [id, entry] of [...pendingConfirms]) {
    if (entry.requestId !== requestId) continue
    if (entry.timer) clearTimeout(entry.timer)
    pendingConfirms.delete(id)
    entry.resolve({ approved })
  }
}

export interface ConfirmGate {
  /** 审批的通用等待体:推 confirm 帧 → 挂起等答复(带 optionId,ACP 权限选项用) */
  waitForConfirmReply(req: AgentConfirmInput): Promise<{ approved: boolean; optionId?: string }>
  /** 内置工具的审批:与 ACP 同一套四 kind 选项 + 按命令记的「始终」记忆(见文件头) */
  requestConfirm(req: AgentConfirmInput): Promise<boolean>
  /** 把这条 run 挂着的审批全部按拒绝放行(整轮结束 / 中止时调用,幂等) */
  releaseAll(): void
}

export function createConfirmGate(input: {
  run: ChatRun
  /** 「始终」记忆与事件的归属键:普通会话 = conversationId,助手 = 助手会话 id */
  ownerKey: string
  /** 广播事件里的标题(通知直接用) */
  title: string
  confirmTimeoutMs: number
  /** confirm 请求里展示用的工作区坐标(助手没有,不传) */
  workspace?: { id: string; name: string }
  /**
   * 「始终允许」的落盘目标(**工作区根目录绝对路径**):confirm 档下点「始终允许此命令」
   * 的命令写进 `<工作区>/.fizz/workspace.json` 的 `approvedCommands` —— 跟着项目走、
   * 该项目所有会话共享,每次审批前现读盘(手改文件删条目立即恢复询问)。
   * 不传(虚拟工作区 / 项目助手这类没有项目目录的)= 只记内存,重启清零。
   */
  approvedCommandsPath?: string
  /**
   * 瞬时事件广播:传了就把 conversation:confirm / confirm-resolved 广播给所有连接
   * (别的标签页看不到这条 SSE,只能靠它)。助手没有跨页审批场景,不传。
   */
  broadcast?: (event: ServerEvent) => void
}): ConfirmGate {
  const { run, ownerKey, title, confirmTimeoutMs, broadcast } = input

  const waitForConfirmReply = (
    req: AgentConfirmInput
  ): Promise<{ approved: boolean; optionId?: string }> => {
    const id = randomUUID()
    const confirm: AgentConfirmRequest = {
      id,
      requestId: run.requestId,
      toolCallId: req.toolCallId,
      toolName: req.toolName,
      command: req.command,
      ...(req.agentId ? { agentId: req.agentId } : {}),
      ...(req.agentName ? { agentName: req.agentName } : {}),
      ...(input.workspace ? { workspaceId: input.workspace.id, workspaceName: input.workspace.name } : {}),
      // ACP 权限请求会把 agent 给的选项带上来:原样放进帧,前端照单渲染
      ...(req.options?.length ? { options: req.options } : {})
    }
    emit(run, { type: 'confirm', requestId: run.requestId, confirm })
    if (broadcast) {
      broadcast({
        type: 'conversation:confirm',
        conversationId: ownerKey,
        requestId: run.requestId,
        title,
        confirm
      })
    }
    return new Promise((resolve) => {
      let settled = false
      const settle = (reply: { approved: boolean; optionId?: string }): void => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        pendingConfirms.delete(id)
        emit(run, {
          type: 'confirm-resolved',
          requestId: run.requestId,
          confirmId: id,
          approved: reply.approved
        })
        if (broadcast) {
          broadcast({
            type: 'conversation:confirm-resolved',
            conversationId: ownerKey,
            requestId: run.requestId,
            title,
            confirmId: id,
            approved: reply.approved
          })
        }
        resolve(reply)
      }
      const timer =
        confirmTimeoutMs > 0
          ? setTimeout(() => settle({ approved: false }), confirmTimeoutMs)
          : null
      pendingConfirms.set(id, { requestId: run.requestId, resolve: settle, ...(timer ? { timer } : {}) })
    })
  }

  const requestConfirm = async (req: AgentConfirmInput): Promise<boolean> => {
    /*
     * 记忆键 = **这行命令本身**(审批卡上显示的原文,trim 后精确匹配)。
     * 曾经按工具名记:点一次「始终允许」等于放行该工具的一切调用(execute_command
     * 换成 rm -rf 也不再问),而且没有任何入口能查看 / 收回 —— 用户就是被这个烫到的。
     */
    const command = req.command.trim()
    let decisions = confirmMemory.get(ownerKey)
    if (!decisions) {
      decisions = new Map()
      confirmMemory.set(ownerKey, decisions)
    }
    // 内存里已记住的(始终拒绝 / 无落盘目标的始终允许):直接按记忆走,不再打扰
    const remembered = decisions.get(command)
    if (remembered !== undefined) return remembered
    // 落盘白名单:每次现读(不缓存)—— 手改 workspace.json 删掉某条后,
    // 下一次调用立即恢复询问;读盘失败按空清单(= 多问一次,安全方向)
    if (input.approvedCommandsPath) {
      const allowed = await approvedCommandsOf(input.approvedCommandsPath)
      if (allowed.includes(command)) return true
    }
    const reply = await waitForConfirmReply({ ...req, options: BUILTIN_CONFIRM_OPTIONS })
    const option = BUILTIN_CONFIRM_OPTIONS.find((o) => o.optionId === reply.optionId)
    if (option?.kind === 'allow_always') {
      if (input.approvedCommandsPath) {
        try {
          // 写成功就**不**进内存表:让下一次判定继续走读盘路径,手删文件才能立即生效
          await rememberApprovedCommand(input.approvedCommandsPath, command)
        } catch (err) {
          // 落盘失败(配置损坏 / 目录不可写):退回内存,本会话仍生效,重启后恢复询问
          appLog.warn(
            'chat',
            '「始终允许」写入工作区配置失败，本会话内仍生效（重启后恢复询问）',
            err instanceof Error ? err.message : String(err)
          )
          decisions.set(command, true)
        }
      } else {
        decisions.set(command, true)
      }
    }
    if (option?.kind === 'reject_always') decisions.set(command, false)
    return reply.approved
  }

  return {
    waitForConfirmReply,
    requestConfirm,
    releaseAll: () => releaseConfirmsFor(run.requestId, false)
  }
}
