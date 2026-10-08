import { useLayoutEffect, useRef } from 'react'
import { getTabBus, type CloseContext, type CloseDecision } from './tab-event-bus'

/**
 * 把页面组件的「关闭判断」注册到所在标签的总线上 —— **页面主导的关闭确认**。
 *
 * 各放入面板的页面组件（`NotesPage` / `AgentPage` / …）调用此 hook；用户点关闭时
 * 总线会依次 await 每个 guard，页面在 guard 内部完成状态确认（如「有未保存改动 →
 * 在**标签面板内**弹三选一」，用参数里的 `ctx.confirm`），然后返回裁决：
 *
 * - `{ allow: false }`         → 拦下，标签原样留着
 * - `{ allow: true, owned: true }`  → 放行，且**这次确认由本页面负责**（不管有没有弹窗），
 *   shell 不再叠加通用防手滑 —— 笔记 / Agent 这类「自己的状态自己最清楚」的页面应当恒带 `owned`
 * - `{ allow: true }`          → 放行，但没接管确认 → shell 兜底问一句「确定关闭标签？」
 *
 * ⚠️ guard **抛错 = 拦下**（fail closed，见 tab-event-bus 的说明）：这里刻意不 try/catch，
 * 让总线统一处理并回报原因。自己吞掉异常就等于静默放行，那正是要修掉的老毛病。
 *
 * @param tabId 当前标签 id（`PanelTab.id`）
 * @param guard 关闭判断；不传 = 这个页面不接管关闭确认（交给 shell 兜底）
 *
 * @example
 * ```tsx
 * export function MyPage({ tabId }: { tabId: string }) {
 *   const [dirty, setDirty] = useState(false)
 *   useTabCloseGuard(tabId, ({ confirm }) => {
 *     if (!dirty) return { allow: true, owned: true }
 *     return confirm({ title: '未保存', actions: [...] }).then((ok) => ({ allow: ok, owned: true }))
 *   })
 * }
 * ```
 */
export function useTabCloseGuard(
  tabId: string | undefined,
  guard?: (ctx: CloseContext) => CloseDecision | Promise<CloseDecision>
): void {
  // guard 存 ref：调用方多半写内联箭头函数，每次渲染换引用；直接进依赖会反复注销重注册
  const guardRef = useRef(guard)
  // ⚠️ 用 layout effect 同步 ref，而不是在 render 期直接赋值 —— React 19 的并发渲染
  // 下 render 可能被丢弃 / 重放，在 render 里写 ref 是反模式（旧实现就是这么写的）。
  useLayoutEffect(() => {
    guardRef.current = guard
  })

  useLayoutEffect(() => {
    if (!tabId) return
    // 总线由 TabContentGuard（所有者）负责创建与释放；这里 getOrCreate 是为了
    // 子组件 effect 先于父组件跑时也能拿到同一条总线
    return getTabBus(tabId).onGuard((ctx) => {
      const fn = guardRef.current
      // 没注册 guard = 这个页面不接管关闭确认 → 放行且不 owned，交给 shell 兜底
      if (!fn) return { allow: true }
      return fn(ctx)
    })
  }, [tabId])
}
