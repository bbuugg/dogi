/**
 * 折叠面板「该渲染哪一份内容」的规则（**纯函数**，jiti 可直跑，零依赖）。
 *
 * ## 解决的观感问题
 *
 * 工具卡（`PartView` 的 ToolCallCard）在入参收口那一刻会发生两件事，而且**在同一个
 * commit 里**：
 *
 * 1. 内容从「入参流式预览」换成「直显内容」—— edit_file 是 diff、execute_command 是结果文本；
 * 2. `defaultOpen` 从 true 变成 undefined → 卡片自动收起。
 *
 * 而 `ToolContent`（ai-elements）带 `data-[state=closed]:animate-out slide-out-to-top-2`，
 * 收起有 ~150ms 的滑动淡出。两个变化挤在同一帧，那 150ms 里屏幕上渲染的就是**新内容** ——
 * 用户看到「内容先变成 diff，然后才折叠」，中间闪一下（用户报的）。
 *
 * ## 规则
 *
 * - **开着**：永远渲染最新的（用户要看实时内容）；
 * - **关着 / 正在关**：渲染「**上次开着时**」留存的那份快照。
 *
 * 关着的时候内容会被 Radix 卸掉（`CollapsibleContent` 没有 forceMount），所以快照旧一
 * 点**看不见**；等用户再点开，走的是「开着」这条，拿到的又是最新的。
 * 于是折叠动画里放着的是旧内容，观感变成「先折叠、再换状态」。
 *
 * ⚠️ 这能成立的前提是 **`open` 与内容同帧翻转**。ToolCallCard 里那份 `open` 是用
 * 「渲染期同步 state」的写法跟着 `defaultOpen` 走的（不是 useEffect）—— effect 要等
 * commit 之后才跑，中间会多出一帧「还开着 + 已是新内容」，快照就会被污染。
 */

/**
 * 折叠动画期间该渲染的内容。
 *
 * @param open 当前是否展开
 * @param body 最新的内容（children）
 * @param openSnapshot 「上次展开时」留存的内容
 */
export function collapsedBody<T>(open: boolean, body: T, openSnapshot: T): T {
  return open ? body : openSnapshot
}

/**
 * 快照该不该跟着新内容更新：**只有展开时才更新**。
 *
 * 关着时也更新它，就等于把这个规则作废了（折叠那一瞬间渲染的会是新内容）。
 * 单独拎出来是为了让调用方那行 `if` 有名字、也让单测能单独钉这一条。
 */
export function shouldRefreshSnapshot(open: boolean): boolean {
  return open
}
