/**
 * 定时任务的领域层：只做「什么时候自动起一个会话」的规则存储，不碰调度与执行。
 *
 * 与 `AgentDomain` **分开**：定时任务与「工作区 / 会话 / 模型」在概念上并列，
 * 混在一起会让那个文件继续膨胀。两者共用同一个 `JsonStore`。
 *
 * 真正的调度在 `apps/server/src/server/scheduler.ts`（进程内 cron / 定时器），
 * 派发后走普通会话链路（chat-turn），**不起容器**。
 */
import type { TaskTrigger } from '@fizz/contracts/types'
import { JsonStore } from './store'

export class TriggerDomain {
  constructor(private readonly store: JsonStore) {}

  listTriggers(workspaceId?: string): TaskTrigger[] {
    const all = this.store.snapshot().taskTriggers
    return (workspaceId ? all.filter((t) => t.workspaceId === workspaceId) : all).slice()
  }

  getTrigger(id: string): TaskTrigger | undefined {
    return this.store.snapshot().taskTriggers.find((t) => t.id === id)
  }

  saveTrigger(trigger: TaskTrigger): TaskTrigger {
    this.store.mutate((d) => {
      const index = d.taskTriggers.findIndex((t) => t.id === trigger.id)
      if (index >= 0) d.taskTriggers[index] = trigger
      else d.taskTriggers.push(trigger)
    })
    return trigger
  }

  /** 队列 worker 每次触发后调用一次；与 delete 并发时以快照为准，不抛 —— 调用方只需知道没触发成 */
  markTriggered(id: string, conversationId: string): void {
    this.store.mutate((d) => {
      const target = d.taskTriggers.find((t) => t.id === id)
      if (!target) return
      target.lastTriggeredAt = Date.now()
      target.lastConversationId = conversationId
      /**
       * 历史会话 id：**最新在前**（管理页直接按这个顺序列，不用再排），去重但**不截断**。
       *
       * 去重是防御性的：同一条任务不可能两次落同一个 id，但老数据 / 手工改库可能带重复，
       * 重复会让列表里出现两行指向同一个会话。
       */
      const prev = target.conversationIds ?? []
      target.conversationIds = [
        conversationId,
        ...prev.filter((x) => x !== conversationId)
      ]
      // 一次性触发（at）跑过就自己关掉，避免同一条规则反复起会话
      if (target.at !== undefined) target.enabled = false
    })
  }

  deleteTrigger(id: string): void {
    this.store.mutate((d) => {
      d.taskTriggers = d.taskTriggers.filter((t) => t.id !== id)
    })
  }
}
