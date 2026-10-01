/**
 * 文件类工具（write_file / edit_file / delete_file）的「改动前 → 改动后」对比数据。
 *
 * 数据来源是**工具入参**，不是工具结果：
 * - 入参里本来就有 edit_file 的 oldString/newString（旧会话历史是 edits[]）、write_file 的完整新内容，足够还原对比；
 * - 把 diff 塞进工具结果会连同「送回模型」的那一份一起变大 —— 每改一次文件就给模型灌一遍
 *   整文件内容，上下文白烧（FileDiffView 的文件头注释也记着这条）。
 *
 * 与源代码管理面板的区别：这里是**片段级**对比（没有文件行号起点），所以 hunks 不带
 * oldStart / newStart，由 FileDiffView 从 1 开始连续编号。
 */
import { diffLines, type DiffHunk } from '@/shared/lib/diff'

/** 会改文件、因而值得直接给 diff 的工具 */
export const FILE_WRITE_TOOLS = new Set(['write_file', 'edit_file', 'delete_file'])

export interface ToolFileDiff {
  path: string
  hunks: DiffHunk[]
  /** delete_file：入参里没有内容，只能提示删了哪个文件 */
  deleted?: boolean
}

/** 从工具入参还原出可渲染的 diff；不是文件类工具（或入参不完整）时返回 null */
export function buildFileDiff(toolName: string, input: unknown): ToolFileDiff | null {
  if (!FILE_WRITE_TOOLS.has(toolName)) return null
  if (!input || typeof input !== 'object') return null
  const obj = input as Record<string, unknown>
  const path = typeof obj.path === 'string' ? obj.path : ''
  if (!path) return null

  if (toolName === 'delete_file') return { path, hunks: [], deleted: true }

  if (toolName === 'write_file') {
    const content = typeof obj.content === 'string' ? obj.content : null
    if (content === null) return null
    // 整文件当作「空 → 全文」的全量新增：新建文件是准确的；**覆盖写入**时入参里没有旧内容，
    // 只能这样呈现（要精确就得让主进程把改动前的原文一并上报，见文件头注释）
    return { path, hunks: [{ lines: diffLines('', content) }] }
  }

  // edit_file：优先读新版单处替换入参（oldString/newString）；旧会话历史里存的还是
  // edits[] 数组 —— 两种形态都要能渲染，否则老消息的 diff 直接消失
  const oldString = typeof obj.oldString === 'string' ? obj.oldString : null
  const newString = typeof obj.newString === 'string' ? obj.newString : null
  if (oldString !== null && newString !== null) {
    return { path, hunks: [{ lines: diffLines(oldString, newString) }] }
  }
  // 旧形态：每处替换一个 hunk；多处替换时给个小标题，1 处时不加（省一行噪音）
  const edits = Array.isArray(obj.edits) ? obj.edits : []
  const hunks: DiffHunk[] = []
  for (const raw of edits) {
    const edit = (raw ?? {}) as { oldText?: unknown; newText?: unknown }
    if (typeof edit.oldText !== 'string' || typeof edit.newText !== 'string') continue
    hunks.push({
      ...(edits.length > 1 ? { header: `第 ${hunks.length + 1} 处替换` } : {}),
      lines: diffLines(edit.oldText, edit.newText)
    })
  }
  return hunks.length ? { path, hunks } : null
}
