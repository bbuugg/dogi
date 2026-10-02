import type { EditorView } from '@milkdown/kit/prose/view'
import type { Slice } from '@milkdown/kit/prose/model'

/**
 * 块拖拽的 drop 兜底：把被全局 capture 监听掐断的那条路重新接上。
 *
 * ## 现象
 *
 * 笔记正文左侧的块手柄能显示、能按住、能拖出拖拽影子，但**松手后块纹丝不动**。
 *
 * ## 原因（别只看现象，这里记清链路免得再查一遍）
 *
 * 1. `app/App.tsx` 全应用挂了 `<DndProvider backend={HTML5Backend}>`（侧边栏拖拽排序 / 标签拖拽都要它；
 *    `PanelView` 在每个活动区都渲染，所以没法按活动区把 Provider 收窄，而 react-dnd 又只允许一个 backend）。
 * 2. 该 backend 在 **window 上以 capture 阶段**注册 `handleTopDropCapture`
 *    （`react-dnd-html5-backend/dist/HTML5BackendImpl.js` 的 `addEventListeners`）。
 * 3. Milkdown 的块拖拽会往 dataTransfer 设 `text/html` + `text/plain`，而
 *    `matchNativeItemType` 正是拿这两类判定「native 拖拽」（见 `nativeTypesConfig`：
 *    `text/html` / `text/plain` / `Files` / `text/uri-list`）→ backend 调
 *    `beginDragNativeItem(NativeTypes.TEXT)`，此后整个拖拽期间 `isDraggingNativeItem()` 恒为真。
 * 4. drop 时 `handleTopDropCapture` 因此调 `e.preventDefault()`。
 * 5. prosemirror-view 的输入门第一道就是
 *    `eventBelongsToView()` 里的 `if (event.defaultPrevented) return false`
 *    —— 于是**整个 drop 对 ProseMirror 完全不可见**，`handleDOMEvents.*` 与内置的
 *    `editHandlers.drop` 都不会跑。
 * 6. 真正执行移动的 `prosemirror-drop-indicator` 是靠内置 drop 里的
 *    `view.someProp('handleDrop', ...)` 调用的（见 prosemirror-view 的 `handleDrop`），
 *    内置 drop 没跑 → 它的 `handleDrop` 一次都不会被调用。
 * 7. Milkdown 自己的 `handleDOMEvents.drop`（`BlockService.dropCallback`）只重置
 *    `data-dragging`，不移动块。→ 没有任何代码执行移动。
 *
 * 验证：`scripts/probe-notes-block-drag.mjs`（打印内部状态、调用栈、以及
 * 「drop 上的 preventDefault 来自谁」；修复前 0/10 个落点能移动）。
 *
 * ## 修法（以及两条被否掉的路，都踩过）
 *
 * - ❌ **在 ProseMirror 侧加 `handleDOMEvents.drop` 插件**：无效。它同样要过
 *   `eventBelongsToView()` 那道门，事件已被 preventDefault，门直接关掉（实测插件未被调用）。
 * - ❌ **把这次拖拽的 dataTransfer 换成私有 MIME**，让 react-dnd 认不出来：合成事件的探针
 *   显示可行，但**真实鼠标拖拽会连拖拽本身都起不来**（拖着不动、连拖拽影子都没了）——
 *   改 `dragstart` 阶段的 dataTransfer 会影响 Chromium 的拖拽状态机。**别再走这条路。**
 * - ✅ **在编辑器宿主上补一个原生 `drop` 监听**：prosemirror-view 的输入门只管它自己的
 *   处理器，管不到我们额外挂的 DOM 监听。事件照样会冒泡到这里，于是我们**直接调用
 *   `view.someProp('handleDrop', ...)`** —— 这就是 prosemirror-view 内置 drop 里做的事，
 *   `prosemirror-drop-indicator` 已经实现了（删旧块 + 插新位 + dispatch），**零逻辑复制**，
 *   也**完全不碰 dataTransfer**（真实拖拽管线一点没动）。
 *
 * 幂等的关键在守卫：prosemirror-view 处理完 drop 后会在 `editHandlers.drop` 的 `finally` 里
 * 把 `view.dragging` 置 null；它若因 `defaultPrevented` 被挡在外面，`finally` 也就不会跑，
 * `view.dragging` 会留着。所以**「`view.dragging` 还在」精确等价于「PM 没处理这次 drop」**，
 * 既不会重复移动，也不会在 React-DnD 缺席时抢 PM 的活。
 *
 * ## 什么时候可以删掉这个文件
 *
 * 若把侧边栏拖拽换成不带 window 级 capture 监听的实现（自定义 pointer 后端），
 * 或上游修掉「native 拖拽也 preventDefault drop」，这里就成了多余的，届时直接删掉。
 * 没有其它代码依赖它。
 */

/** 取当前 ProseMirror view 的取值器（编辑器可能重建，所以每次都要现取） */
export type ViewGetter = () => EditorView | null

/**
 * 装上兜底，返回卸载函数。
 *
 * @param host 编辑器宿主（`.notes-milkdown` 那层）。**必须是 `.ProseMirror` 的祖先** ——
 *   冒泡顺序要排在 prosemirror-view 自己的处理器之后，才能靠 `view.dragging` 判出
 *   「PM 有没有处理过」。
 */
export function installBlockDragDropFallback(host: HTMLElement, getView: ViewGetter): () => void {
  const onDrop = (event: DragEvent): void => {
    const view = getView()
    if (!view) return
    // view.dragging 还在 = prosemirror-view 被 defaultPrevented 挡掉了这次 drop（见文件头说明）
    const dragging = view.dragging as { slice: Slice; move: boolean } | null
    if (!dragging?.slice) return
    // 复用插件自己的 handleDrop；它返回 false 说明它也没接（例如落点算在被拖块自己范围内），
    // 这时保持原样即可 —— 没有别的路径会处理
    view.someProp('handleDrop', (handleDrop) =>
      handleDrop(view, event, dragging.slice, dragging.move)
    )
  }
  host.addEventListener('drop', onDrop)
  return () => host.removeEventListener('drop', onDrop)
}
