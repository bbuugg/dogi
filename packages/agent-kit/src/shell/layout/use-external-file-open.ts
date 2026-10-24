'use client'

/**
 * 把「用本应用打开本机 Markdown」这条链路的**两端**接到应用上。
 *
 * 桌面端主进程负责收集路径（双击关联的 argv / 二实例 / macOS `open-file` / 菜单的
 * `Ctrl+O`），渲染端这边只有两件事：把它变成一条标签，以及把「有几个标签没保存」
 * 回推给主进程（退出拦截要用）。两个 hook 各管一头，`app-shell` 各调一次。
 *
 * 两个 hook 在 web 上都是**空操作**：`AgentHost` 里那几个方法都是可选的，web 端一个都不
 * 实现（浏览器拿不到路径也写不回去）。所以这里不需要任何平台判断 —— 判据就是「方法在不在」。
 */
import { useEffect } from 'react'
import { getAgentHostOrNull } from '@fizz/agent-client/host'
import { openLocalFileTab } from '@fizz/agent-kit/shared/lib/tool-tabs'
import { useDirtyTabCount } from '@fizz/agent-kit/shared/lib/dirty-tabs'

/**
 * 接管「系统要求用本应用打开某个文件」的事件。
 *
 * ## 顺序：**先订阅，再取存量**
 *
 * 反过来的话，订阅挂上之前到达的那个事件会两头都漏（`take` 已经取过了，广播又没人在听），
 * 文件就被静默丢掉。先订阅的代价是「订阅与 take 之间到达的事件会被处理两次」——
 * 而 `openLocalFileTab` 本身按路径去重（同一个文件只会有一条标签），所以重复无害。
 */
export function useExternalFileOpen(): void {
  useEffect(() => {
    const host = getAgentHostOrNull()
    // 宿主不支持 = 没有这条链路（web）。不做任何事，也不报错
    if (!host?.takePendingExternalFiles && !host?.onExternalFileOpen) return

    let cancelled = false
    const open = (path: string): void => {
      if (cancelled || !path) return
      openLocalFileTab({ absPath: path })
    }

    const unsubscribe = host.onExternalFileOpen?.(open)
    void host.takePendingExternalFiles?.().then((paths) => {
      // 卸载之后才回来的批次直接丢掉（React 严格模式下 effect 会跑两遍）
      if (cancelled) return
      for (const path of paths) open(path)
    })

    return () => {
      cancelled = true
      unsubscribe?.()
    }
  }, [])
}

/**
 * 把「改了还没保存」的标签数量推给主进程。
 *
 * 主进程只把它存进一个变量，退出时读它决定要不要拦 —— 所以**退出路径上没有往返**
 * （那时渲染进程已经不保证还在响应，等不到就是永久卡住）。代价是每次脏状态变化多一次
 * IPC，而它只传一个数字。
 */
export function useDirtyTabCountSync(): void {
  const count = useDirtyTabCount()

  useEffect(() => {
    void getAgentHostOrNull()?.setDirtyTabCount?.(count)
  }, [count])
}
