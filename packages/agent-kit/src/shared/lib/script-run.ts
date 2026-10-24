"use client";

/**
 * 「运行脚本」对话框的**全局请求**：谁都能发起「跑这个脚本」，弹窗只有一个。
 *
 * ## 为什么要有它（而不是各自持有一份 `open` 状态）
 *
 * 「运行脚本」的入口已经不止一处：脚本清单的卡片、命令面板的二级视图（选中即运行）。
 * 如果每处都自己渲染一个 `RunScriptDialog`，界面上就会同时挂着好几个实例 —— 弹窗是
 * **模态**的，同一时刻只该有一个；而且「打开第二份」的时序（关一个开另一个）在 Radix
 * 那层容易把 body 的 `pointer-events` 收错。
 *
 * 所以这里只存一个**请求**（要不要开 / 预选哪个脚本 / 第几次），由外壳顶层的
 * `ScriptRunHost` 消费，全 App 只有一个对话框实例。
 *
 * ## 与 `tool-tabs` 同一套取舍
 *
 * 模块级单例 + `useSyncExternalStore`，不落盘、不跨窗口 —— 刷新即回关闭态，本来就该如此。
 *
 * ## `seq` 是干什么的
 *
 * 同一个脚本连点两次也得能**重新触发**：只比 `scriptId` 的话第二次值没变，宿主收不到
 * 任何信号（弹窗已经关了、不会再开）。所以每次 `openRunScriptDialog` 都 +1。
 */
import { useSyncExternalStore } from 'react'

export interface RunScriptRequest {
  /** 是否打开 */
  open: boolean
  /** 预选脚本（不传 = 让用户在对话框里自己选） */
  scriptId?: string
  /** 请求序号（每次发起 +1，见文件头） */
  seq: number
}

let state: RunScriptRequest = { open: false, seq: 0 }
const listeners = new Set<() => void>()

function emit(next: RunScriptRequest): void {
  state = next
  for (const listener of listeners) listener()
}

/** 打开「运行脚本」对话框（`scriptId` 传了就把这个脚本预选上） */
export function openRunScriptDialog(scriptId?: string): void {
  emit({ open: true, scriptId, seq: state.seq + 1 })
}

/** 关闭（宿主在 `onOpenChange(false)` 里调） */
export function closeRunScriptDialog(): void {
  if (!state.open) return
  emit({ ...state, open: false })
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function getSnapshot(): RunScriptRequest {
  return state
}

/** 订阅当前请求（`ScriptRunHost` 用） */
export function useRunScriptRequest(): RunScriptRequest {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
