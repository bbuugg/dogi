'use client'

/**
 * 「查看子任务过程」的打开通道。
 *
 * 为什么单独一个叶子文件：提供方是**会话视图的宿主**（`chat-surface.tsx` 的 `ChatSurface`），
 * 消费方是 `PartView.tsx`（派活卡上那颗按钮）。而宿主已经 import 后者（它要渲染消息流），
 * 把 context 放在任何一边都会形成模块环（`chat-surface` → `PartView` → `chat-surface`），
 * 打包顺序一变就可能拿到 undefined。这个文件不依赖任何一方，两边都安全。
 *
 * ## 为什么要带 `toolCallId`
 *
 * 子任务跑着的时候，`delegation` 每一帧都是**新对象**（`parts.ts` 的 applyEvent 会重建它）。
 * 早先这里只传 `delegation` 快照，宿主存下来之后就不再更新 —— 于是运行中打开面板看到的是
 * 「点开那一刻」的过程，后面全是冻住的，只有关掉重开才是新的。
 *
 * 现在宿主只认 `toolCallId`，每次渲染都从当前消息里重新取那份 delegation：流式时期还能看到
 * 它一步步往下走，跑完之后切回来也是同一份（历史里那份随消息落盘）。
 *
 * 没有 Provider 时 hook 返回 `null`：片段渲染里不提供这个交互，按钮干脆不画。
 */
import { createContext, useContext } from 'react'
import type { SubagentDelegation } from '@fizz/contracts/types'

/**
 * 打开某个派活的完整过程。
 *
 * 第一个参数是**派活方那次工具调用**的 id（`part.toolCallId`），宿主拿它在当前消息里
 * 重新定位 `delegation`；`delegation` 只是「万一找不到」的兜底快照。
 */
export type OpenSubagent = (toolCallId: string, delegation: SubagentDelegation) => void

const SubagentViewContext = createContext<OpenSubagent | null>(null)

export const SubagentViewProvider = SubagentViewContext.Provider

/** 取「打开子任务」的回调；不在面板宿主里时是 `null` */
export function useOpenSubagent(): OpenSubagent | null {
  return useContext(SubagentViewContext)
}
