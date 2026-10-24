/**
 * 「在文件面板里打开某个文件」的跨组件请求。
 *
 * ## 为什么需要它（两个方案都不行的理由）
 *
 * - **传 props 不行**：发起方是消息下方的文档入口（在 `ChatPanel` 里），消费方是右侧
 *   面板里的 `FilesPanel`，中间隔着 `ConversationTab` 的面板装配 —— 不是一棵能直接
 *   传回调的子树；
 * - **window 事件不行**：点入口时会先 `showSideTab('files')` 把面板**挂出来**，事件在
 *   FilesPanel 的监听挂上之前就发完了，请求直接丢（面板本来就在时又恰好能用 —— 这类
 *   「有时灵」的 bug 最难查）。
 *
 * 所以需要一个**先存后取**的位置：发起方写进来，FilesPanel 挂载时 / 挂载后读走。
 * 与 `lib/pending-draft.ts` 同一个思路（那边是「新会话挂上来之后自取预填草稿」）。
 *
 * ## 为什么带 workspaceId
 *
 * 各会话各挂一套面板（面板常驻、工作区不中途变），同时活着的可能不止一套。带上归属，
 * 每套面板只认自己那一个工作区的请求 —— 否则点会话 A 的文档，会话 B 的面板也会去开。
 */
import { useSyncExternalStore } from 'react'

export interface OpenFileRequest {
  /** 目标文件所属工作区（`FilesPanel` 只认自己那一个） */
  workspaceId: string
  /** 工作区相对路径（'/' 分隔） */
  path: string
  /** 自增序号：值相同 = 同一条请求（同一个路径连点两次也能再触发一次） */
  nonce: number
}

let current: OpenFileRequest | null = null
let seq = 0
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

/**
 * 请求在（某个工作区的）文件面板里打开一个文件。
 *
 * 面板还没挂出来也没关系 —— 请求留在这里，面板挂上后的第一次渲染就会取走它。
 */
export function requestOpenWorkspaceFile(workspaceId: string, path: string): void {
  if (!workspaceId || !path) return
  current = { workspaceId, path, nonce: ++seq }
  emit()
}

/**
 * 消费掉一条请求（面板处理完立刻调用，否则每次重渲染都会把同一个文件重开一遍）。
 *
 * 按 `nonce` 核对：期间又来了新请求（用户连点两份文档）时不能误清掉新的那条。
 */
export function consumeOpenFileRequest(nonce: number): void {
  if (current?.nonce !== nonce) return
  current = null
  emit()
}

/** 订阅当前待处理的请求（没有则 null）。必须在 React 组件里用。 */
export function useOpenFileRequest(): OpenFileRequest | null {
  return useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange)
      return () => listeners.delete(onChange)
    },
    () => current,
    () => null
  )
}
