/**
 * 「最后一行」文本预览（**纯函数**，零 React）。
 *
 * 两处都要「取正文最后一行 + 剥掉 markdown 记号」：
 * - 思考条的触发器（`ai-elements/reasoning.tsx` 的折叠实时预览）；
 * - 过程分组的抬头（`lib/turn-step.ts` 右侧那行内容预览）。
 *
 * 所以实现只能待在 `lib` 这一层：`ai-elements` 已经依赖 `lib`（`parts` / `utils`），
 * 反过来放会成环。`reasoning.tsx` 仍在原处 **re-export**，那边既有的 import 不用动。
 */

/**
 * 思考正文 → 行内预览：**最后一行**的纯文本 + 这一行的行号。
 *
 * **只取最后一行**（最后一个 `\n` 之后那段）—— 一行的高度只放得下一行，与其把整段塞进来
 * 再靠 CSS 截断（那样永远只看得见开头几个字），不如让这一行始终跟着**最新的一行**走。
 *
 * 返回的 `lineKey`（最后一个 `\n` 的下标）是「换行发生了」的判据，交给 `ReasoningPreview`
 * 决定要不要把预览整体上滚一格。⚠️ **不能靠「新文本不是旧文本的前缀」来判换行**：
 * 下面剥 markdown 记号时，`**bo` → `bo` 就不是前缀了，会被误判成换行、凭空滚一下。
 *
 * 顺手去掉的 markdown 记号：预览是纯文本一行，`**粗体**` / `` `代码` `` / `- 列表` 这些
 * 记号留在一行里只是噪点（又要省掉重新解析 markdown 的开销）。
 *
 * ⚠️ 调用方（PartView）必须在**自己知道 open 的时候**调用它、只把切好的一行传进来：
 * 把原始 text 传进来的话，展开状态下每来一个 token 都会改 props，`memo` 的
 * ReasoningTrigger 连同里面的 Shimmer 就跟着重渲染（现在它们在展开时是不重渲染的）。
 */
export function reasoningPreview(text: string): { line: string; lineKey: number } {
  const lineKey = text.lastIndexOf('\n')
  const line = text
    .slice(lineKey + 1)
    // 行首的标题 / 引用 / 列表符号（「-5 是负数」里的「-」后面没空格，不会误伤）
    .replace(/^\s*(?:#{1,6}|>|[-*+]|\d+[.)])\s+/, '')
    .replace(/`([^`]*)`/g, '$1') // 行内代码
    .replace(/\*\*([^*]+)\*\*/g, '$1') // 粗体
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // 链接只留文字
    .replace(/[*_~]+/g, '') // 其余强调 / 删除线记号
    .replace(/\s+/g, ' ')
    .trim()
  return { line, lineKey }
}
