import { ipcMain } from 'electron'
import { askFollowupBroker } from '../services/ai/ask-followup'
import type { AskFollowupAnswer } from '@shared/types'
import type { IpcContext } from './shared'

/**
 * `ask_followup_question` 提问卡 IPC（Agent 页与终端 AI 助手**共用**一组通道）。
 *
 * 与 `agent:*` / `ai:*` 下的确认卡不同：提问的 broker 是全局单例，
 * 渲染端按 `toolCallId` 把卡片定位到对话流里，不需要按来源区分通道。
 */
export function registerFollowupIpc(ctx: IpcContext): void {
  askFollowupBroker.setSink({
    request: (req) => ctx.broadcast('followup:request', req),
    // 已有结论（用户作答 / 超时 / 中止），渲染端据此移除卡片
    resolved: (payload) => ctx.broadcast('followup:resolved', payload)
  })
  ipcMain.handle(
    'followup:resolve',
    (_e, payload: { id: string; answer: AskFollowupAnswer | null }) =>
      askFollowupBroker.resolve(payload.id, payload.answer)
  )
}
