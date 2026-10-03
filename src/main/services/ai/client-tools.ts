/**
 * 客户端工具（client tools）的**回填通道**：把「模型的工具调用」桥接到渲染端执行。
 *
 * 分工（A 方案，见 AGENTS.md）：
 * - **定义**随 `agent:chat` 请求携带（`req.clientTools`，发起对话的页面决定带哪组），
 *   主进程组装进工具集，模型可见 —— 没有全局注册表；
 * - **权限与确认全在渲染端**：调用经 `clientTools:invoke` 广播回去后，渲染端按
 *   `permissionMode` 自行决定直接执行 / 自己弹卡 / 拒绝（拒绝文案作为**正常工具结果**
 *   回传，不是 tool error），主进程不做任何闸；
 * - **执行**走「挂起 + 广播 + 回填」：本模块把工具 execute 挂起、广播、等
 *   `clientTools:result` 回填 resolve，当前请求的模型循环随即继续 ——
 *   与内置工具「确认卡等用户点按钮」是同一类挂起，历史照常累积。
 *
 * 收尾纪律与 ask-followup 一致：abort / 流结束必须 `cancel(requestId)`，
 * 否则工具 Promise 永不 settle，整轮卡死（agent.ts 的 finally 与 abort 已接）。
 */
import { randomUUID } from 'node:crypto'
import type { ToolRunContext } from './tool-registry'

interface PendingCall {
  requestId: string
  settle: (payload: { ok: boolean; result?: unknown; error?: string }) => void
}

class ClientToolBroker {
  private pending = new Map<string, PendingCall>()
  private broadcast: ((channel: string, payload: unknown) => void) | null = null

  /** 由 ipc 层注入：invoke 事件推给渲染端 */
  setBroadcaster(fn: ((channel: string, payload: unknown) => void) | null): void {
    this.broadcast = fn
  }

  /** 工具执行：挂起并广播给渲染端，等待回填 */
  async invoke(
    name: string,
    input: unknown,
    call: { toolCallId: string },
    ctx: ToolRunContext
  ): Promise<unknown> {
    if (!this.broadcast) throw new Error('客户端工具通道未就绪（渲染端尚未连接）')
    const callId = randomUUID()
    return new Promise((resolve, reject) => {
      const settle = (payload: { ok: boolean; result?: unknown; error?: string }) => {
        if (!this.pending.has(callId)) return
        this.pending.delete(callId)
        if (payload.ok) resolve(payload.result ?? '（无返回值）')
        else reject(new Error(payload.error || '客户端工具执行失败'))
      }
      this.pending.set(callId, { requestId: ctx.requestId, settle })
      this.broadcast!('clientTools:invoke', {
        callId,
        name,
        input: input ?? null,
        requestId: ctx.requestId,
        conversationId: ctx.conversationId,
        scope: ctx.scope,
        workspaceId: ctx.workspace?.id,
        targetSessionId: ctx.targetSessionId ?? undefined
      })
    })
  }

  /** 渲染端回填结果（ipc 层转发）。拒绝也是 ok=true + 文案（正常工具结果），别用 ok=false 表达拒绝 */
  resolve(payload: { callId: string; ok: boolean; result?: unknown; error?: string }): void {
    this.pending.get(payload.callId)?.settle(payload)
  }

  /** 中止 / 流结束兜底：该请求下所有挂起调用按失败收场（与 askFollowupBroker.cancel 同纪律） */
  cancel(requestId: string): void {
    for (const entry of [...this.pending.values()]) {
      if (entry.requestId !== requestId) continue
      entry.settle({ ok: false, error: '对话已结束，客户端工具调用被取消' })
    }
  }

  /** 全局兜底（应用退出等） */
  cancelAll(): void {
    for (const entry of [...this.pending.values()]) {
      entry.settle({ ok: false, error: '客户端工具调用被取消' })
    }
  }
}

export const clientToolBroker = new ClientToolBroker()
