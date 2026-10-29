/**
 * 会话运行态：**服务端事件驱动**的「谁在跑 / 谁在等我点头」。
 *
 * ## 为什么单独一个模块，而不是塞进对话 slice
 *
 * 对话 slice（`lib/stores/slices/conversation.ts`）里的 `runningConversations` /
 * `pendingConfirms` 是**本标签页的现场**：只有这条 SSE 连接的拥有者才会写它们。
 * 而「有个会话在等你点头」这件事对**每一端**都成立 —— 用户切到别的会话、开第二个标签页、
 * 停在设置页，回来时侧栏上那个会话都该有标记。所以这份状态是全局的、由服务端广播的
 * （`ServerEvent`，见 `@fizz/contracts/types`），放在自己的小模块里，
 * 不去搅动对话 slice。
 *
 * ## 两条腿走路：事件 + 快照
 *
 * - **事件**（`subscribeServerEvent`）管「立刻反应」：这一轮刚开始就亮起转圈，
 *   刚有人点确认就弹通知；
 * - **`activeRuns` 快照**（`subscribe('activeRuns')`）管「最终对得上」：事件是瞬时的，
 *   断线期间会丢（而且服务端重启后 run 本身就没了）。快照是权威现状，每次到达都拿它
 *   把「谁在跑」对齐 —— 所以这儿的状态不会因为漏了一条事件就永久错下去。
 *
 * 渲染层的用法见 `useConversationActivity`。
 */
import { useSyncExternalStore } from 'react'
import type { ChatRunSummary } from '@fizz/contracts/agent-api'
import type { ServerEvent } from '@fizz/contracts/types'
import { getSnapshot, initStateClient, subscribe, subscribeServerEvent } from '@fizz/agent-kit/shared/lib/state-ws'

/** 一个会话正在等用户做的事 */
export interface ConversationWaiting {
  /** `confirm` = 等你批准一次操作；`followup` = agent 在问你一个问题 */
  kind: 'confirm' | 'followup'
  /** 一句话说明在等什么（命令 / 工具名 / 问题文本），给角标的 tooltip 用 */
  label: string
  /** 到达时刻 */
  at: number
}

/** 一个会话此刻的运行态 */
export interface ConversationActivity {
  /** 有一轮对话正在跑（服务端口径，与「当前打开哪个会话」无关） */
  running: boolean
  /** 正在等用户回应（等的同时 `running` 必然为 true） */
  waiting: ConversationWaiting | null
  /** 正在跑的是哪一轮（跨轮并发/连发时用来识别过期事件，见 `applyEvent`） */
  requestId?: string
}

/** 空态的**冻结常量**：直接返回它，React 不会因为「每次渲染新对象」而白渲染一整轮 */
const IDLE: ConversationActivity = Object.freeze({ running: false, waiting: null })

/**
 * 已发布的快照。**写时复制**：内容一变就整表换新引用再通知订阅者。
 *
 * ⚠️ 不能原地改内容不换引用 —— `useSyncExternalStore` 用 `Object.is` 比较快照，
 * 引用相同它就认为「没变」，订阅组件（侧栏）一次都不会重渲染（实测踩过：
 * 事件明明到了、表也更新了，转圈却永远不变成盾牌）。
 */
let activities = new Map<string, ConversationActivity>()
const listeners = new Set<() => void>()

function changed(): void {
  for (const listener of listeners) listener()
}

/** 读某个会话的运行态（没有就返回空态） */
export function getActivity(conversationId: string | null | undefined): ConversationActivity {
  if (!conversationId) return IDLE
  return activities.get(conversationId) ?? IDLE
}

/** 读整张表（只给需要自己遍历的调用方；组件用 `useConversationActivity`） */
export function getActivities(): ReadonlyMap<string, ConversationActivity> {
  return activities
}

