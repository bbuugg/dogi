/**
 * 终端工具（客户端执行的那四个）在**消息列表**里的展示口径。
 *
 * ## 为什么单独一个模块
 *
 * 这四件事都不该散落在两处：
 *
 * 1. **工具名清单**：渲染端要认出「这些工具的结果是终端原始文本，不是结构化 JSON」。
 *    清单必须与 `terminal-mcp.ts` 的 `IMPLEMENTATIONS` 一一对应（那边是执行侧的唯一来源）。
 *    ⚠️ 不能直接从 `terminal-mcp.ts` 引 —— 那个模块会 `import` MCP SDK，而本模块被
 *    消息列表（含移动端）引用，把 SDK 拖进那条依赖链纯属白胖。
 * 2. **「没输出」的占位文案**：`terminal-mcp.ts` 回给模型，渲染端要认出来并**不显示**。
 *    两边各写一份字符串必然漂移（改一边忘一边 = 卡片上又冒出那句废话），所以放这里共用。
 *
 * ## 「没有输出就不要显示输出」
 *
 * 工具为了不让模型以为「调用失败了」，什么都不输出时会回一句占位
 * （{@link TERMINAL_NO_OUTPUT} / {@link TERMINAL_EMPTY}）。那是对**模型**说的话，
 * 摆在用户面前就是一句「没有输出」的废话 —— 用户看到的应该是**没有内容区**，
 * 而不是一个写着「没捕获到输出」的框。
 */

/** 终端工具名（与 `terminal-mcp.ts` 的 `IMPLEMENTATIONS` 对应；新增工具时两边都要加） */
const TERMINAL_TOOL_SET = new Set([
  'run_in_terminal',
  'read_terminal_output',
  'send_keys',
  'list_terminal_sessions'
])

/** 是不是终端工具（客户端执行的） */
export function isTerminalTool(name: string | undefined): boolean {
  return !!name && TERMINAL_TOOL_SET.has(name)
}

/** `run_in_terminal` 在等待期内没捕获到输出时的回执（**给模型看的**，不展示给用户） */
export const TERMINAL_NO_OUTPUT =
  '（等待期内没有捕获到新输出；命令可能仍在运行，可稍后用 read_terminal_output 再看）'

/** 终端当前屏幕上什么都没有时的回执（同上，给模型看的） */
export const TERMINAL_EMPTY = '（终端当前没有输出）'

/** `read_terminal_output` 第一阶段超时的抬头（「（等了约 N 秒没有新输出：…）」） */
const WAIT_NOTE = '（等了约'

/** `run_in_terminal` 到 waitMs 上限时的收尾注（「（注：到 waitMs 上限…）」） */
const TIMEOUT_NOTE = '（注：到 waitMs 上限'

/** 整段只有一句占位（命令确实什么都没打印） */
const PLACEHOLDERS = [TERMINAL_NO_OUTPUT, TERMINAL_EMPTY, '（无输出）']

/**
 * 终端工具结果 → 卡片上该显示的那段文本；返回 `null` = **什么都不显示**。
 *
 * 做三件事：
 * 1. 摘掉写给模型的抬头（「等了约 N 秒没有新输出…」），只留它后面那段真实屏幕内容；
 * 2. 摘掉写给模型的收尾注（「到 waitMs 上限…别连续快速调用」—— 对一个人类说这句没有意义）；
 * 3. 整段就是占位 → `null`（内容区干脆不铺）。
 *
 * ⚠️ 刻意**保留**「输出太长被截断」那两条说明：它们在告诉用户「你看到的不是全部」，
 * 是给人看的，摘掉反而让人以为命令只打了这么点东西。
 */
export function terminalOutputForDisplay(raw: string): string | null {
  let text = raw.trim()
  if (!text) return null

  if (text.startsWith(WAIT_NOTE)) {
    // 抬头与屏幕内容之间是空行（见 readTerminalOutput）；没有空行 = 后面什么都没有
    const sep = text.indexOf('\n\n')
    text = sep < 0 ? '' : text.slice(sep + 2).trim()
  }

  const timeoutAt = text.indexOf(TIMEOUT_NOTE)
  if (timeoutAt >= 0) text = text.slice(0, timeoutAt).trim()

  if (!text) return null
  if (PLACEHOLDERS.includes(text)) return null
  return text
}
