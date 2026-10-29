/**
 * 系统通知的挂载点：**对话**侧的事件监听。
 *
 * 数据来源是**服务端广播的瞬时事件**（`subscribeServerEvent`）。为什么不用差分：
 * 「等你点头」「跑完了」这两件事发生在**别的会话**时，本标签页往往什么都没收到 ——
 * SSE 只发给发起那一轮的连接。服务端把事件广播给所有连接（见
 * `@fizz/contracts/types` 的 `ServerEvent`），哪一端都在第一时间知道。
 * 顺带不用再处理「首份快照只播种、不发通知」那个坑：事件天然只描述「刚刚发生」，
 * 历史数据不会伪装成新事件。
 *
 * 所以这里**没有新增任何连接、轮询**：都走那条已有的状态 WS。
 */
import { useEffect } from 'react'
import type {
  AgentConfirmRequest,
  AskFollowupRequest,
  ServerEvent
} from '@fizz/contracts/types'
import {
  initStateClient,
  subscribeServerEvent
} from '@fizz/agent-kit/shared/lib/state-ws'
import { initConversationActivity } from '@fizz/agent-kit/shared/lib/conversation-activity'
import { notify, truncateText } from '@fizz/agent-kit/shared/lib/notify'
import { useAppContext } from '@fizz/agent-kit/shared/hooks/use-app-context'

/** 审批请求 → 通知正文：优先给待执行的命令（最需要用户看的），退而给工具名 */
function confirmBody(req: AgentConfirmRequest): string {
  const command = req.command?.trim()
  if (command) return truncateText(command, 60)
  return req.toolName || '需要确认'
}

/** 提问 → 通知正文：第一题的问题文本，没有就退回表单标题 */
function questionBody(req: AskFollowupRequest): string {
  return truncateText(req.questions?.[0]?.question ?? req.title, 60)
}

/** 收尾 → 通知正文：出错给原因、被停给一句话、正常跑完给助手正文摘要 */
function finishedBody(event: Extract<ServerEvent, { type: 'conversation:finished' }>): string {
  if (event.finishReason === 'error') return event.error ? `出错：${event.error}` : '这一轮出错了'
  if (event.finishReason === 'aborted') return '已停止'
  return event.excerpt ?? ''
}

/**
 * 挂上对话的系统通知监听。**不需要返回值**，挂一次即可。
 *
 * 放在外壳里调而不是放进对话 slice：通知要覆盖**整个应用** ——
 * 用户切到设置页时另一条会话跑完了也该收到。
 */
export function useNotifyWatcher(): void {
  /**
   * 点通知要「选中会话」，正好是 `useAppContext()` 的 `openConversation`。
   *
   * 这里不再自己拼 URL：前端路由已移除，点通知与在侧栏点那一行走的是同一条路。
   */
  const { openConversation } = useAppContext()
  /**
   * 当前会话：用来判断「用户是不是正看着出事的那一屏」。
   *
   * ⚠️ 必须在这里（hook 里）取：事件回调可能被 `notify` 内部的异步（desktop 问主进程）
   * 推后执行，那一刻已经不能再调 hook。靠把它放进 effect 依赖，
   * 让订阅回调的闭包每次换会话后都换新值。
   */
  const activeConversationId = useAppContext().app.activeConversationId

  /**
   * 对话侧：直接消费服务端事件。
   *
   * 每条事件 → 至多一条通知（要不要发、走哪条通道由 `notify` 判：总开关关了两边都不发；
   * 否则后台 = 系统通知、前台 = 应用内 toast）。同 tag 互相顶掉，
   * 同一会话连着跑多轮不会在右上角 / 通知中心堆一串。
   */
  useEffect(() => {
    // 运行态（侧栏转圈 / 待办角标）与通知读的是同一条事件流，在这儿一并绑定
    initStateClient()
    initConversationActivity()
    return subscribeServerEvent((event) => {
      // 容器型项目的「文件变了」不属于会话活动（没有 conversationId / title），
      // 由预览面板自己订阅，这里直接跳过；后台任务清单变化同理（会话内的面板自己收）
      if (event.type === 'container:files-changed' || event.type === 'backgroundTasks:changed') return
      const id = event.conversationId
      const title = truncateText(event.title, 40)

      if (event.type === 'conversation:confirm') {
        notify({
          title,
          body: `等待你确认：${confirmBody(event.confirm)}`,
          tag: `conv:${id}:confirm`,
          onClick: () => openConversation(id)
        })
        return
      }
      if (event.type === 'conversation:followup') {
        notify({
          title,
          body: `AI 有一个问题待回答：${questionBody(event.followup)}`,
          tag: `conv:${id}:followup`,
          onClick: () => openConversation(id)
        })
        return
      }
      if (event.type === 'conversation:finished') {
        notify({
          title,
          body: finishedBody(event),
          // 同一会话连续跑多轮时顶掉上一轮，不堆叠
          tag: `conv:${id}`,
          /**
           * 用户就停在这个会话里看着它跑完：结果已经在眼前，右上角不必再飘一条。
           * 「停在这个会话里」= 在对话视图 + 当前会话就是它（原来比的是 URL）。
           * 只是「前台」这一半 —— 窗口在后台时 `notify` 会忽略它、照发系统通知
           * （人都看不到那一屏了，不叫回来才是丢事件）。
           */
          alreadyInView: activeConversationId === id,
          onClick: () => openConversation(id)
        })
      }
    })
  }, [openConversation, activeConversationId])
}
