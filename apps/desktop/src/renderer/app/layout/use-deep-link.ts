'use client'

/**
 * 接住「从浮窗跳过来」的会话深链（浮窗右上角「在主窗口打开」）。
 *
 * 与 `use-external-file-open` 同一个套路：主进程负责**存**（主窗口可能还没起来 / 正在加载），
 * 这里负责**取 + 订**。区别只有一处：存量是**同步**取的（`takePendingDeepLink`）——
 * 首帧就要把标签摆对，异步的话必然先显示上一个会话再跳过去，用户看到的是「闪一下」。
 *
 * ## 为什么打开动作是「写 store + 直接开标签」而不是 `openConversation`
 *
 * `AppProvider` 的 `openConversation` 还顺带切视图、处理占位标签，那是「用户点侧栏」的语义。
 * 深链只要求「主窗口显示这个会话」，`main.tsx` 里首帧那次更是发生在 Provider 之外（还没挂载）。
 * 所以两条路都只做最小两件事：把活跃会话写成它、把它的标签打开并激活 —— `PanelView`
 * 那条同步 effect 认的就是 `activeConversationId` 的变化，视图会自己跟过去。
 */
import { useEffect, useRef } from 'react'
import { getAgentHostOrNull } from '@fizz/agent-client/host'
import { useAgentStore } from '@fizz/agent-kit/shared/lib/stores/agent-store'
import { openTab } from '@fizz/agent-kit/shared/lib/panel-store'

/**
 * 打开一条深链（主窗口渲染端专用）。
 *
 * 不校验会话是否存在：主进程已经把 id 交出来了，此时列表可能还没拉回来；`PanelView`
 * 会按 `activeConversationId` 渲染，列表到了自然对上。
 */
export function openDeepLink(conversationId: string): void {
  if (!conversationId) return
  useAgentStore.getState().openConversation(conversationId)
  openTab(conversationId)
}

/**
 * 主窗口：订阅后续深链，并把挂载前到达的那条补上。
 *
 * `main.tsx` 在渲染前已经同步取过一次（首帧不闪），所以这里取到的一般是 null ——
 * 除非那次之后、挂载之前又来了新的（例如用户在浮窗连点两下），补上就对了。
 */
export function useDeepLink(): void {
  // effect 只挂一次，但取存量的时机要跟着「本次挂载」—— ref 里放的只是一次性标记
  const mounted = useRef(false)

  useEffect(() => {
    const host = getAgentHostOrNull()
    // 宿主不支持 = 没有多窗口（web）。不做任何事，也不报错
    if (!host?.onDeepLink && !host?.takePendingDeepLink) return

    mounted.current = true
    const pending = host.takePendingDeepLink?.()
    if (pending) openDeepLink(pending)
    const unsubscribe = host.onDeepLink?.(openDeepLink)

    return () => {
      mounted.current = false
      unsubscribe?.()
    }
  }, [])
}
