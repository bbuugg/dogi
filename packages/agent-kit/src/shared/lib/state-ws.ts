/**
 * 全局状态推送的**前端客户端**（对应服务端 `server/state-ws.ts`）。
 *
 * 设计：整个应用只开**一条** WebSocket（单例），连上后服务端先推 `init`（全量快照），
 * 之后各域有变更就推 `snapshot`。本模块把快照存在内存 `Map` 里，组件用 `useStateValue`
 * / `subscribe` 取用 —— 彻底取代原来前端 `setInterval` 轮询列表接口。
 *
 * 这条连接同时收第三种帧：`event`（瞬时事件，「刚刚发生了什么」）。快照与事件的分工、
 * 以及为什么要两条腿走路，见 `@fizz/contracts/types` 的 `ServerEvent`。
 *
 * 用法：
 * - 在用到状态数据的 hook 里 `initStateClient()` 一次（幂等，多个 hook 调也只会开一条）；
 * - 列表数据用 `useStateValue('taskTriggers', [])` 直接拿。
 */
import { useEffect, useState } from 'react'
import type { ServerEvent } from '@fizz/contracts/types'
import { openStateSocket, type StateSocket } from '@fizz/agent-client/web-host'

/** 各数据域的最新快照（key → 数据） */
const snapshots = new Map<string, unknown>()
/** key → 订阅者集合（快照更新时通知，触发 React 重渲染） */
const listeners = new Map<string, Set<() => void>>()
/** 瞬时事件订阅者（`event` 帧的消费者；与快照订阅分开，事件处理完就没了） */
const eventListeners = new Set<(event: ServerEvent) => void>()

let socket: StateSocket | null = null
let connecting = false

function emit(key: string): void {
  listeners.get(key)?.forEach((cb) => cb())
}

function emitAll(): void {
  for (const key of snapshots.keys()) emit(key)
}

/** 幂等：整个应用只开一条状态 WS；多个 hook 调也只会建一次 */
export function initStateClient(): void {
  ensureSocket()
}

function ensureSocket(): void {
  if (socket || connecting) return
  connecting = true
  let s: StateSocket
  try {
    s = openStateSocket()
  } catch {
    // 连接信息还没就绪（还在连接页，没填服务端地址 / token）：稍后重试
    connecting = false
    setTimeout(ensureSocket, 2000)
    return
  }
  socket = s
  connecting = false

  s.onMessage((data) => {
    let msg: {
      type?: string
      snapshots?: Record<string, unknown>
      key?: string
      data?: unknown
      event?: ServerEvent
    }
    try {
      msg = JSON.parse(data as string)
    } catch {
      return
    }
    if (msg.type === 'init' && msg.snapshots) {
      for (const [k, v] of Object.entries(msg.snapshots)) snapshots.set(k, v)
      emitAll()
    } else if (msg.type === 'snapshot' && typeof msg.key === 'string') {
      snapshots.set(msg.key, msg.data)
      emit(msg.key)
    } else if (msg.type === 'event' && msg.event) {
      // 瞬时事件：不存快照，直接转给订阅者（谁收到谁处理）
      for (const cb of [...eventListeners]) {
        try {
          cb(msg.event!)
        } catch (err) {
          console.error('[state-ws] 事件订阅者抛错：', err)
        }
      }
    }
  })

  s.onClose(() => {
    // 已经换成新连接了（见 `reconnectStateSocket`）：旧连接的收尾别把新 socket 清掉
    if (socket !== s) return
    socket = null
    // 服务端重启 / 网络抖动：稍后重连（重连后服务端会重新下发 `init` 全量）
    setTimeout(ensureSocket, 1000)
  })
}

/**
 * 强制重连（App 从后台回到前台时用）。
 *
 * 安卓切后台后 WebView 可能被系统冻结，socket 看起来还开着、其实已经收不到东西了；
 * 回到前台时重建一条最省事，连上后服务端会重新下发 `init` 全量快照，界面立刻追上。
 * 没有现存连接就直接建一条。
 */
export function reconnectStateSocket(): void {
  const previous = socket
  if (!previous) {
    ensureSocket()
    return
  }
  socket = null
  previous.close()
  ensureSocket()
}

/** 读某个 key 的当前快照（没有返回 undefined） */
export function getSnapshot<T>(key: string): T | undefined {
  return snapshots.get(key) as T | undefined
}

/** 订阅某个 key 的更新；返回退订函数 */
export function subscribe(key: string, cb: () => void): () => void {
  let set = listeners.get(key)
  if (!set) {
    set = new Set()
    listeners.set(key, set)
  }
  set.add(cb)
  return () => {
    set?.delete(cb)
  }
}

/**
 * 订阅瞬时事件（`{type:'event'}` 帧）；返回退订函数。
 *
 * 与 `subscribe(key, …)` 分开：快照订阅是「这个 key 变了就叫我」，可以反复触发；
 * 事件是**一次性**的 —— 回调里要处理的事做完就完了，别指望它再触发第二次。
 */
export function subscribeServerEvent(cb: (event: ServerEvent) => void): () => void {
  eventListeners.add(cb)
  return () => {
    eventListeners.delete(cb)
  }
}

/**
 * React 版的「取某域最新值」。组件挂载即订阅，快照一变就重渲染；
 * 没连上 / 还没收到时回落到 `fallback`，避免空闪。
 */
export function useStateValue<T>(key: string, fallback: T): T {
  const [value, setValue] = useState<T>(() => getSnapshot<T>(key) ?? fallback)
  useEffect(() => {
    // 确保连接已建（首次订阅即触发）
    ensureSocket()
    setValue(getSnapshot<T>(key) ?? fallback)
    return subscribe(key, () => setValue(getSnapshot<T>(key) ?? fallback))
  }, [key])
  return value
}

/**
 * 读某域最新快照；**这一域还没收到过就是 `undefined`**。
 *
 * 与 `useStateValue` 的唯一区别是没有 `fallback`。要它是因为有些域的「假数据」会**说假话**：
 * `containerProjects` 的兜底是 `{ available: false }`，而 `false` 的语义是「服务端没有可用的
 * docker」—— 刷新页面后、`init` 快照到达前那一两百毫秒，界面就会先闪一句「当前没有可用的
 * docker」再恢复正常（用户报过）。
 *
 * 判据：这个域的值**可以表示坏消息**（能力不可用 / 出错 / 已停止）时用这个 hook，让调用方把
 * 「还不知道」渲染成加载态；只有「空数组就是空」这种中性的域才用 `useStateValue`。
 */
export function useStateSnapshot<T>(key: string): T | undefined {
  const [value, setValue] = useState<T | undefined>(() => getSnapshot<T>(key))
  useEffect(() => {
    ensureSocket()
    setValue(getSnapshot<T>(key))
    return subscribe(key, () => setValue(getSnapshot<T>(key)))
  }, [key])
  return value
}
