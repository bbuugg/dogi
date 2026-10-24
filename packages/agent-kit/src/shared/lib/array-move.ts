/**
 * 数组内移动一项（`from` → `to`，原地不改）。
 *
 * 项目里原本只有 `ChatPanel` 的拖拽排序需要它，那处是自己写的两行；现在面板的组内重排
 * （`panel-groups.ts` 的 `reorderInGroup`）也要用，抽到这里避免第三份实现。
 *
 * 越界 / 同一个位置一律返回**原数组引用**：调用方靠引用相等来判断「这次操作没改变结构」，
 * 从而不制造多余的新状态 —— 没有这条，每次 `dragover` 都会让整块面板重渲染一遍。
 */
export function arrayMove<T>(items: readonly T[], from: number, to: number): T[] {
  if (from === to) return items as T[]
  if (from < 0 || from >= items.length) return items as T[]
  const target = Math.max(0, Math.min(items.length - 1, to))
  if (target === from) return items as T[]
  const next = items.slice()
  const [moved] = next.splice(from, 1)
  next.splice(target, 0, moved)
  return next
}