function subscribeActivity(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** 当前快照：`useSyncExternalStore` 靠引用变化感知「变了没」（见 activities 的说明） */
function getActivityMap(): ReadonlyMap<string, ConversationActivity> {
  return activities
}

/**
 * 组件版：订阅运行态变化，返回**整张表**。
 *
 * 列表渲染时在组件顶层调一次，每行再按 id `getActivity(...)` 取（`getActivity` 返回的
 * 是稳定引用 / 冻结空态，不会让哪一行因为「每次渲染新对象」而白渲染）。
 */
export function useActivities(): ReadonlyMap<string, ConversationActivity> {
  return useSyncExternalStore(subscribeActivity, getActivityMap, getActivityMap)
}

/** 组件版：订阅运行态变化，返回某个会话的当前状态 */
export function useConversationActivity(conversationId: string | null): ConversationActivity {
  useActivities()
  return getActivity(conversationId)
}

// ---------------------------------------------------------------------------
// 事件 → 运行态
// ---------------------------------------------------------------------------

/**
 * 这条事件是不是**已经过期**（会话在跑新一轮了）。
 *
 * 同一会话可以连着跑：上一轮的 `finished` 事件与下一轮的 `started` 几乎同时到达，
 * 谁先到不确定。按 requestId 判一下，迟到的旧事件就不会把新一轮的转圈擦掉。
 */
function stale(entry: ConversationActivity | undefined, requestId: string): boolean {
  return !!entry?.requestId && entry.requestId !== requestId
}

/** 审批 / 提问的一句话摘要（角标 tooltip 与通知正文共用一份口径） */
function waitingOf(
  event: Extract<ServerEvent, { type: 'conversation:confirm' } | { type: 'conversation:followup' }>
): ConversationWaiting {
  if (event.type === 'conversation:confirm') {
    const command = event.confirm.command?.trim()
    return {
      kind: 'confirm',
      label: command || event.confirm.toolName || '需要确认',
      at: Date.now()
    }
  }
  return {
    kind: 'followup',
    label:
      event.followup.questions?.[0]?.question ??
      event.followup.title ??
      '有一个问题待回答',
    at: Date.now()
  }
}

function applyEvent(event: ServerEvent): void {
  // 容器型项目的「文件变了」与会话运行态无关（没有 conversationId），不进活动表；
  // 后台任务清单变化同理（它由会话内的任务面板自己订阅，不影响侧栏转圈）
  if (event.type === 'container:files-changed' || event.type === 'backgroundTasks:changed') return
  const id = event.conversationId
  const entry = activities.get(id)
  /** 只在真动了的时候才通知订阅者：过期 / 无关的事件不该引起一整轮重渲染 */
  let touched = false

  switch (event.type) {
    case 'conversation:started':
      activities.set(id, { running: true, waiting: null, requestId: event.requestId })
      touched = true
      break
    case 'conversation:finished':
      // 不在表里 = 本来就没在跑（这轮是别的连接起的、自己没看到 started）：无事可做；
      // 表里有但 requestId 不是这一轮 = 同一会话已经跑起新一轮了，别把它的转圈擦掉
      if (entry && !stale(entry, event.requestId)) {
        activities.delete(id)
        touched = true
      }
      break
    case 'conversation:confirm':
    case 'conversation:followup':
      if (!stale(entry, event.requestId)) {
        activities.set(id, {
          running: true,
          waiting: waitingOf(event),
          requestId: event.requestId
        })
        touched = true
      }
      break
    case 'conversation:confirm-resolved':
    case 'conversation:followup-resolved':
      if (entry && entry.waiting && !stale(entry, event.requestId)) {
        activities.set(id, { ...entry, waiting: null })
        touched = true
      }
      break
    default:
      return
  }
  if (touched) {
    // 写时复制发布：先换新引用再通知，订阅组件才能感知到（见 activities 的说明）
    activities = new Map(activities)
    changed()
  }
}

/**
 * 拿 `activeRuns` 快照对账：让「谁在跑」与权威现状一致。
 *
 * 只动 `running` / `requestId`，**不碰 `waiting`** —— 待办状态来自事件，快照里查不到
 * （一轮跑着的时候它既可能没待办、也可能正卡在一次审批上）。对账后残留的待办会在
 * `conversation:finished` / `*-resolved` 到来时清掉；真出现「快照说没在跑、却留着待办」
 * 的窗口（轮次刚结束、事件还没到），下一次对账就会因为条目被删而一并清掉。
 */
function reconcile(runs: ChatRunSummary[]): void {
  const alive = new Map(runs.map((run) => [run.conversationId, run.requestId]))
  let touched = false

  for (const [id, entry] of [...activities]) {
    if (entry.requestId && !alive.has(id)) {
      activities.delete(id)
      touched = true
    }
  }
  for (const [id, requestId] of alive) {
    const entry = activities.get(id)
    if (!entry) {
      // 这一轮是本连接连上之前就开跑的（刷新 / 换标签页）：补一条「在跑」的记录，
      // 侧栏立刻有转圈；要看正文由对话 slice 自己 attach 那条 run
      activities.set(id, { running: true, waiting: null, requestId })
      touched = true
    } else if (entry.requestId !== requestId) {
      activities.set(id, { ...entry, running: true, requestId })
      touched = true
    }
  }
  if (touched) {
    // 同上：写时复制发布（对账也会增删条目）
    activities = new Map(activities)
    changed()
  }
}

// ---------------------------------------------------------------------------
// 绑定（幂等）
// ---------------------------------------------------------------------------

let bound = false

/**
 * 订阅服务端事件与 `activeRuns` 快照。**幂等**，多处调只建一次；
 * 退订交给页面卸载（这份状态本来就是整应用共享的单例）。
 */
export function initConversationActivity(): void {
  if (bound) return
  bound = true
  initStateClient()
  subscribeServerEvent(applyEvent)
  subscribe('activeRuns', () => reconcile(getSnapshot<ChatRunSummary[]>('activeRuns') ?? []))
}