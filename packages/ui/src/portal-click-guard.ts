/**
 * 浮层里的点击**不要冒到挂载它的那一行**上。
 *
 * ## 为什么会冒上去
 *
 * Radix 的菜单内容（`DropdownMenuContent` / `ContextMenuContent` / `Select` 等）都渲染在
 * `Portal` 里，DOM 上跑到 `document.body` 下面。但 React 的事件系统是按 **React 树**冒泡的，
 * 不是按 DOM 树 —— 所以菜单项的 click 会一路冒到当初渲染这个菜单的那个组件里，
 * 也就是「挂着菜单的那一行」的 `onClick`。
 *
 * 症状（用户报的）：在侧栏某个工作区行点「更多」→ 点菜单里任何一项 → **行自己的 onClick
 * 先跑**（切工作区 + 打开「创建新任务」页），然后才轮到菜单项的动作。看起来像「点击被透传了」。
 * 同类问题也在右键菜单上：脚本卡片的 `onClick` 会打开编辑框，右键菜单里点「移出分组」
 * 会连带把编辑框也打开。
 *
 * ## 为什么在浮层根部拦
 *
 * 行是业务方写的 `onClick`，让它逐个去判断「这次点击是不是来自菜单」既琐碎又会漏（新加一行
 * 就忘一次）。菜单自己最清楚「点在我身上了」，所以在浮层根节点上掐断最省事，且对
 * 所有调用方一致 —— 菜单是浮层，它的交互**从来**不该触达底下那一行。
 *
 * 不拦 `pointerdown`：Radix 的选中逻辑走自己的 pointer 序列，这里只处理 click 冒泡
 * （行上的点击处理器也都是 `onClick`）。
 */
import type { SyntheticEvent } from 'react'

export function stopPortalClick(event: SyntheticEvent): void {
  event.stopPropagation()
}
