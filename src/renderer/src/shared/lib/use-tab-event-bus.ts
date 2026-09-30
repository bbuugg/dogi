import { useEffect, useRef } from 'react'
import { getTabBus } from './tab-event-bus'

/**
 * 把页面组件的「关闭拦截」handler 注册到所在标签的共享 `TabEventBus` 上。
 *
 * 各放入 PanelView 的页面组件（NotesPage / AgentPage / …）调用此 hook；
 * 关闭入口 `requestClosePanelTab` 等推来的 `close-request` 事件会依次经过
 * 这里注册的 handler —— 页面在 handler 内部完成状态确认（如未保存改动 →
 * 在标签面板内弹确认），返回 `false`（或 `Promise<false>`）表示「阻止关闭」；
 * 全部放行时总线 emit `close`，经 `setTabCloseExecutor` 注入的回调真正关闭。
 *
 * @param tabId      当前标签 id（`PanelTab.id`）
 * @param closeGuard 关闭拦截函数：返回 false 阻止关闭，不传或返回 true 放行。可以是 async。
 *
 * @example
 * ```tsx
 * export function MyPage({ tabId }: { tabId: string }) {
 *   const [dirty, setDirty] = useState(false)
 *   useTabEventBus(tabId, async () => {
 *     if (!dirty) return true
 *     return confirmInTabSomehow() // 在标签内部完成确认
 *   })
 * }
 * ```
 */
export function useTabEventBus(
  tabId: string | undefined,
  closeGuard?: () => boolean | Promise<boolean>
): void {
  // guard 存 ref，避免调用方内联函数每次渲染变引用导致 effect 反复注册/注销
  const guardRef = useRef(closeGuard)
  guardRef.current = closeGuard

  useEffect(() => {
    if (!tabId || !guardRef.current) return
    // 总线由 TabContentGuard（所有者）负责创建与释放；这里 getOrCreate 是为了
    // 子组件 effect 先于父组件跑时也能拿到同一条总线
    const bus = getTabBus(tabId)
    const handler = async () => {
      const fn = guardRef.current
      if (!fn) return true
      try {
        return await fn()
      } catch {
        return true
      }
    }
    return bus.on('close-request', handler)
    // 只在 tabId 变化时重注册；guard 函数引用变化不触发（走 ref）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId])
}
